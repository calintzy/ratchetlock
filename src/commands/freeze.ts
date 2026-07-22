import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import {
  hashContent,
  hashFile,
  loadState,
  saveState,
  stateExists,
  type FrozenCase,
  type FrozenSnapshot,
} from "../state.js";
import { runEval, type CaseResult } from "../promptfoo.js";

/** freeze 커맨드 — §4/§5 T4, require-green 사전조건 + frozen[] 스냅샷 append. */

export interface FreezeDecision {
  ok: boolean;
  frozenCases: Record<string, FrozenCase>;
  unfrozenCaseIds: string[];
}

/**
 * require-green 사전조건 판정 + 동결 케이스 구성(순수 함수, runEval 없이 유닛 테스트 가능).
 * targetPromptId에 해당하는 케이스만 본다. 실패 케이스가 있고 allowPartial=false면 거부(§4 freeze 사전조건).
 * allowPartial=true면 통과분만 frozenCases에 담고 실패분은 unfrozenCaseIds로 보고한다.
 */
export function decideFreeze(
  results: CaseResult[],
  targetPromptId: string,
  allowPartial: boolean,
): FreezeDecision {
  const targetRows = results.filter((r) => r.promptId === targetPromptId);
  const failingRows = targetRows.filter((r) => !r.pass);
  const passingRows = targetRows.filter((r) => r.pass);

  if (failingRows.length > 0 && !allowPartial) {
    return { ok: false, frozenCases: {}, unfrozenCaseIds: failingRows.map((r) => r.caseId) };
  }

  const frozenCases: Record<string, FrozenCase> = {};
  for (const row of passingRows) {
    frozenCases[row.caseId] = { pass: row.pass, score: row.score, output: row.output };
  }
  return { ok: true, frozenCases, unfrozenCaseIds: failingRows.map((r) => r.caseId) };
}

/** frozen snapshot id — ISO 시각에서 밀리초를 버리고 콜론을 하이픈으로 치환한다(§3.3 스키마 예시 형식). */
export function freezeId(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

/** 여러 프로브 파일의 개별 해시를 하나의 조합 해시로 합친다(다중 프로브 대비, §3.3 probeHash). */
export function combinedProbeHash(probeHashes: Record<string, string>): string {
  const combined = Object.keys(probeHashes)
    .sort()
    .map((file) => `${file}:${probeHashes[file]}`)
    .join("|");
  return hashContent(combined);
}

function resolveRatchetPath(cwd: string): string {
  return resolve(cwd, "ratchet.json");
}

function resolveLastEvalPath(cwd: string): string {
  return resolve(cwd, ".ratchet", "last-eval.json");
}

/** 직전 eval 런 아티팩트를 덮어쓴다(§3.4 MINOR — 상태가 아닌 캐시, add-fail --from-last가 읽는다). */
function writeLastEval(cwd: string, results: CaseResult[]): void {
  const outPath = resolveLastEvalPath(cwd);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify({ evaluatedAt: new Date().toISOString(), results }, null, 2)}\n`,
    "utf-8",
  );
}

export async function runFreeze(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      prompt: { type: "string" },
      note: { type: "string" },
      "allow-partial": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const cwd = process.cwd();
  const ratchetPath = resolveRatchetPath(cwd);
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

  const configPath = resolve(cwd, state.target.config);
  let results: CaseResult[];
  try {
    results = await runEval({ configPath });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  // freeze는 상태 관점에선 실패해도 last-eval.json은 남긴다(add-fail --from-last의 데이터 출처).
  writeLastEval(cwd, results);

  const targetRows = results.filter((r) => r.promptId === targetPrompt);
  if (targetRows.length === 0) {
    console.error(`eval 결과에 프롬프트 '${targetPrompt}'에 해당하는 케이스가 없습니다.`);
    process.exitCode = 1;
    return;
  }

  const decision = decideFreeze(results, targetPrompt, Boolean(values["allow-partial"]));

  if (!decision.ok) {
    console.error(
      `freeze 거부: 실패 케이스 ${decision.unfrozenCaseIds.length}건 존재 (--allow-partial 없이는 동결하지 않습니다).`,
    );
    for (const caseId of decision.unfrozenCaseIds) console.error(`  - ${caseId}`);
    process.exitCode = 1;
    return;
  }

  const configDir = dirname(configPath);
  const promptHash = hashFile(resolve(configDir, targetPrompt));
  const probeHashes: Record<string, string> = {};
  for (const probe of state.target.probes) {
    probeHashes[probe] = hashFile(resolve(configDir, probe));
  }
  const probeHash = combinedProbeHash(probeHashes);

  const snapshot: FrozenSnapshot = {
    id: freezeId(),
    promptId: targetPrompt,
    note: values.note ?? "",
    promptHash,
    probeHash,
    cases: decision.frozenCases,
  };

  state.frozen.push(snapshot);
  state.current.prompts[targetPrompt] = promptHash;
  state.current.probes = { ...state.current.probes, ...probeHashes };
  state.activePrompt = targetPrompt;

  saveState(ratchetPath, state);

  const frozenCount = Object.keys(decision.frozenCases).length;
  console.log(`동결됨: ${targetPrompt} — ${frozenCount}건 (snapshot ${snapshot.id})`);
  if (decision.unfrozenCaseIds.length > 0) {
    console.log(`미동결 ${decision.unfrozenCaseIds.length}건:`);
    for (const caseId of decision.unfrozenCaseIds) console.log(`  - ${caseId}`);
  }
}
