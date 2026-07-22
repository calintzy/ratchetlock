import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** ratchet.json §3.3 스키마 — 계획 docs/PLAN.md 참조. */

export interface RatchetTarget {
  config: string;
  prompts: string[];
  probes: string[];
  tests: string;
}

export interface RatchetCurrent {
  prompts: Record<string, string>;
  probes: Record<string, string>;
}

export interface FrozenCase {
  pass: boolean;
  score: number;
  output: string;
}

export interface FrozenSnapshot {
  id: string;
  promptId: string;
  note: string;
  promptHash: string;
  probeHash: string;
  cases: Record<string, FrozenCase>;
}

export interface FailCase {
  id: string;
  addedAt: string;
  promptId: string;
  caseRef: string;
  expectedPass: boolean;
  note: string;
}

export interface RatchetState {
  schemaVersion: number;
  target: RatchetTarget;
  activePrompt: string;
  current: RatchetCurrent;
  frozen: FrozenSnapshot[];
  failCases: FailCase[];
}

/** 프롬프트/프로브 버전 식별용 sha256 해시. `sha256:<hex>` 형식으로 반환한다. */
export function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** 대상 파일(프롬프트/프로브)의 내용을 읽어 sha256 해시로 변환한다. */
export function hashFile(filePath: string): string {
  return hashContent(readFileSync(filePath, "utf-8"));
}

export function stateExists(filePath: string): boolean {
  return existsSync(filePath);
}

export function loadState(filePath: string): RatchetState {
  const text = readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(text) as RatchetState;
  } catch (error) {
    throw new Error(`ratchet.json 파싱 실패(${filePath}): ${(error as Error).message}`);
  }
}

/** 임시 파일에 쓰고 rename으로 교체한다 — 쓰기 중 크래시로 ratchet.json이 반쪽 손상되는 것을 막는다. */
export function saveState(filePath: string, state: RatchetState): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, filePath);
}
