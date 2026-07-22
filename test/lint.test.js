const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLintConfig, lintVerdict } = require("../dist/commands/lint.js");
const { normalizeResults } = require("../dist/promptfoo.js");
const abFixture = require("../examples/cardnews/fixtures/ab.json");

/**
 * lint 라이브 lint(피드백 항목 3) — 단일 케이스 config 생성과 판정 로직을 순수 함수로 못박는다.
 * end-to-end promptfoo eval은 examples/cardnews fixture를 --output으로 넣는 Bash 스모크가 덮는다.
 */

test("buildLintConfig는 현재 프로브를 defaultTest.assert로 연결하고 replay-provider를 providers로 고정한다", () => {
  const yaml = buildLintConfig({
    promptRef: "/abs/prompt_v2.txt",
    probeRefs: ["/abs/asserts.js", "/abs/extra.js"],
    replayProviderPath: "/abs/replay-provider.js",
    caseId: "lint",
    vars: {},
  });

  assert.match(yaml, /- file:\/\/\/abs\/prompt_v2\.txt/);
  assert.match(yaml, /- id: 'exec: node "\/abs\/replay-provider\.js"'/);
  assert.match(yaml, /value: file:\/\/\/abs\/asserts\.js/);
  assert.match(yaml, /value: file:\/\/\/abs\/extra\.js/);
  assert.match(yaml, /description: "lint"/);
});

test("buildLintConfig는 --vars로 받은 vars를 테스트 케이스에 주입한다(프로브가 원문 대조에 사용)", () => {
  const yaml = buildLintConfig({
    promptRef: "/abs/prompt.txt",
    probeRefs: ["/abs/asserts.js"],
    replayProviderPath: "/abs/replay-provider.js",
    caseId: "lint",
    vars: { signal: "원문 시그널 텍스트" },
  });

  // JSON 직렬화된 vars가 YAML flow 매핑으로 들어간다(JSON ⊂ YAML).
  assert.match(yaml, /vars: \{"signal":"원문 시그널 텍스트"\}/);
});

test("lintVerdict: 통과 케이스는 pass=true, 위반 0건(정상 출력)", () => {
  const results = normalizeResults(abFixture);
  const verdict = lintVerdict(results, "prompt_v2.txt", "07-21 ② fastmcp (저자 주장 2회 포함)");
  assert.equal(verdict.found, true);
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.violations, []);
});

test("lintVerdict: 프로브 위반 케이스는 pass=false, 위반 사유를 담아 반환한다(신규 왜곡 검출)", () => {
  const results = normalizeResults(abFixture);
  const verdict = lintVerdict(results, "prompt_v2.txt", "07-21 ① OmniRoute (저자 주장 한정어 포함)");
  assert.equal(verdict.found, true);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.violations.length, 1);
  assert.equal(verdict.violations[0].reason, "'저자 주장' 한정어 소실(프레이밍 왜곡)");
});

test("lintVerdict: 결과에 케이스가 없으면 found=false", () => {
  const verdict = lintVerdict([], "prompt_v2.txt", "lint");
  assert.equal(verdict.found, false);
  assert.equal(verdict.pass, false);
});
