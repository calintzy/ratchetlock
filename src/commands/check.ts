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

/**
 * check 게이트 — §4/§5 T3. 동결된 계약(floor)이 여전히 통과하는지 검사하고 회귀 시 exit 1.
 *
 * 기본(결정적): activePrompt의 최신 frozen 스냅샷 출력을 replay-provider로 되돌려(C2),
 *   현재 asserts.js를 재적용해 floor를 대조한다 — LLM 비결정성 없이 프로브/프롬프트 드리프트를 잡는다.
 * --live: replay 대신 원본 config(실 프로바이더)로 fresh eval(ISC-3.4).
 *
 * C1 알려진 한계: replay-provider는 promptId를 보지 않고 caseId(description)만으로 출력을 되돌린다
 *   (src/replay-provider.js, T2 소유 — 코드 변경 금지). check는 단일 activePrompt에 바인딩된
 *   frozen 스냅샷만 replay하므로 한 번의 실행에서 프롬프트 차원 혼선이 없다 → MVP에선 안전하다.
 *   (여러 프롬프트를 한 replay에 섞으면 같은 caseId가 프롬프트별로 갈리는데, 그 seam은 T2 소관이다.)
 */

interface Divergence {
  caseId: string;
  frozen: FrozenCase;
  replay: CaseResult;
}

interface ProbeCheck {
  mismatch: boolean;
  /** 프로브 파일별 드리프트 상세(현재 파일 해시 vs 동결 시점 기록) */
  driftedFiles: string[];
}

/**
 * 현재 프로브 조합 해시를 동결 스냅샷의 probeHash와 대조한다(처방 1).
 * 조합 해시가 어긋나면, 어느 프로브 파일이 갈렸는지 current.probes(동결 시점 기록) 대비로 좁힌다.
 */
function checkProbeHash(
  state: RatchetState,
  snapshot: FrozenSnapshot,
  configPath: string,
): ProbeCheck {
  const configDir = dirname(configPath);
  const liveHashes: Record<string, string> = {};
  for (const probe of state.target.probes) {
    liveHashes[probe] = hashFile(resolve(configDir, probe));
  }
  const liveCombined = combinedProbeHash(liveHashes);
  const mismatch = liveCombined !== snapshot.probeHash;

  const driftedFiles: string[] = [];
  if (mismatch) {
    for (const probe of state.target.probes) {
      // current.probes는 동결 시점 기록(freeze/init이 갱신). 현재 파일과 다르면 그 파일이 갈렸다.
      const frozenFileHash = state.current.probes[probe];
      if (frozenFileHash != null && liveHashes[probe] !== frozenFileHash) {
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

/** 결정적 replay eval을 실행한다 — 동결 출력을 replay-provider로 되돌리고 현재 프로브를 재적용한다. */
async function runReplayEval(
  cwd: string,
  configPath: string,
  snapshot: FrozenSnapshot,
): Promise<CaseResult[]> {
  const replayDir = resolve(cwd, ".ratchet", "replay");
  mkdirSync(replayDir, { recursive: true });

  // replay 파일: caseId(description) → 동결 출력 문자열. replay-provider가 이 맵을 되돌린다.
  const replayMap: Record<string, string> = {};
  for (const [caseId, c] of Object.entries(snapshot.cases)) {
    replayMap[caseId] = c.output;
  }
  const replayFilePath = resolve(replayDir, "replay-map.json");
  writeFileSync(replayFilePath, `${JSON.stringify(replayMap, null, 2)}\n`, "utf-8");

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

/** floor 회귀 판정: floor 케이스 중 replay/live 결과가 pass가 아니거나 커버되지 않은 것. */
function findRegressions(
  floor: FloorResult,
  byCase: Map<string, CaseResult>,
): { caseId: string; reason: string }[] {
  const regressed: { caseId: string; reason: string }[] = [];
  for (const caseId of floor.caseIds) {
    const r = byCase.get(caseId);
    if (!r) {
      regressed.push({ caseId, reason: "평가 결과 없음(동결 스냅샷·tests에서 커버 안 됨)" });
    } else if (!r.pass) {
      const detail = r.failedAsserts.map((a) => a.reason).filter(Boolean).join("; ");
      regressed.push({ caseId, reason: detail || "assert 실패" });
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
  snapshot: FrozenSnapshot,
  byCase: Map<string, CaseResult>,
  probeMismatch: boolean,
): { snapshotMismatches: Divergence[]; driftCases: Divergence[] } {
  const snapshotMismatches: Divergence[] = [];
  const driftCases: Divergence[] = [];
  for (const caseId of floor.fromFrozen) {
    const frozen = snapshot.cases[caseId];
    const replay = byCase.get(caseId);
    if (!frozen || !replay) continue;
    const diverged = replay.score !== frozen.score || replay.pass !== frozen.pass;
    if (!diverged) continue;
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

  const snapshot = latestFrozenFor(state, targetPrompt);

  // 결정적 모드인데 동결 스냅샷이 없으면 replay 불가.
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

  // probeHash 게이트(처방 1) — 결정적 모드에서 snapshot 존재 시.
  const probe: ProbeCheck =
    snapshot && !live ? checkProbeHash(state, snapshot, configPath) : { mismatch: false, driftedFiles: [] };

  let results: CaseResult[];
  try {
    results = live
      ? await runEval({ configPath })
      : await runReplayEval(cwd, configPath, snapshot as FrozenSnapshot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  writeLastEval(cwd, results);

  const byCase = new Map<string, CaseResult>();
  for (const r of results.filter((r) => r.promptId === targetPrompt)) byCase.set(r.caseId, r);

  const { snapshotMismatches, driftCases } =
    snapshot && !live
      ? classifyDivergences(floor, snapshot, byCase, probe.mismatch)
      : { snapshotMismatches: [] as Divergence[], driftCases: [] as Divergence[] };

  // 스냅샷 불일치로 이미 잡힌 케이스는 회귀 카운트에서 뺀다 — 변조된 저장 output이 재채점에서
  // fail로 나오면 findRegressions와 classifyDivergences가 같은 사건을 이중 계상하기 때문이다.
  const mismatchIds = new Set(snapshotMismatches.map((d) => d.caseId));
  const regressed = findRegressions(floor, byCase).filter((r) => !mismatchIds.has(r.caseId));

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
    console.log(`[회귀] ${r.caseId}: ${r.reason}`);
  }

  // ── 판정 ──
  // 스냅샷 불일치: 프로브가 같은데 저장 output 재채점이 저장 score와 갈림 → 무조건 loud fail(동결 무결성 위반).
  // 회귀: floor 케이스가 pass 못 함 → fail.
  // 드리프트(프로브 변경): 기본 경고, --probe-locked면 하드 페일(처방 2).
  const hardFail =
    regressed.length > 0 ||
    snapshotMismatches.length > 0 ||
    (probeLocked && probe.mismatch);

  if (hardFail) {
    if (probeLocked && probe.mismatch && regressed.length === 0 && snapshotMismatches.length === 0) {
      console.log(`반려: 프로브 락(--probe-locked) 위반 — 프로브 드리프트 감지.`);
    } else {
      console.log(`반려: 동결 계약 회귀 ${regressed.length}건, 스냅샷 불일치 ${snapshotMismatches.length}건.`);
    }
    process.exitCode = 1;
    return;
  }

  const warn = probe.mismatch ? " (프로브 드리프트 경고 — --probe-locked로 하드 페일)" : "";
  console.log(`통과: floor ${floor.caseIds.length}건 전부 pass.${warn}`);
}
