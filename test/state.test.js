const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { loadState, saveState, hashContent, hashFile } = require("../dist/state.js");

test("saveState/loadState 라운드트립", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchetlock-"));
  const filePath = join(dir, "ratchet.json");
  const state = {
    schemaVersion: 1,
    target: {
      config: "promptfooconfig.yaml",
      prompts: ["prompt.txt"],
      probes: ["asserts.js"],
      tests: "tests.yaml",
    },
    activePrompt: "prompt.txt",
    current: { prompts: {}, probes: {} },
    frozen: [],
    failCases: [],
  };

  saveState(filePath, state);
  const loaded = loadState(filePath);

  assert.deepEqual(loaded, state);
  rmSync(dir, { recursive: true, force: true });
});

test("hashContent는 같은 입력에 대해 결정적 sha256 해시를 낸다", () => {
  const h1 = hashContent("hello");
  const h2 = hashContent("hello");
  assert.equal(h1, h2);
  assert.match(h1, /^sha256:[0-9a-f]{64}$/);
});

test("hashContent는 다른 입력에 대해 다른 해시를 낸다", () => {
  assert.notEqual(hashContent("hello"), hashContent("world"));
});

test("hashFile은 파일 내용의 sha256 해시를 낸다", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchetlock-"));
  const filePath = join(dir, "sample.txt");
  writeFileSync(filePath, "test content");

  assert.equal(hashFile(filePath), hashContent("test content"));
  rmSync(dir, { recursive: true, force: true });
});
