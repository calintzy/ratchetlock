import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { hashContent } from "./state.js";

/** promptfoo eval 어댑터 — §3.4 확정 스키마 참조. eval 실행·assert 채점은 promptfoo가 한다(Anti-ISC-1). */

const execFileAsync = promisify(execFile);

export interface FailedAssert {
  type: string;
  value?: string;
  reason: string;
}

/** 어댑터가 정규화해 반환하는 케이스 단위 결과. 키는 (promptId, caseId) 복합 키(C1). */
export interface CaseResult {
  promptId: string;
  caseId: string;
  pass: boolean;
  score: number;
  output: string;
  failedAsserts: FailedAssert[];
}

export interface RunEvalOptions {
  /** 실행할 promptfoo config 절대경로 */
  configPath: string;
  /** PROMPTFOO_CONFIG_DIR로 지정할 디렉토리(기본: config 옆 .ratchet/promptfoo) */
  configDir?: string;
  /** eval 결과(-o) JSON을 쓸 경로(기본: configDir 하위에 임시 생성) */
  outPath?: string;
  /** 기본 env에 덧씌울 추가 환경변수(예: RATCHETLOCK_REPLAY_FILE) */
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * `promptfoo eval -c <config> -o <tmp.json>`을 자식 프로세스로 실행하고,
 * 결과 JSON을 CaseResult[]로 정규화해 반환한다.
 * PROMPTFOO_FAILED_TEST_EXIT_CODE=0으로 assert 실패를 크래시가 아닌 정상 데이터로 받는다 —
 * 게이트 판정(래칫 floor 대조)은 이 함수의 호출자가 한다(§3.4, promptfoo exit code 비의존).
 */
export async function runEval(options: RunEvalOptions): Promise<CaseResult[]> {
  const { configPath } = options;
  if (!existsSync(configPath)) {
    throw new Error(`promptfoo config를 찾을 수 없습니다: ${configPath}`);
  }

  const baseDir = dirname(configPath);
  const configDir = options.configDir ?? resolve(baseDir, ".ratchet", "promptfoo");
  mkdirSync(configDir, { recursive: true });

  const outPath = options.outPath ?? resolve(configDir, `eval-${Date.now()}-${process.pid}.json`);

  const env = {
    ...process.env,
    PROMPTFOO_CONFIG_DIR: configDir,
    PROMPTFOO_FAILED_TEST_EXIT_CODE: "0",
    PROMPTFOO_DISABLE_TELEMETRY: "1",
    ...options.extraEnv,
  };

  try {
    await execFileAsync(
      "npx",
      ["promptfoo", "eval", "-c", configPath, "-o", outPath, "--no-progress-bar"],
      { cwd: baseDir, env, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
  } catch (error) {
    throw explainExecError(error);
  }

  if (!existsSync(outPath)) {
    throw new Error(`promptfoo eval이 결과 파일을 생성하지 않았습니다: ${outPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outPath, "utf-8"));
  } catch (error) {
    throw new Error(
      `promptfoo 결과 파일 파싱 실패(${outPath}): ${(error as Error).message}`,
    );
  }

  return normalizeResults(parsed);
}

interface ExecError extends Error {
  code?: string;
  killed?: boolean;
  signal?: string | null;
  stderr?: string;
}

function explainExecError(error: unknown): Error {
  const err = error as ExecError;
  if (err.code === "ENOENT") {
    return new Error(
      "promptfoo eval 실행 실패: npx를 찾을 수 없습니다. Node.js/npm 설치를 확인하세요.",
    );
  }
  if (err.killed && err.signal === "SIGTERM") {
    return new Error("promptfoo eval 타임아웃: 지정된 시간 내에 완료되지 않았습니다.");
  }
  const stderr = err.stderr ? `\n${err.stderr}` : "";
  return new Error(
    `promptfoo eval 실행 실패(promptfoo 미설치 여부를 확인하세요: npm install): ${err.message}${stderr}`,
  );
}

/**
 * promptfoo `-o` 출력 JSON(OutputFile.results, EvaluateSummaryV3)을 CaseResult[]로 정규화한다.
 * 스키마(§3.4, 실측 확인: examples/cardnews/fixtures/{baseline,ab}.json):
 *   results.results[].{success, score, prompt.label, testCase.description, response.output, gradingResult.componentResults[]}
 */
export function normalizeResults(evalOutput: unknown): CaseResult[] {
  const rows = (evalOutput as { results?: { results?: unknown[] } } | null)?.results?.results;
  if (!Array.isArray(rows)) {
    throw new Error(
      "promptfoo 출력 JSON 형식이 예상과 다릅니다: results.results 배열을 찾을 수 없습니다.",
    );
  }
  return rows.map((row) => normalizeRow(row as Record<string, unknown>));
}

function normalizeRow(row: Record<string, any>): CaseResult {
  return {
    promptId: extractPromptId(row.prompt?.label),
    caseId: extractCaseId(row),
    pass: Boolean(row.success),
    score: typeof row.score === "number" ? row.score : 0,
    output: extractOutput(row.response?.output),
    failedAsserts: extractFailedAsserts(row),
  };
}

/**
 * promptId = prompt.label에서 파일명 접두부를 추출한다.
 * 실측(examples/cardnews/fixtures/ab.json): promptfoo가 file:// 프롬프트를 로드하면
 * label = "<파일명>: <템플릿 원문(vars 치환 전)>" 형태로 채워진다(예: "prompt_v2.txt: 아래는…").
 * label 전체를 promptId로 쓰면 ratchet.json의 activePrompt/target.prompts(파일명 그대로, §3.3)와
 * 일치하지 않아 floor 대조(T3)가 깨지므로, 콜론 앞 파일명 토큰만 promptId로 취한다.
 * 접두부 형식이 아닌 label(파일 참조 없이 인라인 프롬프트 등)은 label 전체를 그대로 promptId로 폴백한다.
 */
function extractPromptId(label: unknown): string {
  const text = typeof label === "string" ? label : "";
  const match = text.match(/^(\S+):\s/);
  return match ? match[1] : text;
}

/**
 * caseId = testCase.description 우선, 없으면 vars 직렬화 sha256 폴백(§3.4/Open Questions).
 * 실측(baseline.json 5행 + ab.json 10행, 총 15행): testCase.description이 전 행에 항상 존재해
 * 폴백 경로는 실제로 타지 않았다 — 그래도 방어 코드로 유지한다(§ Open Questions 갱신 참조).
 */
function extractCaseId(row: Record<string, any>): string {
  const description = row.testCase?.description;
  if (typeof description === "string" && description.length > 0) return description;
  return hashContent(JSON.stringify(row.vars ?? row.testCase?.vars ?? {}));
}

function extractOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  return JSON.stringify(output);
}

/** gradingResult 없는 행(error 행)을 방어적으로 처리 — 실패 assert 없음으로 취급한다. */
function extractFailedAsserts(row: Record<string, any>): FailedAssert[] {
  const components = row.gradingResult?.componentResults;
  if (!Array.isArray(components)) return [];
  return components
    .filter((component: any) => component && component.pass === false)
    .map((component: any) => ({
      type: component.assertion?.type ?? "unknown",
      value: component.assertion?.value,
      reason: typeof component.reason === "string" ? component.reason : "",
    }));
}

/**
 * 원본 promptfoo config의 providers만 replay-provider.js로 치환한 결정적 check용 config를 생성한다(C2).
 * file:// 참조(prompts/tests/probe)는 원본 config 디렉토리 기준 절대경로로 재작성한다 —
 * 이 함수가 만든 config는 outDir(원본과 다른 디렉토리, 보통 .ratchet/ 하위)에 쓰이므로
 * 상대경로를 그대로 두면 깨진다.
 */
export function createReplayConfig(
  configPath: string,
  replayProviderPath: string,
  outDir: string,
): string {
  const configDir = dirname(configPath);
  let text = readFileSync(configPath, "utf-8");

  text = text.replace(/file:\/\/([^\s'"]+)/g, (_full, ref: string) => {
    const target = isAbsolute(ref) ? ref : resolve(configDir, ref);
    return `file://${target}`;
  });

  text = replaceProvidersBlock(text, resolve(replayProviderPath));

  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `replay-${basename(configPath)}`);
  writeFileSync(outPath, text, "utf-8");
  return outPath;
}

/** `providers:` 블록(다음 비들여쓰기 키 전까지)을 replay 프로바이더 단일 항목으로 치환한다. */
function replaceProvidersBlock(text: string, replayProviderAbsPath: string): string {
  const lines = text.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => /^providers:/.test(line.trim()));
  if (startIdx === -1) {
    throw new Error("promptfoo config에서 providers 섹션을 찾을 수 없습니다.");
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) {
      endIdx = i;
      break;
    }
  }

  const replacement = ["providers:", `  - id: 'exec: node ${replayProviderAbsPath}'`];
  lines.splice(startIdx, endIdx - startIdx, ...replacement);
  return lines.join("\n");
}
