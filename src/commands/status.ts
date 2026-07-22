import { dirname, resolve } from "node:path";
import { hashFile, loadState, stateExists, type FailCase, type RatchetState } from "../state.js";
import { combinedProbeHash } from "./freeze.js";
import { deriveFloor, latestFrozenFor } from "../floor.js";

/** 드리프트 대조에 쓰는 디스크 현시점 해시(activePrompt 파일 + 프로브 조합). 파일 부재 시 null. */
export interface LiveHashes {
  promptHash: string | null;
  probeHash: string | null;
}

/** status 커맨드 — §4/§5 T4, ratchet.json을 읽기만 하고 상태를 변이하지 않는다. */

export interface StatusReport {
  activePrompt: string;
  currentPromptHash: string | null;
  currentProbeHash: string | null;
  frozenCount: number;
  /** 동결 스냅샷 묶음 내부의 케이스 총수(묶음 수와 혼동 방지용 병기) */
  frozenCaseCount: number;
  floorSize: number;
  failCases: FailCase[];
  promptDrift: boolean;
  probeDrift: boolean;
}

/**
 * 상태 요약을 순수 계산한다(state + 주입된 라이브 해시만 사용, 부작용 없음).
 * 드리프트는 동결 스냅샷의 해시를 **디스크 현시점** 파일 해시(live)와 대조한다 — check.ts checkProbeHash와
 * 같은 원리다. 이전 구현은 current.prompts/probes(동결 시점 기록)끼리 비교해 항상 false를 냈다(오보).
 * 라이브 해시 읽기는 runStatus가 하고(부작용 격리), 이 함수는 순수해 단위 테스트가 가능하다.
 * floor 크기는 정식 floor 규칙(floor.ts deriveFloor, B1)으로 계산한다 — T4의 근사 계산을 교체(§ T4 요청).
 */
export function computeStatus(state: RatchetState, live: LiveHashes): StatusReport {
  const activePrompt = state.activePrompt;
  const latestSnapshot = latestFrozenFor(state, activePrompt);

  const promptDrift = latestSnapshot != null && latestSnapshot.promptHash !== live.promptHash;
  const probeDrift = latestSnapshot != null && latestSnapshot.probeHash !== live.probeHash;

  return {
    activePrompt,
    currentPromptHash: live.promptHash,
    currentProbeHash: live.probeHash,
    frozenCount: state.frozen.length,
    frozenCaseCount: state.frozen.reduce((n, snap) => n + Object.keys(snap.cases).length, 0),
    floorSize: deriveFloor(state).caseIds.length,
    failCases: state.failCases,
    promptDrift,
    probeDrift,
  };
}

/** hashFile을 부작용 격리해 호출한다 — 파일 부재(ENOENT)는 드리프트 신호(null)로 취급, 그 외는 재던짐. */
function fileHashOrNull(filePath: string): string | null {
  try {
    return hashFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** activePrompt 파일과 프로브 조합의 디스크 현시점 해시를 읽는다(freeze/check와 동일 키잉). */
export function readLiveHashes(state: RatchetState, configDir: string): LiveHashes {
  const promptHash = fileHashOrNull(resolve(configDir, state.activePrompt));

  const liveProbeHashes: Record<string, string> = {};
  for (const probe of state.target.probes) {
    const h = fileHashOrNull(resolve(configDir, probe));
    if (h != null) liveProbeHashes[probe] = h;
  }
  const probeHash =
    Object.keys(liveProbeHashes).length > 0 ? combinedProbeHash(liveProbeHashes) : null;

  return { promptHash, probeHash };
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
  const configDir = dirname(resolve(cwd, state.target.config));
  const report = computeStatus(state, readLiveHashes(state, configDir));

  console.log(`activePrompt: ${report.activePrompt}`);
  console.log(`current prompt hash: ${report.currentPromptHash ?? "(없음)"}`);
  console.log(`current probe hash: ${report.currentProbeHash ?? "(없음)"}`);
  console.log(`frozen: ${report.frozenCount}건 (케이스 ${report.frozenCaseCount}건)`);
  console.log(`floor 크기: ${report.floorSize}건`);
  console.log(
    `drift: prompt=${report.promptDrift ? "예" : "아니오"}, probe=${report.probeDrift ? "예" : "아니오"}`,
  );
  console.log(`failCases: ${report.failCases.length}건`);
  for (const fail of report.failCases) {
    console.log(`  - ${fail.id} [${fail.promptId}] ${fail.caseRef}`);
  }
}
