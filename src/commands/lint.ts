import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { loadState, stateExists } from "../state.js";
import { runEval, type CaseResult, type FailedAssert } from "../promptfoo.js";
import { writeLastEval } from "../lastEval.js";

/**
 * lint 커맨드 — 라이브 lint(피드백 항목 3). 등록된 현재 프로브를 임의의 새 출력 1건에 적용해
 * 신규 왜곡을 검사한다(과거 회귀 가드인 check와 달리 "오늘 새 출력"이 대상).
 *
 * 메커니즘: check의 결정적 replay 기계를 재사용한다 — 단일 케이스 replay map({caseId: 출력내용})과
 * 현재 프로브를 연결한 임시 config를 만들어 promptfoo eval을 돌린다. assert 채점은 promptfoo가 한다
 * (Anti-ISC-1 유지, LLM 호출 없음). ratchet.json은 불변이고, .ratchet/last-eval.json만 갱신해
 * lint에서 잡은 케이스를 add-fail --from-last로 래칫에 승격할 수 있게 한다.
 */

/** lint 단일 케이스의 caseId(replay map 키이자 프로브 매칭 키). */
export const LINT_CASE_ID = "lint";

export interface LintConfigOptions {
  /** 단일 프롬프트 파일 절대경로(replay-provider가 렌더 결과를 무시하므로 어떤 등록 프롬프트든 무방) */
  promptRef: string;
  /** 프로브(javascript assert) 파일 절대경로 목록 */
  probeRefs: string[];
  /** replay-provider.js 절대경로 */
  replayProviderPath: string;
  /** 단일 테스트 케이스의 description(=caseId) */
  caseId: string;
  /** 테스트 케이스에 주입할 vars(프로브가 원문 대조 등에 사용) */
  vars: Record<string, unknown>;
}

/**
 * 현재 프로브를 연결하고 단일 케이스를 인라인한 결정적 lint용 promptfoo config(YAML) 텍스트를 만든다.
 * providers는 replay-provider로 고정하고, file:// 참조는 모두 절대경로라 config 위치와 무관하다.
 * vars/description은 JSON.stringify로 직렬화한다(JSON은 YAML의 부분집합이라 그대로 유효한 YAML flow).
 */
export function buildLintConfig(opts: LintConfigOptions): string {
  // promptfoo parseScriptParts가 공백으로 토큰 분해하므로 경로를 큰따옴표로 감싼다(promptfoo.ts와 동일).
  const yamlSafeProvider = opts.replayProviderPath.replace(/'/g, "''");

  const assertBlock =
    opts.probeRefs.length > 0
      ? opts.probeRefs
          .map((ref) => `    - type: javascript\n      value: file://${ref}`)
          .join("\n")
      : "  assert: []";
  const defaultTest =
    opts.probeRefs.length > 0 ? `defaultTest:\n  assert:\n${assertBlock}` : `defaultTest:\n${assertBlock}`;

  return [
    "prompts:",
    `  - file://${opts.promptRef}`,
    "providers:",
    `  - id: 'exec: node "${yamlSafeProvider}"'`,
    defaultTest,
    "tests:",
    `  - description: ${JSON.stringify(opts.caseId)}`,
    `    vars: ${JSON.stringify(opts.vars)}`,
    "",
  ].join("\n");
}

export interface LintResult {
  found: boolean;
  pass: boolean;
  violations: FailedAssert[];
}

/** lint eval 결과(단일 케이스)에서 pass/violations 판정을 뽑는다. */
export function lintVerdict(results: CaseResult[], promptId: string, caseId: string): LintResult {
  const row = results.find((r) => r.promptId === promptId && r.caseId === caseId);
  if (!row) return { found: false, pass: false, violations: [] };
  return { found: true, pass: row.pass, violations: row.failedAsserts };
}

function resolveReplayProviderPath(): string {
  // 컴파일 결과 배치: dist/commands/lint.js → dist/replay-provider.js
  return resolve(__dirname, "..", "replay-provider.js");
}

export async function runLint(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      output: { type: "string" },
      vars: { type: "string" },
      prompt: { type: "string" },
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

  if (!values.output) {
    console.error(
      "사용법: ratchetlock lint --output <출력파일> [--vars <JSON파일>] [--prompt <label>]",
    );
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

  const outputPath = resolve(cwd, values.output);
  if (!existsSync(outputPath)) {
    console.error(`출력 파일을 찾을 수 없습니다: ${outputPath}`);
    process.exitCode = 1;
    return;
  }
  const outputContent = readFileSync(outputPath, "utf-8");

  let vars: Record<string, unknown> = {};
  if (values.vars) {
    const varsPath = resolve(cwd, values.vars);
    if (!existsSync(varsPath)) {
      console.error(`vars 파일을 찾을 수 없습니다: ${varsPath}`);
      process.exitCode = 1;
      return;
    }
    try {
      vars = JSON.parse(readFileSync(varsPath, "utf-8")) as Record<string, unknown>;
    } catch (error) {
      console.error(`vars 파일 파싱 실패(${varsPath}): ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  const configPath = resolve(cwd, state.target.config);
  const configDir = dirname(configPath);

  const lintDir = resolve(cwd, ".ratchet", "lint");
  mkdirSync(lintDir, { recursive: true });

  // replay map: 단일 케이스 — replay-provider가 description(LINT_CASE_ID)로 이 출력을 되돌린다.
  const replayFilePath = resolve(lintDir, "replay-map.json");
  writeFileSync(
    replayFilePath,
    `${JSON.stringify({ [LINT_CASE_ID]: outputContent }, null, 2)}\n`,
    "utf-8",
  );

  const lintConfig = buildLintConfig({
    promptRef: resolve(configDir, targetPrompt),
    probeRefs: state.target.probes.map((p) => resolve(configDir, p)),
    replayProviderPath: resolveReplayProviderPath(),
    caseId: LINT_CASE_ID,
    vars,
  });
  const lintConfigPath = resolve(lintDir, "lint-config.yaml");
  writeFileSync(lintConfigPath, lintConfig, "utf-8");

  let results: CaseResult[];
  try {
    results = await runEval({
      configPath: lintConfigPath,
      configDir: resolve(lintDir, "promptfoo"),
      // 캐시 비활성 필수: replay 출력은 replay 파일에 따라 달라지므로 캐시를 켜두면 이전 출력이 나온다.
      extraEnv: { RATCHETLOCK_REPLAY_FILE: replayFilePath, PROMPTFOO_CACHE_ENABLED: "false" },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  // last-eval.json 갱신 — lint에서 잡은 케이스를 add-fail --from-last로 승격할 수 있게 한다.
  writeLastEval(cwd, results);

  const verdict = lintVerdict(results, targetPrompt, LINT_CASE_ID);

  console.log(`[lint] ${targetPrompt} — 출력 1건 프로브 검사`);
  if (!verdict.found) {
    console.error("lint 평가 결과에서 케이스를 찾을 수 없습니다(내부 오류).");
    process.exitCode = 1;
    return;
  }
  if (verdict.pass) {
    console.log("통과: 프로브 위반 0건.");
    return;
  }
  for (const v of verdict.violations) {
    console.log(`[위반] ${v.reason || v.type}`);
  }
  console.log(`반려: 프로브 위반 ${verdict.violations.length}건.`);
  process.exitCode = 1;
}
