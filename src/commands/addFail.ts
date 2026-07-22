import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadState, saveState, stateExists, type FailCase, type RatchetState } from "../state.js";
import type { CaseResult } from "../promptfoo.js";

/** add-fail 커맨드 — §4/§5 T4, 잡은 실패를 failCases[]에 영구 회귀 가드로 승격한다. */

interface LastEvalFile {
  evaluatedAt: string;
  results: CaseResult[];
}

/** tests.yaml이 최상위 YAML 시퀀스(리스트) 포맷인지 판별한다(Open Questions: 리스트 포맷일 때만 stdlib append). */
export function isYamlListFormat(yamlText: string): boolean {
  const firstMeaningfulLine = yamlText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  return firstMeaningfulLine != null && firstMeaningfulLine.startsWith("-");
}

/**
 * tests.yaml(리스트 포맷)에 새 테스트 케이스를 append한다(순수 함수, 유닛 테스트 가능).
 * signal 파일 내용은 vars.signal에 블록 스칼라(|-)로 들어간다.
 */
export function appendTestsYamlEntry(
  yamlText: string,
  description: string,
  signalContent: string,
): string {
  const indentedSignal = signalContent
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");

  const entry = [
    `- description: ${JSON.stringify(description)}`,
    `  vars:`,
    `    signal: |-`,
    indentedSignal,
    "",
  ].join("\n");

  const trimmed = yamlText.replace(/\s*$/, "\n");
  return `${trimmed}${entry}`;
}

/** 직전 eval 결과에서 (promptId, caseId) 복합 키로 케이스를 찾는다(add-fail --from-last 읽기, C1). */
export function findLastEvalCase(
  results: CaseResult[],
  promptId: string,
  caseId: string,
): CaseResult | undefined {
  return results.find((r) => r.promptId === promptId && r.caseId === caseId);
}

/** failCases[] 항목 생성(순수 함수) — expectedPass:true 고정, promptId는 provenance(B1). */
export function buildFailCase(
  promptId: string,
  caseRef: string,
  note: string,
  now: Date = new Date(),
): FailCase {
  return {
    id: `fail-${now.getTime()}`,
    addedAt: now.toISOString(),
    promptId,
    caseRef,
    expectedPass: true,
    note,
  };
}

function resolveRatchetPath(cwd: string): string {
  return resolve(cwd, "ratchet.json");
}

function resolveLastEvalPath(cwd: string): string {
  return resolve(cwd, ".ratchet", "last-eval.json");
}

export async function runAddFail(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      prompt: { type: "string" },
      "from-last": { type: "string" },
      signal: { type: "string" },
      desc: { type: "string" },
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

  if (values["from-last"]) {
    addFromLast(state, ratchetPath, cwd, targetPrompt, values["from-last"]);
    return;
  }

  if (values.signal && values.desc) {
    addFromSignal(state, ratchetPath, cwd, targetPrompt, values.signal, values.desc);
    return;
  }

  console.error(
    "사용법: add-fail --from-last <caseId> [--prompt L] 또는 add-fail --signal <file> --desc <text> [--prompt L]",
  );
  process.exitCode = 1;
}

function addFromLast(
  state: RatchetState,
  ratchetPath: string,
  cwd: string,
  targetPrompt: string,
  caseId: string,
): void {
  const lastEvalPath = resolveLastEvalPath(cwd);
  if (!existsSync(lastEvalPath)) {
    console.error(".ratchet/last-eval.json이 없습니다. check 또는 freeze를 먼저 실행하세요.");
    process.exitCode = 1;
    return;
  }

  let lastEval: LastEvalFile;
  try {
    lastEval = JSON.parse(readFileSync(lastEvalPath, "utf-8")) as LastEvalFile;
  } catch (error) {
    console.error(`last-eval.json 파싱 실패(${lastEvalPath}): ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const row = findLastEvalCase(lastEval.results, targetPrompt, caseId);
  if (!row) {
    console.error(`직전 eval 결과에서 케이스를 찾을 수 없습니다: (${targetPrompt}, ${caseId})`);
    process.exitCode = 1;
    return;
  }

  const failCase = buildFailCase(
    row.promptId,
    row.caseId,
    `add-fail --from-last (캡처 시점 ${row.pass ? "pass" : "fail"})`,
  );
  state.failCases.push(failCase);
  saveState(ratchetPath, state);

  console.log(`failCase 등록됨: ${failCase.id} (${failCase.promptId}, ${failCase.caseRef})`);
}

function addFromSignal(
  state: RatchetState,
  ratchetPath: string,
  cwd: string,
  targetPrompt: string,
  signalFile: string,
  desc: string,
): void {
  const signalPath = resolve(cwd, signalFile);
  if (!existsSync(signalPath)) {
    console.error(`signal 파일을 찾을 수 없습니다: ${signalPath}`);
    process.exitCode = 1;
    return;
  }
  const signalContent = readFileSync(signalPath, "utf-8");

  const testsPath = resolve(cwd, state.target.tests);
  if (existsSync(testsPath)) {
    const testsText = readFileSync(testsPath, "utf-8");
    if (isYamlListFormat(testsText)) {
      const updated = appendTestsYamlEntry(testsText, desc, signalContent);
      writeFileSync(testsPath, updated, "utf-8");
      console.log(`tests 파일에 케이스 추가됨: ${testsPath}`);
    } else {
      console.log(
        `tests 파일(${testsPath})이 리스트 포맷이 아니라 자동 추가하지 않았습니다. 다음 케이스를 수동으로 추가하세요:`,
      );
      console.log(`  description: ${desc}`);
      console.log(`  vars.signal: (${signalPath} 내용)`);
    }
  } else {
    console.log(`tests 파일(${testsPath})을 찾을 수 없어 자동 추가하지 않았습니다. failCases에만 등록합니다.`);
  }

  const failCase = buildFailCase(targetPrompt, desc, `add-fail --signal ${signalFile}`);
  state.failCases.push(failCase);
  saveState(ratchetPath, state);

  console.log(`failCase 등록됨: ${failCase.id} (${failCase.promptId}, ${failCase.caseRef})`);
}
