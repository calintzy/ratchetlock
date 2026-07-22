const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

/**
 * replay 충실도 계약(architect 재발 방지) — 프로브 버전 스큐 재발 방지.
 *
 * baseline.regraded.json은 baseline.json 출력을 현재 asserts.js로 **replay 경로(promptfoo)**로 재채점한 기록이다.
 * 이 테스트는 같은 출력을 asserts.js **직접 로드**로 재채점해, 두 경로의 score·failedAsserts 집합이
 * assert 단위로 일치함을 단언한다. asserts.js가 바뀌면 직접 채점이 갈려 이 테스트가 깨지고,
 * 그러면 baseline.regraded.json 재생성을 강제한다 → fixture와 프로브가 항상 같은 버전으로 묶인다.
 *
 * NOTE(Anti-ISC-1 예외): ratchetlock **소스**는 asserts.js를 require하지 않는다(채점은 promptfoo가 한다).
 * 여기서의 직접 로드는 "replay 채점 == 프로브 원본 채점"을 교차검증하기 위한 **테스트 전용** 예외다.
 * (H3) RyanVault 사본이 아니라 examples/cardnews의 CJS 사본만 로드한다.
 */

const assertsPath = path.resolve(__dirname, "../examples/cardnews/asserts.js");
const grade = require(assertsPath); // module.exports = (output, context) => {pass, score, reason}
const baseline = require("../examples/cardnews/fixtures/baseline.json").results.results;
const regraded = require("../examples/cardnews/fixtures/baseline.regraded.json");

/** asserts.js 직접 채점 결과에서 개별 fail 문자열 집합을 뽑는다(promptfoo reason과 같은 " / " 구분). */
function failsFromDirectGrade(result) {
  if (result.pass) return [];
  return String(result.reason || "")
    .split(" / ")
    .filter((s) => s && s !== "ok");
}

test("baseline.regraded.json이 baseline.json 5건(prompt.txt)을 모두 커버한다", () => {
  assert.equal(regraded.length, 5);
  assert.equal(baseline.length, 5);
});

for (const row of baseline) {
  const caseId = row.testCase.description;
  test(`replay 충실도: "${caseId.slice(0, 24)}" — 직접 채점 == baseline.regraded.json`, () => {
    const record = regraded.find((r) => r.caseId === caseId);
    assert.ok(record, `baseline.regraded.json에 ${caseId} 기록이 있어야 함`);

    const signal = (row.testCase.vars && row.testCase.vars.signal) || (row.vars && row.vars.signal) || "";
    const direct = grade(row.response.output, { vars: { signal } });

    assert.equal(direct.pass, record.pass, `${caseId}: pass 불일치`);
    assert.equal(direct.score, record.score, `${caseId}: score 불일치(프로브-fixture 스큐?)`);
    assert.deepEqual(
      failsFromDirectGrade(direct).sort(),
      [...record.fails].sort(),
      `${caseId}: 실패 assert 집합 불일치`,
    );
  });
}
