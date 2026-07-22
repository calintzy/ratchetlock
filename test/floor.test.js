const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveFloor, latestFrozenFor } = require("../dist/floor.js");

/** floor 도출 규칙(§3.3 B1) 단위 검증 — 합성 RatchetState로 층위 차이를 못박는다. */

function makeState(overrides) {
  return {
    schemaVersion: 1,
    target: { config: "c.yaml", prompts: ["prompt.txt", "prompt_v2.txt"], probes: ["asserts.js"], tests: "t.yaml" },
    activePrompt: "prompt_v2.txt",
    current: { prompts: {}, probes: {} },
    frozen: [],
    failCases: [],
    ...overrides,
  };
}

test("frozen[]는 promptId-scoped: activePrompt 일치 스냅샷의 pass:true 케이스만 floor에 넣는다", () => {
  const state = makeState({
    activePrompt: "prompt_v2.txt",
    frozen: [
      { id: "s1", promptId: "prompt_v2.txt", note: "", promptHash: "", probeHash: "",
        cases: { A: { pass: true, score: 1, output: "{}" }, B: { pass: false, score: 0, output: "x" } } },
      { id: "s2", promptId: "prompt.txt", note: "", promptHash: "", probeHash: "",
        cases: { C: { pass: true, score: 1, output: "{}" } } },
    ],
  });
  const floor = deriveFloor(state);
  assert.deepEqual(floor.fromFrozen, ["A"], "activePrompt(prompt_v2.txt)의 pass:true 케이스 A만");
  assert.ok(!floor.caseIds.includes("B"), "pass:false 케이스 B는 제외");
  assert.ok(!floor.caseIds.includes("C"), "다른 프롬프트(prompt.txt) 스냅샷의 C는 제외(promptId-scoped)");
});

test("ISC-3.5 (B1): failCase는 프롬프트-무관 — promptId=prompt.txt failCase가 activePrompt=prompt_v2.txt에서도 floor에 참여", () => {
  const state = makeState({
    activePrompt: "prompt_v2.txt",
    frozen: [
      { id: "s1", promptId: "prompt_v2.txt", note: "", promptHash: "", probeHash: "",
        cases: { A: { pass: true, score: 1, output: "{}" } } },
    ],
    // v1(prompt.txt)에서 잡힌 실패를 add-fail로 등록한 것. promptId는 provenance일 뿐.
    failCases: [
      { id: "f1", addedAt: "", promptId: "prompt.txt", caseRef: "D", expectedPass: true, note: "" },
    ],
  });
  const floor = deriveFloor(state);
  assert.ok(
    floor.caseIds.includes("D"),
    "v1에서 잡은 failCase D는 v2 전환 후에도 floor에 남아야 한다(add-fail이 no-op이 아님)",
  );
  assert.deepEqual(floor.fromFailCases, ["D"]);
  assert.deepEqual(floor.caseIds, ["A", "D"], "합집합 = frozen(A) ∪ failCase(D)");
});

test("expectedPass:false인 failCase는 floor에 참여하지 않는다", () => {
  const state = makeState({
    failCases: [{ id: "f1", addedAt: "", promptId: "prompt.txt", caseRef: "D", expectedPass: false, note: "" }],
  });
  assert.deepEqual(deriveFloor(state).caseIds, []);
});

test("latestFrozenFor는 지정 프롬프트의 가장 최근 스냅샷을 돌려준다", () => {
  const state = makeState({
    frozen: [
      { id: "old", promptId: "prompt_v2.txt", note: "", promptHash: "", probeHash: "", cases: {} },
      { id: "new", promptId: "prompt_v2.txt", note: "", promptHash: "", probeHash: "", cases: {} },
      { id: "other", promptId: "prompt.txt", note: "", promptHash: "", probeHash: "", cases: {} },
    ],
  });
  assert.equal(latestFrozenFor(state, "prompt_v2.txt").id, "new");
  assert.equal(latestFrozenFor(state, "prompt.txt").id, "other");
  assert.equal(latestFrozenFor(state, "nope"), undefined);
});
