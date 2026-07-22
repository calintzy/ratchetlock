import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CaseResult } from "./promptfoo.js";

/** 직전 eval 런 아티팩트 경로(§3.4 — 상태가 아닌 캐시, add-fail --from-last가 읽는다). */
export function resolveLastEvalPath(cwd: string): string {
  return resolve(cwd, ".ratchet", "last-eval.json");
}

/** 직전 eval 결과를 last-eval.json에 덮어쓴다(check/freeze 공유 — 이전에는 두 곳에 중복됐다). */
export function writeLastEval(cwd: string, results: CaseResult[]): void {
  const outPath = resolveLastEvalPath(cwd);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify({ evaluatedAt: new Date().toISOString(), results }, null, 2)}\n`,
    "utf-8",
  );
}
