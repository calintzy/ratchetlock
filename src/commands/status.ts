import { resolve } from "node:path";
import { loadState, stateExists, type FailCase, type RatchetState } from "../state.js";
import { combinedProbeHash } from "./freeze.js";
import { deriveFloor, latestFrozenFor } from "../floor.js";

/** status 커맨드 — §4/§5 T4, ratchet.json을 읽기만 하고 상태를 변이하지 않는다. */

export interface StatusReport {
  activePrompt: string;
  currentPromptHash: string | null;
  currentProbeHash: string | null;
  frozenCount: number;
  floorSize: number;
  failCases: FailCase[];
  promptDrift: boolean;
  probeDrift: boolean;
}

/**
 * 상태 요약을 순수 계산한다(ratchet.json 필드만 사용, 부작용 없음).
 * floor 크기는 정식 floor 규칙(floor.ts deriveFloor, B1)으로 계산한다 — T4의 근사 계산을 교체(§ T4 요청).
 */
export function computeStatus(state: RatchetState): StatusReport {
  const activePrompt = state.activePrompt;
  const currentPromptHash = state.current.prompts[activePrompt] ?? null;
  const currentProbeHash =
    Object.keys(state.current.probes).length > 0 ? combinedProbeHash(state.current.probes) : null;

  const latestSnapshot = latestFrozenFor(state, activePrompt);

  const promptDrift = latestSnapshot != null && latestSnapshot.promptHash !== currentPromptHash;
  const probeDrift = latestSnapshot != null && latestSnapshot.probeHash !== currentProbeHash;

  return {
    activePrompt,
    currentPromptHash,
    currentProbeHash,
    frozenCount: state.frozen.length,
    floorSize: deriveFloor(state).caseIds.length,
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
  console.log(`floor 크기: ${report.floorSize}건`);
  console.log(
    `drift: prompt=${report.promptDrift ? "예" : "아니오"}, probe=${report.probeDrift ? "예" : "아니오"}`,
  );
  console.log(`failCases: ${report.failCases.length}건`);
  for (const fail of report.failCases) {
    console.log(`  - ${fail.id} [${fail.promptId}] ${fail.caseRef}`);
  }
}
