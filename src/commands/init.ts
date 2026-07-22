import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { hashFile, saveState, type RatchetState } from "../state.js";

interface ExtractedTarget {
  prompts: string[];
  probes: string[];
  tests: string;
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function stripFilePrefix(value: string): string {
  return value.replace(/^file:\/\//, "");
}

/** hashFile의 ENOENT를 "어느 파일이 없는지" 명확한 에러로 래핑한다(누락 프롬프트/프로브 파일 진단). */
function hashFileOrExplain(filePath: string): string {
  try {
    return hashFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`파일을 찾을 수 없습니다: ${filePath}`);
    }
    throw error;
  }
}

/**
 * promptfoo config(YAML)에서 prompts/tests/probes를 추출한다.
 * 범용 YAML 파서가 아니라 promptfoo config의 알려진 부분집합만 다룬다
 * (prompts 리스트, tests 스칼라, defaultTest.assert의 javascript file:// 참조).
 */
export function extractConfigRefs(yamlText: string): ExtractedTarget {
  const lines = yamlText.split(/\r?\n/);

  const promptsKeyIdx = lines.findIndex((line) => /^prompts:\s*$/.test(line.trim()));
  const prompts: string[] = [];
  if (promptsKeyIdx !== -1) {
    for (let i = promptsKeyIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") continue;
      if (!/^\s/.test(line)) break;
      const match = line.trim().match(/^-\s*(.+)$/);
      if (match) prompts.push(stripFilePrefix(stripQuotes(match[1])));
    }
  }

  const testsMatch = yamlText.match(/^tests:\s*(.+)$/m);
  const tests = testsMatch ? stripFilePrefix(stripQuotes(testsMatch[1])) : "";

  const probes: string[] = [];
  const jsAssertRegex = /-\s*type:\s*javascript[\s\S]*?value:\s*(\S+)/g;
  let assertMatch: RegExpExecArray | null;
  while ((assertMatch = jsAssertRegex.exec(yamlText)) !== null) {
    probes.push(stripFilePrefix(stripQuotes(assertMatch[1])));
  }

  return { prompts, probes, tests };
}

function detectConfig(cwd: string): string | null {
  for (const candidate of ["promptfooconfig.yaml", "promptfooconfig.yml"]) {
    const candidatePath = join(cwd, candidate);
    if (existsSync(candidatePath)) return candidatePath;
  }
  return null;
}

export async function runInit(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string", short: "c" },
    },
    allowPositionals: false,
  });

  const cwd = process.cwd();
  const configPath = values.config ? resolve(cwd, values.config) : detectConfig(cwd);

  if (!configPath || !existsSync(configPath)) {
    console.error("promptfooconfig.yaml을 찾을 수 없습니다. -c <config>로 지정하세요.");
    process.exitCode = 1;
    return;
  }

  const configText = readFileSync(configPath, "utf-8");
  const { prompts, probes, tests } = extractConfigRefs(configText);

  if (prompts.length === 0) {
    console.error(`${configPath}에서 prompts를 찾을 수 없습니다.`);
    process.exitCode = 1;
    return;
  }

  const configDir = dirname(configPath);

  const promptHashes: Record<string, string> = {};
  for (const prompt of prompts) {
    promptHashes[prompt] = hashFileOrExplain(resolve(configDir, prompt));
  }

  const probeHashes: Record<string, string> = {};
  for (const probe of probes) {
    probeHashes[probe] = hashFileOrExplain(resolve(configDir, probe));
  }

  const state: RatchetState = {
    schemaVersion: 1,
    target: {
      config: basename(configPath),
      prompts,
      probes,
      tests,
    },
    activePrompt: prompts[0],
    current: {
      prompts: promptHashes,
      probes: probeHashes,
    },
    frozen: [],
    failCases: [],
  };

  // ratchet.json은 cwd에 쓴다 — check/freeze/status/add-fail가 모두 cwd에서 읽으므로(config 디렉토리에서
  // 실행하는 것을 전제한다). configDir에 쓰면 다른 커맨드가 못 찾는 불일치가 생긴다.
  const outPath = join(cwd, "ratchet.json");
  saveState(outPath, state);

  console.log(`ratchet.json 생성됨: ${outPath}`);
  console.log(`  prompts: ${prompts.join(", ")}`);
  console.log(`  probes: ${probes.join(", ") || "(none)"}`);
  console.log(`  tests: ${tests || "(none)"}`);
  console.log(`  activePrompt: ${state.activePrompt}`);
}
