const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { normalizeResults, createReplayConfig } = require("../dist/promptfoo.js");
const abFixture = require("../examples/cardnews/fixtures/ab.json");

test("normalizeResults는 ab.json fixture를 CaseResult[]로 정규화한다(ISC-2.1)", () => {
  const results = normalizeResults(abFixture);

  assert.equal(results.length, 10);

  // 첫 행: prompt_v2.txt, OmniRoute 케이스, 프레이밍 휴리스틱 실패(componentResults[0].pass=false)
  const first = results[0];
  assert.equal(first.promptId, "prompt_v2.txt");
  assert.equal(first.caseId, "07-21 ① OmniRoute (저자 주장 한정어 포함)");
  assert.equal(first.pass, false);
  assert.equal(typeof first.output, "string");
  assert.ok(first.output.length > 0);
  assert.equal(first.failedAsserts.length, 1);
  assert.equal(first.failedAsserts[0].type, "javascript");
  assert.equal(first.failedAsserts[0].reason, "'저자 주장' 한정어 소실(프레이밍 왜곡)");

  // 통과 케이스(3번째 행: prompt_v2.txt, fastmcp, success=true)는 failedAsserts가 비어 있어야 함
  const passingRow = results.find(
    (r) => r.promptId === "prompt_v2.txt" && r.caseId.includes("fastmcp"),
  );
  assert.ok(passingRow);
  assert.equal(passingRow.pass, true);
  assert.deepEqual(passingRow.failedAsserts, []);
});

test("normalizeResults는 results.results가 배열이 아니면 명확한 에러를 던진다", () => {
  assert.throws(() => normalizeResults({}), /results\.results 배열/);
  assert.throws(() => normalizeResults(null), /results\.results 배열/);
});

const MINIMAL_CONFIG =
  "prompts:\n  - file://prompt.txt\nproviders:\n  - id: 'exec: bash provider.sh'\n" +
  "defaultTest:\n  assert:\n    - type: javascript\n      value: file://asserts.js\ntests: file://tests.yaml\n";

test("createReplayConfig는 공백 포함 replay-provider 경로를 큰따옴표로 인용한다(M1 재발 방지)", () => {
  // 실측(공백 경로 replay): 인용 없으면 promptfoo parseScriptParts가 공백에서 토큰 분해해 RESULT_COUNT=0.
  const dir = mkdtempSync(join(tmpdir(), "ratchetlock-m1-"));
  const configPath = join(dir, "promptfooconfig.yaml");
  writeFileSync(configPath, MINIMAL_CONFIG, "utf-8");

  const spacedProvider = join(dir, "dir with space", "replay-provider.js");
  const outPath = createReplayConfig(configPath, spacedProvider, join(dir, "out"));
  const text = readFileSync(outPath, "utf-8");

  // 경로가 큰따옴표로 감싸져야 parseScriptParts가 한 토큰으로 읽는다.
  assert.match(text, /- id: 'exec: node "[^']*dir with space[^']*replay-provider\.js"'/);
  // file:// 참조는 원본 config 디렉토리 기준 절대경로로 재작성된다.
  assert.ok(text.includes(`file://${join(dir, "prompt.txt")}`), "prompt file:// 절대경로 재작성");
  assert.ok(text.includes(`file://${join(dir, "asserts.js")}`), "probe file:// 절대경로 재작성");

  rmSync(dir, { recursive: true, force: true });
});
