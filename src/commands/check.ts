import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import {
  hashFile,
  loadState,
  stateExists,
  type FrozenCase,
  type FrozenSnapshot,
  type RatchetState,
} from "../state.js";
import { createReplayConfig, runEval, type CaseResult } from "../promptfoo.js";
import { combinedProbeHash } from "./freeze.js";
import { writeLastEval } from "../lastEval.js";
import { deriveFloor, latestFrozenFor, type FloorResult } from "../floor.js";
import { buildFilterPattern, parseRetry, retryFailedLiveCases } from "../retry.js";

/**
 * check 게이트 — §4/§5 T3. 동결된 계약(floor)이 여전히 통과하는지 검사하고 회귀 시 exit 1.
 *
 * 기본(결정적): activePrompt의 최신 frozen 스냅샷 출력을 replay-provider로 되돌려(C2),
 *   현재 asserts.js를 재적용해 floor를 대조한다 — LLM 비결정성 없이 프로브/프롬프트 드리프트를 잡는다.
 * --live: replay 대신 원본 config(실 프로바이더)로 fresh eval(ISC-3.4).
 *
 * C1 알려진 한계: replay-provider는 promptId를 보지 않고 caseId(description)만으로 출력을 되돌린다
 *   (src/replay-provider.js, T2 소유 — 코드 변경 금지). check는 단일 activePrompt에 바인딩된
 *   frozen 스냅샷들만 replay하므로(모두 같은 promptId) 한 번의 실행에서 프롬프트 차원 혼선이 없다.
 *   (여러 프롬프트를 한 replay에 섞으면 같은 caseId가 프롬프트별로 갈리는데, 그 seam은 T2 소관이다.)
 *
 * round2-B P0 수정: replay 소스를 "최신 단일 스냅샷"이 아니라 "activePrompt 스냅샷들의 합집합"으로
 *   구성한다(케이스별 최신 pass 우선). deriveFloor는 모든 스냅샷 pass 케이스 합집합을 floor로 요구하는데,
 *   최신 스냅샷 하나만 replay하면 이전 스냅샷에만 pass로 존재하는 케이스(부분 동결로 자연 발생)가
 *   replay-map에서 빠져 결정적 check가 구조적으로 항상 반려하던 결함을 없앤다.
 */

interface Divergence {
  caseId: string;
  frozen: FrozenCase;
  replay: CaseResult;
}

/** replay-map 항목: 동결 출력과 그 출력을 낸 출처 스냅샷(케이스별 probeHash 대조·frozen 대조용). */
interface ReplayEntry {
  output: string;
  snapshot: FrozenSnapshot;
}

/** 결정적 check 회귀 사유 분류: assert 실패 / replay 불가(스냅샷 미커버) / 평가 결과 없음. */
type RegressionKind = "assert" | "replay-uncovered" | "no-result";

interface Regression {
  caseId: string;
  reason: string;
  kind: RegressionKind;
}

interface LiveProbe {
  /** 현재 프로브 파일들의 조합 해시(동결 스냅샷 probeHash와 대조) */
  combined: string;
  /** 프로브 파일별 현재 해시 */
  liveHashes: Record<string, string>;
}

interface ProbeReport {
  mismatch: boolean;
  /** 프로브 파일별 드리프트 상세(현재 파일 해시 vs 동결 시점 기록) */
  driftedFiles: string[];
}

/**
 * floor를 덮는 replay-map을 activePrompt 스냅샷 합집합으로 구성한다(round2-B ①).
 * 케이스별로 "그 caseId를 pass:true로 담은 가장 최근 스냅샷"의 출력을 고른다(케이스별 최신 pass 우선).
 * frozen[]는 append 순(과거→최신)이므로 앞에서부터 덮어쓰면 최신 스냅샷이 이전을 이긴다.
 * 반환 맵은 각 케이스의 출처 스냅샷도 담아, probeHash 대조와 frozen score 대조를 스냅샷별로 분리한다.
 */
export function buildReplayMap(
  frozen: FrozenSnapshot[],
  targetPrompt: string,
): Map<string, ReplayEntry> {
  const map = new Map<string, ReplayEntry>();
  for (const snap of frozen) {
    if (snap.promptId !== targetPrompt) continue;
    for (const [caseId, c] of Object.entries(snap.cases)) {
      if (c.pass === true) map.set(caseId, { output: c.output, snapshot: snap });
    }
  }
  return map;
}

/** 현재 프로브 파일들의 해시를 읽어 조합 해시와 파일별 해시를 계산한다(스냅샷 무관). */
function computeLiveProbeHash(state: RatchetState, configPath: string): LiveProbe {
  const configDir = dirname(configPath);
  const liveHashes: Record<string, string> = {};
  for (const probe of state.target.probes) {
    liveHashes[probe] = hashFile(resolve(configDir, probe));
  }
  return { combined: combinedProbeHash(liveHashes), liveHashes };
}

/**
 * 프로브 드리프트 리포트(처방 1). 어느 프로브 파일이 갈렸는지 current.probes(동결 시점 기록) 대비로 좁힌다.
 * mismatch는 케이스별 출처 스냅샷 probeHash 대조(호출자)에서 판정하고, 여기선 드리프트 파일 목록만 짚는다.
 */
function reportProbeDrift(state: RatchetState, live: LiveProbe, mismatch: boolean): ProbeReport {
  const driftedFiles: string[] = [];
  if (mismatch) {
    for (const probe of state.target.probes) {
      // current.probes는 동결 시점 기록(freeze/init이 갱신). 현재 파일과 다르면 그 파일이 갈렸다.
      const frozenFileHash = state.current.probes[probe];
      if (frozenFileHash != null && live.liveHashes[probe] !== frozenFileHash) {
        driftedFiles.push(probe);
      }
    }
    // current.probes로 특정 파일을 못 짚으면(기록 부재) 프로브 세트 전체를 후보로 보고한다.
    if (driftedFiles.length === 0) driftedFiles.push(...state.target.probes);
  }
  return { mismatch, driftedFiles };
}

function resolveReplayProviderPath(): string {
  // 컴파일 결과 배치: dist/commands/check.js → dist/replay-provider.js
  return resolve(__dirname, "..", "replay-provider.js");
}

/**
 * 결정적 replay eval을 실행한다 — 동결 출력 합집합을 replay-provider로 되돌리고 현재 프로브를 재적용한다.
 * replayMap은 buildReplayMap이 구성한 "케이스별 최신 pass 스냅샷 출력" 합집합이다.
 */
async function runReplayEval(
  cwd: string,
  configPath: string,
  replayMap: Map<string, ReplayEntry>,
): Promise<CaseResult[]> {
  const replayDir = resolve(cwd, ".ratchet", "replay");
  mkdirSync(replayDir, { recursive: true });

  // replay 파일: caseId(description) → 동결 출력 문자열. replay-provider가 이 맵을 되돌린다.
  const replayObj: Record<string, string> = {};
  for (const [caseId, entry] of replayMap) {
    replayObj[caseId] = entry.output;
  }
  const replayFilePath = resolve(replayDir, "replay-map.json");
  writeFileSync(replayFilePath, `${JSON.stringify(replayObj, null, 2)}\n`, "utf-8");

  const replayConfig = createReplayConfig(configPath, resolveReplayProviderPath(), replayDir);
  return runEval({
    configPath: replayConfig,
    configDir: resolve(replayDir, "promptfoo"),
    // 캐시 비활성 필수: replay 프로바이더의 출력은 replay 파일(동결 스냅샷)에 따라 달라지는데
    // promptfoo는 prompt+provider config로 캐시하므로, 켜두면 동결 출력을 변조·재동결해도
    // 이전 실행의 캐시 응답이 나와 회귀를 못 잡는다(결정성 게이트가 무력화됨).
    extraEnv: { RATCHETLOCK_REPLAY_FILE: replayFilePath, PROMPTFOO_CACHE_ENABLED: "false" },
  });
}

/**
 * floor 회귀 판정. floor 케이스별로 사유를 분류한다(round2-B ②):
 *  - replay-uncovered: 결정적 모드에서 replay-map이 그 케이스를 못 덮음(어떤 pass 스냅샷에도 없음).
 *    → error 행(process.exit)이 assert 실패로 오분류되던 것을 "replay 불가"로 명확히 분리한다.
 *  - assert: 결과 행은 있으나 pass 아님(진짜 assert 실패).
 *  - no-result: 평가 결과 행 자체가 없음(tests에서 커버 안 됨).
 * coveredCaseIds가 null이면(live 모드) replay 커버리지 검사를 건너뛴다.
 */
export function findRegressions(
  floor: FloorResult,
  byCase: Map<string, CaseResult>,
  coveredCaseIds: Set<string> | null,
): Regression[] {
  const regressed: Regression[] = [];
  for (const caseId of floor.caseIds) {
    if (coveredCaseIds && !coveredCaseIds.has(caseId)) {
      regressed.push({
        caseId,
        reason: "스냅샷 커버 안 됨(어떤 pass 스냅샷에도 없음)",
        kind: "replay-uncovered",
      });
      continue;
    }
    const r = byCase.get(caseId);
    if (!r) {
      regressed.push({
        caseId,
        reason: "평가 결과 없음(동결 스냅샷·tests에서 커버 안 됨)",
        kind: "no-result",
      });
    } else if (!r.pass) {
      const detail = r.failedAsserts.map((a) => a.reason).filter(Boolean).join("; ");
      regressed.push({ caseId, reason: detail || "assert 실패", kind: "assert" });
    }
  }
  return regressed;
}

/**
 * verdict 동결 대조(처방 2, 2x2 분기): floor의 frozen 케이스에 대해 replay 재채점(score/pass)을
 * 동결 기록과 비교한다. 프로브 해시가 다르면 드리프트 케이스(프로브 변경이 측정을 바꾼 것),
 * 프로브 해시가 같은데 갈리면 스냅샷 불일치다.
 *
 * 스냅샷 불일치(무결성 위반): replay-provider는 저장 output을 그대로 되돌리고 프로브도 동결 시점과
 * 같으므로, 결정적 프로브라면 재채점 score는 저장 score와 반드시 일치해야 한다. 그런데 갈렸다는 건
 * 저장된 (output, score) 쌍 자체가 어긋났다는 뜻 — 스냅샷이 변조·손상됐다(예: ratchet.json 직접 편집).
 * 이는 "결정성 버그"가 아니라 동결 기록의 무결성 위반이므로 그 라벨로 분리한다(loud fail).
 */
function classifyDivergences(
  floor: FloorResult,
  replayMap: Map<string, ReplayEntry>,
  byCase: Map<string, CaseResult>,
  liveCombined: string,
): { snapshotMismatches: Divergence[]; driftCases: Divergence[] } {
  const snapshotMismatches: Divergence[] = [];
  const driftCases: Divergence[] = [];
  for (const caseId of floor.fromFrozen) {
    const entry = replayMap.get(caseId);
    const replay = byCase.get(caseId);
    if (!entry || !replay) continue;
    // frozen 대조 대상은 그 출력을 replay한 출처 스냅샷의 기록이다(케이스별 분리).
    const frozen = entry.snapshot.cases[caseId];
    if (!frozen) continue;
    const diverged = replay.score !== frozen.score || replay.pass !== frozen.pass;
    if (!diverged) continue;
    // probeHash 대조도 케이스별 출처 스냅샷 기준: 그 출력을 낸 스냅샷의 probeHash가 현재와 다르면
    // 드리프트(프로브 변경이 측정을 바꾼 것), 같은데 갈리면 스냅샷 무결성 위반.
    const probeMismatch = entry.snapshot.probeHash !== liveCombined;
    if (probeMismatch) driftCases.push({ caseId, frozen, replay });
    else snapshotMismatches.push({ caseId, frozen, replay });
  }
  return { snapshotMismatches, driftCases };
}

export async function runCheck(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      prompt: { type: "string" },
      live: { type: "boolean", default: false },
      "probe-locked": { type: "boolean", default: false },
      retry: { type: "string" },
    },
    allowPositionals: false,
  });

  const cwd = process.cwd();
  const ratchetPath = resolve(cwd, "ratchet.json");
  if (!stateExists(ratchetPath)) {
    console.error("ratchet.json을 찾을 수 없습니다. init을 먼저 실행하세요.");
    process.exitCode = 1;
    return;
  }

  const state = loadState(ratchetPath);
  const targetPrompt = values.prompt ?? state.activePrompt;
  if (!state.target.prompts.includes(targetPrompt)) {
    console.error(
      `알 수 없는 프롬프트: ${targetPrompt} (target.prompts: ${state.target.prompts.join(", ")})`,
    );
    process.exitCode = 1;
    return;
  }

  // check는 read-only 게이트 — 디스크의 activePrompt를 바꾸지 않는다. floor만 targetPrompt 기준으로 도출.
  const floor = deriveFloor({ ...state, activePrompt: targetPrompt });
  const configPath = resolve(cwd, state.target.config);
  const live = Boolean(values.live);
  const probeLocked = Boolean(values["probe-locked"]);

  let retry: number;
  try {
    retry = parseRetry(values.retry);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  // --retry는 라이브 비결정성 대응 — 결정적 replay 경로에선 출력이 고정이라 무의미하다(무시+경고).
  if (retry > 0 && !live) {
    console.error("[경고] --retry는 --live에서만 유효합니다 — 결정적 replay 경로에선 무시합니다.");
    retry = 0;
  }

  const snapshot = latestFrozenFor(state, targetPrompt);

  // 결정적 모드인데 동결 스냅샷이 하나도 없으면 replay 불가.
  if (!live && !snapshot) {
    if (floor.caseIds.length === 0) {
      console.log(`[check] ${targetPrompt}: 동결된 계약이 없습니다 — 게이트 통과(floor 비어있음).`);
      return;
    }
    console.error(
      `[check] ${targetPrompt}: 동결 스냅샷이 없어 결정적 replay 불가. freeze를 먼저 실행하거나 --live로 평가하세요.`,
    );
    process.exitCode = 1;
    return;
  }

  // 결정적 replay-map: activePrompt 스냅샷 합집합(케이스별 최신 pass 우선, round2-B ①).
  const replayMap = live ? new Map<string, ReplayEntry>() : buildReplayMap(state.frozen, targetPrompt);

  // probeHash 게이트(처방 1). 케이스별 출처 스냅샷의 probeHash를 현재와 대조 —
  // floor(fromFrozen) 케이스의 출처 스냅샷 중 하나라도 현재 프로브와 다르면 드리프트로 본다.
  const liveProbe = !live ? computeLiveProbeHash(state, configPath) : { combined: "", liveHashes: {} };
  const probeMismatch =
    !live &&
    floor.fromFrozen.some((caseId) => {
      const entry = replayMap.get(caseId);
      return entry != null && entry.snapshot.probeHash !== liveProbe.combined;
    });
  const probe: ProbeReport = !live
    ? reportProbeDrift(state, liveProbe, probeMismatch)
    : { mismatch: false, driftedFiles: [] };

  let results: CaseResult[];
  try {
    if (!live) {
      results = await runReplayEval(cwd, configPath, replayMap);
    } else {
      const initial = await runEval({ configPath });
      if (retry > 0) {
        const outcome = await retryFailedLiveCases(
          initial,
          targetPrompt,
          retry,
          (caseIds) => runEval({ configPath, filterPattern: buildFilterPattern(caseIds) }),
          (msg) => console.log(msg),
        );
        results = outcome.results;
        for (const [caseId, attempt] of outcome.passedOnRetry) {
          console.log(`${caseId}: 재시도 ${attempt}/${retry}에 통과`);
        }
      } else {
        results = initial;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  writeLastEval(cwd, results);

  const byCase = new Map<string, CaseResult>();
  for (const r of results.filter((r) => r.promptId === targetPrompt)) byCase.set(r.caseId, r);

  const { snapshotMismatches, driftCases } = !live
    ? classifyDivergences(floor, replayMap, byCase, liveProbe.combined)
    : { snapshotMismatches: [] as Divergence[], driftCases: [] as Divergence[] };

  // 스냅샷 불일치로 이미 잡힌 케이스는 회귀 카운트에서 뺀다 — 변조된 저장 output이 재채점에서
  // fail로 나오면 findRegressions와 classifyDivergences가 같은 사건을 이중 계상하기 때문이다.
  const mismatchIds = new Set(snapshotMismatches.map((d) => d.caseId));
  // 결정적 모드에선 replay-map 커버 집합을 넘겨 "replay 불가"를 assert 실패와 분리 분류한다(②).
  const coveredCaseIds = live ? null : new Set(replayMap.keys());
  const regressed = findRegressions(floor, byCase, coveredCaseIds).filter(
    (r) => !mismatchIds.has(r.caseId),
  );

  // ── verdict 출력(stdout, ISC-2.2/3.3: verdict만 stdout ≤12줄, 원시 출력은 로그로) ──
  const mode = live ? "live" : "replay";
  console.log(`[check] ${targetPrompt} (${mode}) — floor ${floor.caseIds.length}건`);

  if (probe.mismatch) {
    console.log(`[probe drift] 프로브 해시 불일치: ${probe.driftedFiles.join(", ")} (동결 시점과 다름)`);
  }
  for (const d of driftCases) {
    console.log(
      `[drift] ${d.caseId}: 동결 score ${d.frozen.score} → 재채점 ${d.replay.score} (프로브 변경 영향)`,
    );
  }
  for (const b of snapshotMismatches) {
    console.log(
      `[스냅샷 불일치] ${b.caseId}: 프로브 동일한데 동결 ${b.frozen.score} ≠ 재채점 ${b.replay.score} (동결 기록 무결성 위반)`,
    );
  }
  for (const r of regressed) {
    // replay 불가(스냅샷 미커버)는 assert 실패와 다른 라벨로 표기한다(②).
    const tag = r.kind === "replay-uncovered" ? "replay 불가" : "회귀";
    console.log(`[${tag}] ${r.caseId}: ${r.reason}`);
  }

  // ── 판정 ──
  // 스냅샷 불일치: 프로브가 같은데 저장 output 재채점이 저장 score와 갈림 → 무조건 loud fail(동결 무결성 위반).
  // 회귀: floor 케이스가 pass 못 함(assert 실패 또는 replay 불가) → fail.
  // 드리프트(프로브 변경): 기본 경고, --probe-locked면 하드 페일(처방 2).
  const uncoveredCount = regressed.filter((r) => r.kind === "replay-uncovered").length;
  const regressCount = regressed.length - uncoveredCount;
  const hardFail =
    regressed.length > 0 ||
    snapshotMismatches.length > 0 ||
    (probeLocked && probe.mismatch);

  if (hardFail) {
    if (probeLocked && probe.mismatch && regressed.length === 0 && snapshotMismatches.length === 0) {
      console.log(`반려: 프로브 락(--probe-locked) 위반 — 프로브 드리프트 감지.`);
    } else {
      const uncoveredNote = uncoveredCount > 0 ? `, replay 불가 ${uncoveredCount}건` : "";
      console.log(
        `반려: 동결 계약 회귀 ${regressCount}건${uncoveredNote}, 스냅샷 불일치 ${snapshotMismatches.length}건.`,
      );
    }
    process.exitCode = 1;
    return;
  }

  const warn = probe.mismatch ? " (프로브 드리프트 경고 — --probe-locked로 하드 페일)" : "";
  console.log(`통과: floor ${floor.caseIds.length}건 전부 pass.${warn}`);
}
