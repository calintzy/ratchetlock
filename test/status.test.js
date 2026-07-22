const test = require("node:test");
const assert = require("node:assert/strict");
const { computeStatus } = require("../dist/commands/status.js");

/**
 * status 드리프트 판정(M3) — 동결 스냅샷 해시를 디스크 라이브 해시와 대조한다.
 * 이전 버그: current.prompts/probes(동결 시점 기록)끼리 비교해 드리프트가 항상 false였다.
 * computeStatus는 순수 함수(라이브 해시 주입)이므로 파일 IO 없이 판정을 못박는다.
 */

function makeState() {
  return {
    schemaVersion: 1,
    target: { config: "c.yaml", prompts: ["p.txt"], probes: ["a.js"], tests: "t.yaml" },
    activePrompt: "p.txt",
    current: { prompts: { "p.txt": "sha256:P" }, probes: { "a.js": "sha256:PROBE" } },
    frozen: [
      { id: "s1", promptId: "p.txt", note: "", promptHash: "sha256:P", probeHash: "sha256:FROZEN", cases: {} },
    ],
    failCases: [],
  };
}

test("freeze 후 프로브 파일이 바뀌면 probeDrift=true (라이브 해시 != 동결 probeHash)", () => {
  const report = computeStatus(makeState(), { promptHash: "sha256:P", probeHash: "sha256:CHANGED" });
  assert.equal(report.probeDrift, true);
});

test("프로브 파일이 동결 시점과 같으면 probeDrift=false", () => {
  const report = computeStatus(makeState(), { promptHash: "sha256:P", probeHash: "sha256:FROZEN" });
  assert.equal(report.probeDrift, false);
});

test("프롬프트 파일이 바뀌면 promptDrift=true", () => {
  const report = computeStatus(makeState(), { promptHash: "sha256:OTHER", probeHash: "sha256:FROZEN" });
  assert.equal(report.promptDrift, true);
});

test("동결 스냅샷이 없으면 드리프트는 판정하지 않는다(false)", () => {
  const state = makeState();
  state.frozen = [];
  const report = computeStatus(state, { promptHash: "sha256:X", probeHash: "sha256:Y" });
  assert.equal(report.promptDrift, false);
  assert.equal(report.probeDrift, false);
});

test("computeStatus는 라이브 해시를 currentPromptHash/currentProbeHash로 보고한다", () => {
  const report = computeStatus(makeState(), { promptHash: "sha256:LIVE_P", probeHash: "sha256:LIVE_PROBE" });
  assert.equal(report.currentPromptHash, "sha256:LIVE_P");
  assert.equal(report.currentProbeHash, "sha256:LIVE_PROBE");
});
