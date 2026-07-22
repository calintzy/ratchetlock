# 프로브 작성 가이드

프로브(`asserts.js`)는 모델 출력을 pass/fail로 채점하는 코드다. ratchetlock의 판정은 전부 이
프로브를 거치므로, 프로브가 틀리면 게이트 전체가 틀린다. 이 문서는 실전에서 프로브를 만들다
반복적으로 밟은 지뢰 두 개와 그 회피법을 적는다.

프로브도 시스템의 일부다. ratchetlock을 만들면서 우리 스스로 프로브 버전 스큐 사고를 겪었고
(같은 출력을 두 버전 프로브가 다르게 채점한 사건), 그 경위는 [ARCHITECTURE.md의 "프로브 버전
스큐"](../ARCHITECTURE.md#프로브-버전-스큐--이-도구의-존재-이유를-우리-개발-과정이-증명했다)에
있다. 아래 두 함정도 같은 교훈의 연장이다 — 측정기를 대충 다루면 측정기가 조용히 거짓말을 한다.

## 1. 단일 모듈 패턴 — 프로덕션 검증기와 계약 프로브를 하나로 묶는다

가장 값어치 있는 규칙이다. 이걸 안 지키면 ratchetlock이 막으려는 바로 그 드리프트를 사용 구조가
스스로 만든다.

흔한 실수는 이렇다. 프로덕션 파이프라인에 출력을 검증하는 게이트(`validate.mjs` 같은 것)가 이미
있는데, 계약을 등록하면서 그 검증 로직을 `asserts.js`로 **복사**한다. 이제 같은 규칙이 두 파일에
산다. 프로덕션 검증기의 규칙을 하나 고치면 계약 프로브를 손으로 맞춰야 하고, 어긋나면 아무도
모르게 벌어진다. 실제로 두 곳에 독립 적용한 결과 양쪽에서 같은 부채가 생겼으니 우연이 아니라
구조적 결함이다([FIELD-FEEDBACK 항목 3](FIELD-FEEDBACK-2026-07-23.md)).

해법은 검증 규칙을 **한 CJS 모듈**에 두고 프로덕션과 계약이 모두 그것을 `require`하는 것이다.
`asserts.js`는 그 모듈을 불러 얇게 감싸기만 한다.

```js
// rules.cjs — 프로덕션 검증기와 계약 프로브가 공유하는 유일한 진실
function validate(parsed, signal) {
  const fails = [];
  if (/^```/.test(String(parsed.raw ?? ''))) fails.push('코드펜스 출력(금지)');
  for (const k of ['title', 'body', 'impact']) {
    if (!parsed[k] || !String(parsed[k]).trim()) fails.push(`필수 필드 누락: ${k}`);
  }
  return fails;
}
module.exports = { validate };
```

```js
// asserts.js — 계약 프로브. rules.cjs를 require해 얇게 감싼다.
const { validate } = require('./rules.cjs');

module.exports = (output, context) => {
  const raw = String(output).trim();
  let parsed;
  try { parsed = { raw, ...JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim()) }; }
  catch { return { pass: false, score: 0, reason: 'JSON 파싱 실패' }; }
  const fails = validate(parsed, (context.vars && context.vars.signal) || '');
  return fails.length
    ? { pass: false, score: Math.max(0, 1 - fails.length * 0.25), reason: fails.join(' / ') }
    : { pass: true, score: 1, reason: 'ok' };
};
```

프로덕션 검증기(`validate.mjs`)도 같은 `rules.cjs`를 불러 쓴다. 규칙을 한 곳에서만 고치면 양쪽이
자동으로 같이 움직인다. 이중화가 없으면 드리프트도 없다.

프로브를 직접 로드하는 도구(replay-fidelity 교차검증 등)가 있으므로 공유 모듈도 **CJS로 require
가능해야** 한다. ESM-only 모듈은 지금 경로로는 안 탄다.

## 2. 토크나이저 함정 — 소수점과 약어를 문장 경계로 오인한다

문장 단위로 채점하는 프로브(예: "요약은 3문장 이내")를 쓸 때, 순진한 문장 분리기는 마침표를 전부
문장 끝으로 본다. 그러면 `"3.0%"`의 소수점이나 `"U.S."`의 약어 마침표가 문장 경계로 잘려, 한
문장이 여러 문장으로 잘못 세어진다.

이게 단순한 카운팅 버그로 끝나지 않는다. 실전에서 `summary`의 `"3.0%"`를 분리기가 소수점에서
끊어 "문장 3개"로 세는 바람에 FAIL이 떴고, 그걸 통과시키려고 **프로덕션 프롬프트에** "소수점
수치는 원문 정수 표기를 쓰라"는 지시를 덧붙이는 데까지 갔다([FIELD-FEEDBACK 항목
7](FIELD-FEEDBACK-2026-07-23.md)). 프로브의 결함이 프로덕션 프롬프트 설계로 역류한 것이다.
게이트 정합성은 있었지만(프로덕션 검증기도 같은 분리기를 썼으니), 근본 원인은 분리기 결함이다.

프로브에서 문장을 셀 일이 있으면 소수점과 약어를 마침표 경계에서 제외한다. 아래는 참조 구현이다.

```js
// splitSentences — 소수점("3.0%")·약어("U.S.")의 마침표를 문장 경계로 오인하지 않는다.
function splitSentences(text) {
  const ABBREV = /\b(?:U\.S|U\.K|e\.g|i\.e|etc|vs|Mr|Ms|Dr|Inc|Ltd|Corp)\.$/i;
  const out = [];
  let buf = '';
  // 문장부호(.?!) 뒤에 공백/끝이 오는 지점을 후보 경계로 훑는다.
  const parts = text.split(/([.?!])(\s+|$)/);
  for (let i = 0; i < parts.length; i += 3) {
    const chunk = parts[i] ?? '';
    const punct = parts[i + 1] ?? '';
    const space = parts[i + 2] ?? '';
    buf += chunk + punct;
    if (!punct) continue;
    // 소수점: 마침표 앞뒤가 모두 숫자면 경계 아님 (3.0, 1.5%)
    const beforeDigit = /\d$/.test(chunk);
    const afterDigit = /^\d/.test(parts[i + 3] ?? '');
    if (punct === '.' && beforeDigit && afterDigit) { buf += space; continue; }
    // 약어: 마침표로 끝나는 알려진 약어면 경계 아님 (U.S., etc.)
    if (punct === '.' && ABBREV.test(buf.trimEnd())) { buf += space; continue; }
    out.push(buf.trim());
    buf = '';
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
```

이 정도의 예외 처리를 프로브에 넣어 두면, 문장 카운팅 제약이 프로덕션 프롬프트를 거꾸로 왜곡하는
사태를 막는다. 프로브가 틀렸을 때는 프롬프트가 아니라 프로브를 고치는 것이 맞다.

## 요약

- 프로덕션 검증기와 계약 프로브는 **같은 CJS 모듈을 공유**한다. 복사하면 드리프트가 따라온다.
- 문장을 셀 때는 소수점·약어를 경계에서 제외한다. 프로브 결함을 프롬프트로 우회하지 마라.
- 프로브는 CJS로 `require` 가능해야 한다(replay-fidelity 등 프로브를 직접 로드하는 경로 때문).
