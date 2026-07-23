# 새 프롬프트를 계약으로 등록하기 — 5단계 퀵스타트

이 문서 하나만 따라가면 새 프롬프트를 ratchetlock 계약으로 등록할 수 있다. `examples/cardnews`를
역산할 필요 없이, 빈 디렉토리에서 시작해 CI 게이트까지 붙이는 것이 목표다.

`demo.sh`는 이 절차를 시연하는 스크립트지만 등록용이 아니다 — 끝에서 `ratchet.json`을 리셋해
상태를 원상 복구하므로, 실제 등록에는 쓰지 말고 아래 커맨드를 직접 돌려라.

## 준비물

등록하려는 프롬프트가 아래 셋을 갖췄는지 먼저 확인한다(자세한 판단 기준은 [README의 "어떤
프롬프트에 쓰나"](../README.md#어떤-프롬프트에-쓰나)).

- 파일로 저장해 두고 입력만 갈아끼우며 반복 실행하는 프롬프트다.
- 넣어볼 대표 입력이 몇 건 쌓여 있다.
- 출력을 pass/fail로 채점할 수 있다(JSON이 파싱되는가, 금지 표현이 없는가 같은 것).

## 1단계 — 파일 4개를 만든다

한 디렉토리에 아래 네 파일을 둔다. 이 디렉토리가 곧 계약의 루트가 되고, 상태 파일 `ratchet.json`도
여기에 쌓인다.

**① 프롬프트 파일** (`prompt.txt`) — `{{변수}}` 템플릿으로 입력 자리를 비워 둔다.

```
아래 신호를 대중이 읽기 쉬운 카드뉴스 JSON으로 재작성하라.
코드펜스로 감싸지 말고 순수 JSON만 출력한다.

신호:
{{signal}}
```

**② 대표 입력** (`tests.yaml`) — YAML 리스트다. 각 항목은 `description`(케이스 이름)과
`vars`(프롬프트 변수에 꽂힐 값)를 가진다. `description`이 곧 케이스 ID가 되므로 사람이 알아볼 수
있게 짓는다.

```yaml
- description: "OmniRoute (저자 주장 한정어 포함)"
  vars:
    signal: |
      diegosouzapw/OmniRoute가 오늘 GitHub Trending +1,107로 급등했다.
      15~95% 토큰 절감(저자 주장), 95개 MCP 도구를 내장한다.
- description: "Anthropic 그랜트 (날짜·금액 보존)"
  vars:
    signal: |
      Anthropic이 AI for Science 그랜트 2차 모집을 시작했다(2026-07-20 발표).
      선정 팀에 최대 $50,000 크레딧 지급, 마감 8/2.
```

**③ 프로브** (`asserts.js`) — **CommonJS**여야 한다(`module.exports = (output, context) => …`).
ESM이면 로드가 깨진다. `{pass, score, reason}`을 반환한다.

```js
module.exports = (output, context) => {
  const fails = [];
  let raw = String(output).trim();
  if (/^```/.test(raw)) fails.push('코드펜스 출력(금지)');
  try { JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim()); }
  catch { fails.push('JSON 파싱 실패'); }
  return fails.length
    ? { pass: false, score: 0, reason: fails.join(' / ') }
    : { pass: true, score: 1, reason: 'ok' };
};
```

프로브를 프로덕션 검증기와 공유해 이중화 드리프트를 없애는 단일 모듈 패턴, 그리고 문장 분리기의
소수점·약어 함정은 [PROBES.md](PROBES.md)에서 따로 다룬다.

**④ promptfoo 설정** (`promptfooconfig.yaml`) — 위 셋을 연결한다. `providers`는 라이브 평가에
쓸 실제 모델 호출이다(예: `claude` CLI를 부르는 셸 스크립트). 결정적 `check`는 이 provider를
자동으로 replay로 치환하므로, 여기 적는 provider는 `--live`·`freeze` 경로에서만 쓰인다.

```yaml
description: my-prompt
prompts:
  - file://prompt.txt
providers:
  - id: 'exec: bash provider.sh'
    config:
      timeout: 180000
defaultTest:
  assert:
    - type: javascript
      value: file://asserts.js
tests: file://tests.yaml
```

`providers`가 부르는 `provider.sh` 실물도 봐 두면 갭이 사라진다. 규약은 하나뿐이다 — promptfoo가
변수를 채운 최종 프롬프트를 **첫 인자**로 넘겨준다.

```bash
#!/usr/bin/env bash
# $1: promptfoo가 렌더링을 마친 프롬프트 문자열
claude -p "$1"
```

## 2단계 — init

설정을 읽어 프롬프트·프로브·테스트를 뽑고 `ratchet.json`을 만든다. 읽기 전용 스캔이라 모델을
부르지 않는다.

```bash
cd my-prompts/            # promptfooconfig.yaml이 있는 곳
ratchetlock init
```

서브커맨드에 `--help`는 아직 없다(예: `ratchetlock init --help`는 Unknown option 에러). 옵션은 이
문서와 [AGENTS.md](../AGENTS.md)의 커맨드 계약 표를 참고한다.

## 3단계 — check --live로 라이브 통과 확인

실제 모델을 불러 지금 프롬프트가 대표 입력을 통과하는지 본다. 여기서 통과하는 케이스만 다음
단계에서 동결할 자격이 있다.

```bash
ratchetlock check --live
```

`통과:` verdict가 뜨면 전 케이스가 통과한 것이고, `반려:`면 어떤 케이스가 왜 실패했는지 stdout에
나온다. 라이브 통과는 근사치다 — 계약 평가는 프로덕션과 모델·컨텍스트·호출 방식이 다를 수 있어,
통과가 프로덕션 게이트를 대체하지는 않는다([README의 "정직한 한계"](../README.md#정직한-한계)).

최초 등록 시점에는 아직 동결분이 없어 verdict에 `floor 0건`처럼 찍힐 수 있다. 이건 라이브 평가가
안 돈 게 아니다 — **라이브 평가는 실행됐고, 그 결과를 대조할 기준선(floor)이 아직 비어 있다**는
뜻이다. 통과 여부는 그 옆의 회귀 판정으로 본다.

## 4단계 — freeze로 기준선을 동결한다 (전부 통과 / 부분 통과 분기)

지금 통과하는 케이스를 모델 출력 스냅샷째로 얼려 기준선(floor)으로 삼는다.

**전 케이스가 통과한 경우** — 그냥 동결한다.

```bash
ratchetlock freeze --note "초기 등록"
```

**일부만 통과하는 경우** — `--allow-partial`로 통과분만 동결하고, 미동결 케이스를 기록에 남긴다.

```bash
ratchetlock freeze --allow-partial --note "초기 등록 — OmniRoute 미동결"
```

`--allow-partial`은 **신규 등록의 부분 동결용**이지 회귀를 덮는 용도가 아니다. 통과하던 케이스가
깨진 상태를 이걸로 덮으면 도구의 존재 이유가 사라진다. 어떤 케이스를 왜 미동결로 남겼는지는
`--note`나 등록 기록에 남겨 둔다.

## 5단계 — add-fail로 알려진 실패를 영구 가드로 승격한다 (선택)

이 단계는 선택이다 — **이미 겪어 본 실패 유형이 있을 때만** 필요하다. 그런 유형이 없으면 4단계에서
바로 다음 단계로 넘어간다.

이미 겪어 본 실패 유형이 있으면, 그 실패를 재현하는 입력을 `tests.yaml`에 넣고 직전 평가에서 잡힌
실패를 영구 회귀 가드로 등록한다. 한번 등록한 실패 가드는 프롬프트를 어떻게 고쳐도 계속 통과를
요구한다 — 프롬프트 버전을 갈아타도 살아남는다.

```bash
ratchetlock add-fail --from-last "<케이스 이름>"
```

`--from-last`는 직전 평가의 정규화 결과(`.ratchet/last-eval.json`)에서 그 케이스의 실패를 읽어
등록한다. 그래서 3단계의 `check --live`나 4단계 `freeze` 직후에 돌려야 한다.

## 6단계 — 결정적 check로 등록 마무리를 확인한다

동결과 (필요하면) add-fail까지 끝났으면, CI에 맡기기 전에 로컬에서 결정적 `check`가 exit 0인지 직접
확인한다. 방금 만든 계약이 그 자리에서 바로 재현되는지 보는 마지막 게이트다.

```bash
ratchetlock check
echo $?   # 0이면 등록 완료, 0이 아니면 위 단계로 돌아가 확인한다
```

여기까지 하면 등록이 끝난다. 이후 프롬프트를 고칠 때의 루프(수정 → `check --live` → `freeze`)와
새 버전 파일을 만드는 규칙은 [README의 "사용 흐름"](../README.md#사용-흐름)에 있다.

## CI 연동 — 계약을 매 푸시마다 검사한다

결정적 `check`는 모델을 부르지 않고 exit code로 회귀 여부를 알려 주므로 CI에 그대로 물린다.
계약 파일이 바뀌는 푸시에서 `ratchetlock check`가 실패하면 빌드를 막는다.

아래는 실제로 daily-news-reels의 뉴스 재작성 계약에 붙여 돌아가고 있는 워크플로의 골자다. GitHub
Actions ubuntu-latest에서 `npm install --no-save github:calintzy/ratchetlock`이 prepare 훅
빌드까지 정상 작동하는 것을 실측했다(약 1분 40초, 성공).

```yaml
name: contract-check
on:
  push:
    paths:
      - 'contracts/**'
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: install ratchetlock
        run: npm install --no-save github:calintzy/ratchetlock
      - name: check contract
        working-directory: contracts/rewrite
        run: npx ratchetlock check
```

로컬 macOS 일부 npm 버전에서는 git 전역 설치가 devDependencies(typescript) 미설치로 실패할 수
있다. 그 환경은 클론 + `npm link`를 쓴다([README의 설치](../README.md#설치)). npm 레지스트리
배포(v0.2.0)가 되면 이 분기는 사라진다.
