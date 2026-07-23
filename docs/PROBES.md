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

### 공유 모듈의 경계 — 무엇을 내리고 무엇을 각자 유지하는가

단일 모듈 패턴이 통했다고 해서 검증 로직 전부를 공유 모듈로 내려야 하는 것은 아니다. 실전에서 나온
경계는 이렇다 — **개별 항목(기사·케이스) 단위로 판정하는 규칙**은 공유 모듈(`rules.cjs`)로 내리고,
**최상위 문서 구조 검사·캡션 규칙·위반 메시지의 접두(`[사실성]`/`[구조]` 같은 분류 라벨)**는 프로덕션
검증기와 계약 프로브가 각자 유지한다. 후자를 억지로 합치면 두 소비자가 서로 다른 맥락(프로덕션 로그
형식 vs 계약 프로브의 `reason` 문자열)에 같은 출력 포맷을 강요받는다.

각자 유지하는 부분은 **label 주입**으로 감싼다 — 공유 모듈은 원시 위반 목록만 반환하고, 그걸 부르는
쪽(프로덕션 검증기 또는 `asserts.js`)이 자기 맥락에 맞는 접두·포맷을 씌우는 얇은 래퍼를 각자 둔다.
공유 모듈 자체는 표시 포맷에 대해 아무것도 모른다.

경계를 가르는 기준은 하나다 — **입력 단위가 같은가.** 개별 항목 규칙은 두 소비자 모두 "항목 하나"를
입력으로 받으니 공유가 자연스럽다. 문서 최상위 구조나 표시 포맷은 소비자마다 다루는 단위가
다르므로(파일 하나 전체 vs 개별 케이스) 억지로 내리면 오히려 두 소비자를 부자연스럽게 결합한다
([FIELD-FEEDBACK round2-B 발견 3](FIELD-FEEDBACK-2026-07-23-round2-B.md)).

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

## 3. vars 어댑터 패턴 — lint는 항목+vars 단위다, 문서 전체가 아니다

`lint`는 계약에 등록된 프로브를 그대로 재사용해 새 출력 1건을 검사한다. 프로브가 원본 대조형이라면
(생성일·스타 수·저자 주장 여부 같은 판정 메타를 `vars`로 받는 방식) `lint`도 그 `vars`가 있어야
작동한다. `vars` 없이 렌더된 문서 하나를 통째로 넣으면 그 프로브들은 스킵되고, 위반이 있어도 exit
0으로 지나간다.

라이브 표면(예: 이미 배포된 브리핑 md)에는 그 vars가 텍스트 안에 없다 — 원본 메타는 생성 시점의
소스에만 있고, md는 이미 렌더링을 거친 결과다. 이 문서 전체를 lint로 검사하고 싶다면 lint 앞단에
**어댑터**를 하나 둔다: 문서를 파싱해 항목 단위로 쪼개고, 표면 정보(⭐ 옆 숫자, "신규 공개" 같은
문구)로 vars를 추정해 `(출력, vars)` 페어를 만든 다음 그걸 `lint --vars`에 넣는다. 실전에서 브리핑
계약의 수제 린터가 하던 일이 이 파싱·추정이다 — 그 로직을 lint 파이프라인 앞단의 어댑터로 옮기면
lint가 문서 전체 검사를 흡수한다.

이 어댑터를 만들지와 별개로 인정해야 할 경계가 하나 있다. **계약 프로브(원본 대조로 회귀를 잡는
것)와 라이브 표면 린터(렌더된 결과물을 표면 패턴으로 사후 점검하는 것)는 입력 모델이 다른 별개의
도구일 수 있다.** 항목 단위+vars로 도는 프로브를 문서 전체 검사기로 그대로 대체하려 하면 이 지점에서
항상 막힌다([FIELD-FEEDBACK round2 항목 3](FIELD-FEEDBACK-2026-07-23-round2.md)).

## 요약

- 프로덕션 검증기와 계약 프로브는 **같은 CJS 모듈을 공유**한다. 복사하면 드리프트가 따라온다. 다만
  개별 항목 규칙만 내리고, 최상위 구조·표시 포맷은 각자 유지한다.
- 문장을 셀 때는 소수점·약어를 경계에서 제외한다. 프로브 결함을 프롬프트로 우회하지 마라.
- 프로브는 CJS로 `require` 가능해야 한다(replay-fidelity 등 프로브를 직접 로드하는 경로 때문).
- `lint`는 프로브와 같은 입력 단위(항목+vars)일 때만 유효하다. vars 없이 문서 전체를 검사하려면
  어댑터가 필요하다.
