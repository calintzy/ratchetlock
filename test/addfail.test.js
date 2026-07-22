const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isYamlListFormat,
  appendTestsYamlEntry,
  findLastEvalCase,
  buildFailCase,
} = require("../dist/commands/addFail.js");

test("isYamlListFormat은 최상위 시퀀스(리스트) 포맷을 감지한다", () => {
  assert.equal(isYamlListFormat("- description: a\n  vars:\n    signal: x\n"), true);
  assert.equal(isYamlListFormat("tests:\n  - description: a\n"), false);
  assert.equal(isYamlListFormat("# comment\n- description: a\n"), true);
  assert.equal(isYamlListFormat(""), false);
});

test("appendTestsYamlEntry는 신규 케이스를 리스트 끝에 append한다(failCases append 경로)", () => {
  const original = '- description: "기존 케이스"\n  vars:\n    signal: |-\n      기존 시그널\n';
  const updated = appendTestsYamlEntry(original, "새 케이스", "줄1\n줄2\n");

  assert.ok(updated.startsWith(original.trimEnd()));
  assert.match(updated, /description: "새 케이스"/);
  assert.match(updated, /signal: \|-/);
  assert.ok(updated.includes("      줄1"));
  assert.ok(updated.includes("      줄2"));
});

test("appendTestsYamlEntry는 description의 특수문자를 안전하게 이스케이프한다", () => {
  const updated = appendTestsYamlEntry('- description: "a"\n', 'desc: "with quotes"', "sig");
  assert.equal(updated.includes('description: "desc: \\"with quotes\\""'), true);
});

test("findLastEvalCase는 (promptId, caseId) 복합 키로 직전 eval 결과에서 케이스를 찾는다(from-last 읽기)", () => {
  const results = [
    { promptId: "prompt.txt", caseId: "case-1", pass: false, score: 0, output: "x", failedAsserts: [] },
    { promptId: "prompt_v2.txt", caseId: "case-1", pass: true, score: 1, output: "y", failedAsserts: [] },
  ];

  const found = findLastEvalCase(results, "prompt_v2.txt", "case-1");
  assert.ok(found);
  assert.equal(found.output, "y");

  assert.equal(findLastEvalCase(results, "prompt.txt", "case-2"), undefined);
});

test("buildFailCase는 expectedPass:true와 promptId를 포함한 FailCase를 만든다(ISC-4.3 형태)", () => {
  const now = new Date("2026-07-22T09:00:00.000Z");
  const fc = buildFailCase("prompt.txt", "case-1", "note", now);

  assert.equal(fc.promptId, "prompt.txt");
  assert.equal(fc.caseRef, "case-1");
  assert.equal(fc.expectedPass, true);
  assert.equal(fc.addedAt, now.toISOString());
  assert.match(fc.id, /^fail-\d+$/);
});
