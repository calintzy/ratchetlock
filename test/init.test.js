const test = require("node:test");
const assert = require("node:assert/strict");
const { extractConfigRefs } = require("../dist/commands/init.js");

/** init의 promptfoo config 파싱 — file:// 접두부 제거 회귀 방지(M2). */

test("extractConfigRefs는 prompts의 file:// 접두부를 제거한다", () => {
  const refs = extractConfigRefs("prompts:\n  - file://prompt.txt\n  - file://prompt_v2.txt\n");
  assert.deepEqual(refs.prompts, ["prompt.txt", "prompt_v2.txt"]);
});

test("extractConfigRefs는 tests의 file:// 접두부를 제거한다(M2 — 이전엔 stripFilePrefix 누락)", () => {
  const refs = extractConfigRefs("prompts:\n  - file://prompt.txt\ntests: file://tests.yaml\n");
  assert.equal(refs.tests, "tests.yaml");
});

test("extractConfigRefs는 따옴표로 감싼 tests 스칼라의 file://도 제거한다", () => {
  const refs = extractConfigRefs('prompts:\n  - file://prompt.txt\ntests: "file://tests.yaml"\n');
  assert.equal(refs.tests, "tests.yaml");
});

test("extractConfigRefs는 javascript assert의 file:// probe 참조를 뽑는다", () => {
  const yaml =
    "prompts:\n  - file://prompt.txt\ndefaultTest:\n  assert:\n    - type: javascript\n      value: file://asserts.js\ntests: file://tests.yaml\n";
  const refs = extractConfigRefs(yaml);
  assert.deepEqual(refs.probes, ["asserts.js"]);
});
