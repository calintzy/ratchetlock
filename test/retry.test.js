const test = require("node:test");
const assert = require("node:assert/strict");
const {
  retryFailedLiveCases,
  buildFilterPattern,
  parseRetry,
} = require("../dist/retry.js");

/**
 * round2-B P1 회귀 계약 — 라이브 케이스별 재시도.
 *
 * 실 LLM 없이 reeval 함수를 주입해 "첫 시도 실패 → 재시도 통과" 시퀀스를 스크립트한다.
 * 채점(pass/fail)은 여전히 promptfoo 몫이라 여기선 CaseResult를 직접 구성한다 —
 * 이 모듈은 재평가 지시·병합만 하고 판정을 재구현하지 않는다(Anti-ISC-1).
 */

const PROMPT = "prompt.txt";

function row(caseId, pass) {
  return {
    promptId: PROMPT,
    caseId,
    pass,
    score: pass ? 1 : 0,
    output: `${caseId}-out`,
    failedAsserts: pass ? [] : [{ type: "javascript", reason: "형식 위반" }],
  };
}

test("① 실패 케이스만 재평가되고 통과 케이스는 reeval에 넘어가지 않는다", async () => {
  const initial = [row("caseA", true), row("caseB", false), row("caseC", true)];
  const seenCalls = [];
  const reeval = async (caseIds) => {
    seenCalls.push([...caseIds]);
    return caseIds.map((id) => row(id, true)); // 재시도에서 통과
  };

  const outcome = await retryFailedLiveCases(initial, PROMPT, 3, reeval);

  assert.deepEqual(seenCalls, [["caseB"]], "실패한 caseB만 재평가 — caseA/caseC는 재호출 안 됨");
  assert.equal(outcome.finalFailed.length, 0);
  assert.equal(outcome.passedOnRetry.get("caseB"), 1, "caseB는 1회차 재시도에 통과");
  const b = outcome.results.find((r) => r.caseId === "caseB");
  assert.equal(b.pass, true, "병합 결과에서 caseB가 pass로 갱신됨");
  const a = outcome.results.find((r) => r.caseId === "caseA");
  assert.equal(a.pass, true, "통과 케이스는 원본 유지");
});

test("② N회 후에도 실패면 최종 실패로 남는다", async () => {
  const initial = [row("caseA", true), row("caseB", false)];
  let calls = 0;
  const reeval = async (caseIds) => {
    calls++;
    return caseIds.map((id) => row(id, false)); // 계속 실패
  };

  const outcome = await retryFailedLiveCases(initial, PROMPT, 2, reeval);

  assert.equal(calls, 2, "정확히 N=2회 재시도");
  assert.deepEqual(outcome.finalFailed, ["caseB"], "caseB는 최종 실패");
  assert.equal(outcome.passedOnRetry.has("caseB"), false);
  const b = outcome.results.find((r) => r.caseId === "caseB");
  assert.equal(b.pass, false, "병합 결과에서 caseB는 여전히 fail");
});

test("③ N=0이면 재시도 없이 초기 결과와 동일하다(하위호환)", async () => {
  const initial = [row("caseA", true), row("caseB", false)];
  let called = false;
  const reeval = async () => {
    called = true;
    return [];
  };

  const outcome = await retryFailedLiveCases(initial, PROMPT, 0, reeval);

  assert.equal(called, false, "N=0이면 reeval 미호출");
  assert.deepEqual(outcome.results, initial, "결과는 초기와 동일");
  assert.deepEqual(outcome.finalFailed, ["caseB"], "실패 케이스는 그대로 실패로 보고");
  assert.equal(outcome.passedOnRetry.size, 0);
});

test("일부만 통과: 2건 실패 중 1건은 재시도 통과, 1건은 최종 실패", async () => {
  const initial = [row("caseA", false), row("caseB", false)];
  const reeval = async (caseIds) =>
    caseIds.map((id) => row(id, id === "caseA")); // caseA만 통과

  const outcome = await retryFailedLiveCases(initial, PROMPT, 2, reeval);

  assert.equal(outcome.passedOnRetry.get("caseA"), 1);
  assert.deepEqual(outcome.finalFailed, ["caseB"]);
});

test("타 프롬프트 행은 재시도 대상·병합에서 제외된다", async () => {
  const other = { ...row("caseB", false), promptId: "other.txt" };
  const initial = [row("caseA", false), other];
  const seen = [];
  const reeval = async (caseIds) => {
    seen.push([...caseIds]);
    return caseIds.map((id) => row(id, true));
  };

  const outcome = await retryFailedLiveCases(initial, PROMPT, 1, reeval);

  assert.deepEqual(seen, [["caseA"]], "대상 프롬프트 실패분(caseA)만 재시도 — 타 프롬프트 제외");
  const preserved = outcome.results.find((r) => r.promptId === "other.txt");
  assert.equal(preserved.pass, false, "타 프롬프트 행은 원본 그대로 보존");
});

test("buildFilterPattern은 앵커링하고 정규식 특수문자를 이스케이프한다", () => {
  const p = buildFilterPattern(["case.1", "case+2"]);
  assert.equal(p, "^(case\\.1|case\\+2)$");
  // 이스케이프된 패턴은 리터럴로만 매칭한다.
  const re = new RegExp(p);
  assert.ok(re.test("case.1"));
  assert.ok(!re.test("caseX1"), "'.'가 임의 문자로 새지 않음");
});

test("parseRetry: 미지정은 0, 정수는 그대로, 음수·비정수는 거부", () => {
  assert.equal(parseRetry(undefined), 0);
  assert.equal(parseRetry("3"), 3);
  assert.throws(() => parseRetry("-1"), /0 이상의 정수/);
  assert.throws(() => parseRetry("1.5"), /0 이상의 정수/);
  assert.throws(() => parseRetry("abc"), /0 이상의 정수/);
});
