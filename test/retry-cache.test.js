const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * round2-B P1 후속 회귀 계약 — 재시도는 promptfoo 캐시를 우회해 실제로 provider를 다시 태워야 한다.
 *
 * verifier catch: retry.test.js는 reeval을 스텁 주입이라 "재시도 콜백이 캐시를 끄는가"를 검증 못 했다.
 * 이 테스트는 실 CLI(check --live --retry 1)를 호출 횟수를 기록하는 fake provider로 구동한다.
 * promptfoo 기본 캐시(활성) 상태에서:
 *  - 수정 전(재시도 콜백이 캐시 미비활성): 초기 1회 호출 후 재시도가 캐시 히트 → provider 총 1회.
 *  - 수정 후(재시도 콜백 PROMPTFOO_CACHE_ENABLED=false): 재시도가 fresh 재생성 → provider 총 2회.
 * 실 LLM 불필요 — provider는 셸 스크립트로 카운터++ 후 고정 실패 출력만 낸다.
 */

const REPO_ROOT = path.resolve(__dirname, "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");

/** 리포 안에 임시 계약 픽스처를 만든다 — npx가 리포 node_modules의 promptfoo를 해석하도록. */
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(REPO_ROOT, ".retrycache-"));
  const counterFile = path.join(dir, "provider-calls.log");

  // exec provider: 호출마다 카운터 파일에 1글자 append 후 고정 실패 출력(JSON 아님 → assert 실패).
  fs.writeFileSync(
    path.join(dir, "provider.sh"),
    '#!/bin/bash\nprintf \'x\' >> "$COUNTER_FILE"\necho "NOT-JSON-ALWAYS-FAIL"\n',
    "utf-8",
  );
  // 프로브: 항상 실패시켜 케이스가 재시도 대상이 되게 한다(채점은 promptfoo가 수행 — Anti-ISC-1).
  fs.writeFileSync(
    path.join(dir, "asserts.js"),
    "module.exports = () => ({ pass: false, score: 0, reason: '테스트 강제 실패' });\n",
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, "prompt.txt"), "입력: {{signal}}\n", "utf-8");
  fs.writeFileSync(
    path.join(dir, "tests.yaml"),
    '- description: "case-1"\n  vars:\n    signal: "테스트 신호"\n',
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "promptfooconfig.yaml"),
    [
      "description: retry-cache-test",
      "prompts:",
      "  - file://prompt.txt",
      "providers:",
      "  - id: 'exec: bash provider.sh'",
      "defaultTest:",
      "  assert:",
      "    - type: javascript",
      "      value: file://asserts.js",
      "tests: file://tests.yaml",
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "ratchet.json"),
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return { dir, counterFile };
}

test("재시도는 캐시를 우회해 provider를 다시 태운다(--retry 1 → provider 2회 호출)", { timeout: 180000 }, () => {
  const { dir, counterFile } = makeFixture();
  try {
    const res = spawnSync("node", [CLI, "check", "--live", "--retry", "1"], {
      cwd: dir,
      env: { ...process.env, COUNTER_FILE: counterFile },
      encoding: "utf-8",
    });

    // 진단용 — 실패 시 stdout/stderr를 보여준다(판정엔 카운터만 사용).
    const calls = fs.existsSync(counterFile) ? fs.readFileSync(counterFile, "utf-8").length : 0;
    assert.equal(
      calls,
      2,
      `provider가 재시도 포함 2회 호출돼야 한다(초기 1 + 재시도 1). 실제 ${calls}회. ` +
        `수정 전 결함이면 1회(재시도가 캐시 히트로 no-op).\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
