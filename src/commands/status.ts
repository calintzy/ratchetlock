import { resolve } from "node:path";
import { loadState, stateExists, type FailCase, type RatchetState } from "../state.js";
import { combinedProbeHash } from "./freeze.js";

/** status 커맨드 — §4/§5 T4, ratchet.json을 읽기만 하고 상태를 변이하지 않는다. */

export interface StatusReport {
  activePrompt: string;
  currentPromptHash: string | null;
  currentProbeHash: string | null;
  frozenCount: number;
  floorSizeEstimate: number;
  failCases: FailCase[];
  promptDrift: boolean;
  probeDrift: boolean;
}

/**
 * 상태 요약을 순수 계산한다(ratchet.json 필드만 사용, 부작용 없음).
 * floor 크기는 정식 floor 규칙(B1, floor.ts는 T3 소관)이 아니라 근사치다:
 * activePrompt에 동결된 caseId 전체 ∪ failCases의 caseRef 전체(프롬프트 무관, B1 정신).
 */
export function computeStatus(state: RatchetState): StatusReport {
  const activePrompt = state.activePrompt;
  const currentPromptHash = state.current.prompts[activePrompt] ?? null;
  const currentProbeHash =
    Object.keys(state.current.probes).length > 0 ? combinedProbeHash(state.current.probes) : null;

  const latestSnapshot = [...state.frozen].reverse().find((snap) => snap.promptId === activePrompt);

  const promptDrift = latestSnapshot != null && latestSnapshot.promptHash !== currentPromptHash;
  const probeDrift = latestSnapshot != null && latestSnapshot.probeHash !== currentProbeHash;

  const floorCaseIds = new Set<string>();
  for (const snap of state.frozen) {
    if (snap.promptId !== activePrompt) continue;
    for (const caseId of Object.keys(snap.cases)) floorCaseIds.add(caseId);
  }
  for (const fail of state.failCases) {
    floorCaseIds.add(fail.caseRef);
  }

  return {
    activePrompt,
    currentPromptHash,
    currentProbeHash,
    frozenCount: state.frozen.length,
    floorSizeEstimate: floorCaseIds.size,
    failCases: state.failCases,
    promptDrift,
    probeDrift,
  };
}

export async function runStatus(_args: string[]): Promise<void> {
  const cwd = process.cwd();
  const ratchetPath = resolve(cwd, "ratchet.json");
  if (!stateExists(ratchetPath)) {
    console.error("ratchet.json을 찾을 수 없습니다. init을 먼저 실행하세요.");
    process.exitCode = 1;
    return;
  }

  const state = loadState(ratchetPath);
  const report = computeStatus(state);

  console.log(`activePrompt: ${report.activePrompt}`);
  console.log(`current prompt hash: ${report.currentPromptHash ?? "(없음)"}`);
  console.log(`current probe hash: ${report.currentProbeHash ?? "(없음)"}`);
  console.log(`frozen: ${report.frozenCount}건`);
  console.log(`floor 크기 추정치: ${report.floorSizeEstimate}건`);
  console.log(
    `drift: prompt=${report.promptDrift ? "예" : "아니오"}, probe=${report.probeDrift ? "예" : "아니오"}`,
  );
  console.log(`failCases: ${report.failCases.length}건`);
  for (const fail of report.failCases) {
    console.log(`  - ${fail.id} [${fail.promptId}] ${fail.caseRef}`);
  }
}
