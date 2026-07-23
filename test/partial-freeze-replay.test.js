const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveFloor, latestFrozenFor } = require("../dist/floor.js");
const { buildReplayMap, findRegressions } = require("../dist/commands/check.js");

/**
 * round2-B P0 회귀 계약 — 부분 동결 × 결정적 check 구조 모순.
 *
 * 실측 타임라인(FIELD-FEEDBACK-2026-07-23-round2-B 발견 1)을 계약으로 못박는다:
 *  - 스냅샷1(s1)이 caseX(CCTV)를 pass로 동결.
 *  - 이후 스냅샷2(s2, --allow-partial)가 caseX 없이 다른 케이스만 동결(caseX가 live 실패해 미동결).
 *  - deriveFloor는 두 스냅샷 pass 합집합을 floor로 요구 → caseX가 floor에 남는다.
 *  - 수정 전: replay가 최신 단일 스냅샷(s2)만 담아 caseX 미커버 → 항상 반려(오분류).
 *  - 수정 후: replay-map이 caseX를 s1 출력으로 커버 → floor 대조 통과.
 */

const PROMPT = "prompt.txt";

/** s1(caseX+caseY pass) → s2(--allow-partial, caseY만 pass, caseX 부재) 2-스냅샷 상태. */
function makePartialFreezeState() {
  return {
    schemaVersion: 1,
    target: {
      config: "c.yaml",
      prompts: [PROMPT],
      probes: ["asserts.js"],
      tests: "t.yaml",
    },
    activePrompt: PROMPT,
    current: { prompts: {}, probes: {} },
    frozen: [
      {
        id: "s1",
        promptId: PROMPT,
        note: "full freeze",
        promptHash: "",
        probeHash: "PH1",
        cases: {
          caseX: { pass: true, score: 1, output: "CCTV-OUT" },
          caseY: { pass: true, score: 1, output: "Y-OUT-v1" },
        },
      },
      {
        id: "s2",
        promptId: PROMPT,
        note: "partial freeze (caseX live 실패로 미동결)",
        promptHash: "",
        probeHash: "PH1",
        cases: {
          caseY: { pass: true, score: 1, output: "Y-OUT-v2" },
        },
      },
    ],
    failCases: [],
  };
}

test("deriveFloor: 부분 동결 후에도 caseX는 스냅샷 합집합으로 floor에 남는다", () => {
  const floor = deriveFloor(makePartialFreezeState());
  assert.deepEqual(floor.caseIds, ["caseX", "caseY"], "floor = s1∪s2 pass 합집합");
  assert.ok(floor.fromFrozen.includes("caseX"), "caseX는 이전 스냅샷에만 pass로 존재해도 floor 참여");
});

test("버그 재현: 최신 단일 스냅샷(s2)만으로는 caseX를 replay-map에 담지 못한다", () => {
  const state = makePartialFreezeState();
  const latest = latestFrozenFor(state, PROMPT);
  assert.equal(latest.id, "s2");
  assert.ok(
    !Object.prototype.hasOwnProperty.call(latest.cases, "caseX"),
    "최신 스냅샷 s2에는 caseX가 없다 — 수정 전 replay-map이 caseX를 놓쳐 오분류하던 원인",
  );
});

test("수정 ①: replay-map이 스냅샷 합집합으로 floor의 caseX를 s1 출력으로 커버한다", () => {
  const state = makePartialFreezeState();
  const floor = deriveFloor(state);
  const replayMap = buildReplayMap(state.frozen, PROMPT);

  // floor의 모든 caseId가 replay-map에 있어야 한다(THE 수정).
  for (const caseId of floor.caseIds) {
    assert.ok(replayMap.has(caseId), `replay-map이 floor 케이스 ${caseId}를 커버해야 함`);
  }

  const x = replayMap.get("caseX");
  assert.equal(x.output, "CCTV-OUT", "caseX는 그것을 pass로 담은 최신 스냅샷(s1)의 출력");
  assert.equal(x.snapshot.id, "s1", "caseX의 출처 스냅샷은 s1(probeHash 대조 분리용)");
});

test("케이스별 최신 pass 우선: caseY는 더 최근 스냅샷(s2) 출력을 쓴다", () => {
  const replayMap = buildReplayMap(makePartialFreezeState().frozen, PROMPT);
  const y = replayMap.get("caseY");
  assert.equal(y.output, "Y-OUT-v2", "두 스냅샷 모두 caseY pass면 최신 s2 출력이 이긴다");
  assert.equal(y.snapshot.id, "s2");
});

test("수정 ②: replay 불가(스냅샷 미커버)와 진짜 assert 실패를 다른 사유로 분류한다", () => {
  // floor: caseX(커버·pass), caseW(커버·재채점 assert 실패), caseZ(failCase, 어떤 스냅샷에도 pass 없음).
  const state = makePartialFreezeState();
  state.frozen[0].cases.caseW = { pass: true, score: 1, output: "W-OUT" };
  state.failCases = [
    { id: "f1", addedAt: "", promptId: PROMPT, caseRef: "caseZ", expectedPass: true, note: "" },
  ];

  const floor = deriveFloor(state);
  assert.ok(floor.caseIds.includes("caseZ"), "caseZ는 failCase로 floor에 참여");

  const replayMap = buildReplayMap(state.frozen, PROMPT);
  const coveredCaseIds = new Set(replayMap.keys());

  // replay 재채점 결과 시뮬레이션: caseX/caseY pass, caseW는 assert 실패, caseZ는 커버 안 됨(byCase 부재).
  const byCase = new Map([
    ["caseX", { promptId: PROMPT, caseId: "caseX", pass: true, score: 1, output: "CCTV-OUT", failedAsserts: [] }],
    ["caseY", { promptId: PROMPT, caseId: "caseY", pass: true, score: 1, output: "Y-OUT-v2", failedAsserts: [] }],
    ["caseW", { promptId: PROMPT, caseId: "caseW", pass: false, score: 0, output: "W-OUT",
      failedAsserts: [{ type: "javascript", reason: "글자수 초과" }] }],
  ]);

  const regressed = findRegressions(floor, byCase, coveredCaseIds);
  const byId = new Map(regressed.map((r) => [r.caseId, r]));

  assert.ok(!byId.has("caseX") && !byId.has("caseY"), "커버·pass 케이스는 회귀 아님");

  const w = byId.get("caseW");
  const z = byId.get("caseZ");
  assert.ok(w && z, "caseW·caseZ 모두 회귀로 잡혀야 함");
  assert.equal(w.kind, "assert", "caseW는 진짜 assert 실패");
  assert.equal(w.reason, "글자수 초과");
  assert.equal(z.kind, "replay-uncovered", "caseZ는 replay 불가(스냅샷 미커버)");
  assert.notEqual(w.kind, z.kind, "assert 실패와 replay 불가는 다른 사유로 분류");
  assert.notEqual(w.reason, z.reason, "사유 문자열도 구분된다");
});

test("live 모드(coveredCaseIds=null)는 replay 커버리지 검사를 건너뛴다", () => {
  const floor = deriveFloor(makePartialFreezeState());
  // byCase가 전부 pass면 회귀 없음 — null 커버리지에서 uncovered 오탐이 없어야 한다.
  const byCase = new Map([
    ["caseX", { promptId: PROMPT, caseId: "caseX", pass: true, score: 1, output: "x", failedAsserts: [] }],
    ["caseY", { promptId: PROMPT, caseId: "caseY", pass: true, score: 1, output: "y", failedAsserts: [] }],
  ]);
  assert.deepEqual(findRegressions(floor, byCase, null), []);
});
