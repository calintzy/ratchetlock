const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeResults } = require("../dist/promptfoo.js");
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
