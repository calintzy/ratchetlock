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
  const tests = testsMatch ? stripQuotes(testsMatch[1]) : "";

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
    promptHashes[prompt] = hashFile(resolve(configDir, prompt));
  }

  const probeHashes: Record<string, string> = {};
  for (const probe of probes) {
    probeHashes[probe] = hashFile(resolve(configDir, probe));
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

  const outPath = join(configDir, "ratchet.json");
  saveState(outPath, state);

  console.log(`ratchet.json 생성됨: ${outPath}`);
  console.log(`  prompts: ${prompts.join(", ")}`);
  console.log(`  probes: ${probes.join(", ") || "(none)"}`);
  console.log(`  tests: ${tests || "(none)"}`);
  console.log(`  activePrompt: ${state.activePrompt}`);
}
