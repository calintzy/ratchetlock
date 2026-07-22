const test = require("node:test");
const assert = require("node:assert/strict");
const { decideFreeze, freezeId, combinedProbeHash } = require("../dist/commands/freeze.js");

function makeResults() {
  return [
    {
      promptId: "prompt_v2.txt",
      caseId: "case-1",
      pass: true,
      score: 1,
      output: '{"title":"a"}',
      failedAsserts: [],
    },
    {
      promptId: "prompt_v2.txt",
      caseId: "case-2",
      pass: true,
      score: 1,
      output: '{"title":"b"}',
      failedAsserts: [],
    },
    {
      promptId: "prompt_v2.txt",
      caseId: "case-3",
      pass: false,
      score: 0,
      output: '{"title":"c"}',
      failedAsserts: [{ type: "javascript", reason: "실패" }],
    },
    // 다른 프롬프트(prompt.txt)의 실패는 prompt_v2.txt 판정에 영향을 주면 안 됨
    { promptId: "prompt.txt", caseId: "case-1", pass: false, score: 0, output: "", failedAsserts: [] },
  ];
}

test("require-green: 실패 케이스 존재 시 --allow-partial 없이 거부한다(ISC-4.2 형태)", () => {
  const decision = decideFreeze(makeResults(), "prompt_v2.txt", false);
  assert.equal(decision.ok, false);
  assert.deepEqual(decision.frozenCases, {});
  assert.deepEqual(decision.unfrozenCaseIds, ["case-3"]);
});

test("--allow-partial: 통과분만 동결하고 출력 스냅샷을 보존한다(ISC-4.4 형태)", () => {
  const decision = decideFreeze(makeResults(), "prompt_v2.txt", true);
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.unfrozenCaseIds, ["case-3"]);
  assert.equal(Object.keys(decision.frozenCases).length, 2);
  assert.equal(decision.frozenCases["case-1"].output, '{"title":"a"}');
  assert.ok(decision.frozenCases["case-1"].output.length > 0);
  assert.equal(decision.frozenCases["case-1"].pass, true);
  assert.equal(decision.frozenCases["case-1"].score, 1);
});

test("decideFreeze는 대상 프롬프트가 아닌 케이스는 판정에서 제외한다", () => {
  const decision = decideFreeze(makeResults(), "prompt_v2.txt", false);
  assert.equal(decision.unfrozenCaseIds.includes("case-1"), false);
});

test("freezeId는 콜론을 하이픈으로 치환한 ISO 형식을 낸다(§3.3 스키마 예시)", () => {
  const id = freezeId(new Date("2026-07-22T09:00:00.000Z"));
  assert.equal(id, "2026-07-22T09-00-00Z");
});

test("combinedProbeHash는 키 순서에 무관하게 결정적이다", () => {
  const a = combinedProbeHash({ "asserts.js": "sha256:aaa", "extra.js": "sha256:bbb" });
  const b = combinedProbeHash({ "extra.js": "sha256:bbb", "asserts.js": "sha256:aaa" });
  assert.equal(a, b);
});

test("combinedProbeHash는 내용이 다르면 다른 해시를 낸다", () => {
  const a = combinedProbeHash({ "asserts.js": "sha256:aaa" });
  const b = combinedProbeHash({ "asserts.js": "sha256:zzz" });
  assert.notEqual(a, b);
});
