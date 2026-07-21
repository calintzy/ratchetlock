#!/usr/bin/env node
"use strict";

/**
 * promptfoo exec 프로바이더(결정적 check용, C2) — 동결된 출력 스냅샷을 되돌려준다.
 * 실 LLM을 호출하지 않는다. check --live일 때만 provider.sh(진짜 LLM)를 탄다.
 *
 * 프로토콜(promptfoo custom-script provider, 실측 확인 — .ratchet/probe 실험):
 *   argv[2] = 렌더링된 프롬프트 문자열
 *   argv[3] = provider config JSON
 *   argv[4] = context JSON: { vars, prompt, test: { description, vars, assert, ... }, ... }
 *
 * 매칭 키(구현 시 결정, Open Questions 해소): description 우선, vars 직렬화 sha256 폴백.
 * 계획 초안은 "vars 해시 우선·description 보조"였으나, ratchet.json §3.3 스키마의
 * frozen[].cases가 description을 딕셔너리 키로 직접 쓰고(예: "07-21 ② fastmcp": {...}),
 * src/promptfoo.ts의 CaseResult.caseId 추출도 description 우선·vars 해시 폴백이다.
 * replay 파일(RATCHETLOCK_REPLAY_FILE)은 frozen[].cases를 그대로 옮긴 것이므로
 * 여기서도 같은 순서로 매칭해야 키가 어긋나지 않는다(어댑터·replay가 같은 폴백 규칙을 공유).
 */
const fs = require("node:fs");
const path = require("node:path");
const { hashContent } = require(path.join(__dirname, "state.js"));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const replayFilePath = process.env.RATCHETLOCK_REPLAY_FILE;
if (!replayFilePath) {
  fail("RATCHETLOCK_REPLAY_FILE 환경변수가 설정되지 않았습니다.");
}

let replayMap;
try {
  replayMap = JSON.parse(fs.readFileSync(replayFilePath, "utf-8"));
} catch (error) {
  fail(`replay 파일을 읽을 수 없습니다(${replayFilePath}): ${error.message}`);
}

let context;
try {
  context = JSON.parse(process.argv[4] || "{}");
} catch (error) {
  fail(`promptfoo context 파싱 실패: ${error.message}`);
}

const description = context.test && context.test.description;
const varsKey = hashContent(JSON.stringify((context.test && context.test.vars) || context.vars || {}));

const caseKey =
  typeof description === "string" &&
  description.length > 0 &&
  Object.prototype.hasOwnProperty.call(replayMap, description)
    ? description
    : varsKey;

if (!Object.prototype.hasOwnProperty.call(replayMap, caseKey)) {
  fail(
    `replay 출력을 찾을 수 없습니다: description=${JSON.stringify(description)} varsKey=${varsKey}`,
  );
}

process.stdout.write(replayMap[caseKey]);
