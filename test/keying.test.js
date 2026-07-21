const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeResults } = require("../dist/promptfoo.js");
const abFixture = require("../examples/cardnews/fixtures/ab.json");

test("(promptId, caseId) 복합 키로 프롬프트 2종의 동일 caseId가 별개 키로 공존한다(ISC-2.3, C1)", () => {
  const results = normalizeResults(abFixture);
  assert.equal(results.length, 10, "ab.json은 프롬프트 2종 x 케이스 5건 = 10행이어야 함");

  const keys = results.map((r) => `${r.promptId}::${r.caseId}`);
  const uniqueKeys = new Set(keys);
  assert.equal(uniqueKeys.size, 10, "10개 행 전부 별개의 (promptId, caseId) 키를 가져야 함");

  const caseId = "07-21 ① OmniRoute (저자 주장 한정어 포함)";
  assert.ok(uniqueKeys.has(`prompt.txt::${caseId}`));
  assert.ok(uniqueKeys.has(`prompt_v2.txt::${caseId}`));

  // 같은 caseId라도 promptId가 다르면 pass 여부가 다를 수 있음(floor가 promptId로 오판하면 안 되는 이유)
  const v1Row = results.find((r) => r.promptId === "prompt.txt" && r.caseId.includes("fastmcp"));
  const v2Row = results.find((r) => r.promptId === "prompt_v2.txt" && r.caseId.includes("fastmcp"));
  assert.ok(v1Row && v2Row);
  assert.notEqual(v1Row.pass, v2Row.pass, "v1은 fail, v2는 pass — caseId만으로 키잉하면 오판");
});
