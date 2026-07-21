# ratchetlock — 구현 계획

> 프롬프트 계약 래칫 CLI. 반복 사용하는 LLM 프롬프트를 코드처럼 회귀 관리한다.
> promptfoo를 평가 엔진으로 쓰고, promptfoo에 없는 "래칫 레이어"만 만든다.

- **위치**: `~/ClaudeProject/ratchetlock`
- **공개**: GitHub `calintzy` public (처음부터)
- **용도**: 취업 포트폴리오 (AI 엔지니어링 포지셔닝)
- **규모**: agentscore급 (1~2주, fresh context 1개 단위 티켓 6개)

---

## 1. Context (왜 이 도구인가)

promptfoo는 프롬프트를 한 번 평가한다 — 입력을 넣고, assert를 돌리고, pass/fail을 리포트한다. **상태가 없다.** 어제 통과했던 계약이 오늘 깨졌는지 promptfoo는 모른다. 프롬프트를 "개선"했는데 예전에 잡았던 실패가 되살아났는지도 모른다.

2026-07-21 카드뉴스 프롬프트 파일럿(RyanVault/06-BRIEFINGS/cardnews/prompt-pilot)에서 이 공백이 실측으로 드러났다:

- v1(스펙 그대로) 0/5 → v2(출력 규칙 3줄 추가) 4/5. **래칫 원칙**(기존 문구 수정 없이 제약만 추가)으로 회복.
- 발견 ①: 형식 계약(존댓말·enum·JSON 스키마)은 이진 assert가 완벽히 잡는다.
- 발견 ③: **측정기(assert)도 래칫 대상** — 프롬프트와 프로브를 함께 버전 관리하지 않으면 프로브가 조용히 약해진다.

ratchetlock은 promptfoo 위에 **네 가지 상태 레이어**를 얹는다:

1. **동결(freeze)** — 통과한 계약(프롬프트 버전 + 프로브 세트 + **케이스별 모델 출력 스냅샷**)을 얼린다. 출력을 함께 저장하는 게 결정성의 핵심이다(아래 결정성 정책).
2. **실패 누적(add-fail / ratchet)** — 한번 잡은 실패 케이스를 영구 회귀 테스트로 승격한다. 다시는 놓치지 않는다.
3. **프롬프트·프로브 동시 버전 관리** — 동결 시점의 프롬프트 해시와 프로브 해시를 함께 기록해 프로브 드리프트를 감지한다.
4. **check 게이트** — 개선안이 동결된 계약을 깨면 non-zero로 반려한다. CI에 물릴 수 있다.

**결정성 정책(핵심 설계 결정)**: 평가 대상이 LLM이라 매번 재호출하면 게이트가 플레이키하다(exec claude 프로바이더는 temperature·seed 제어 불가). 그래서 기본 `check`는 **LLM을 재호출하지 않는다** — 동결 시 저장한 출력 스냅샷에 **현재 프로브만 재적용**해 결정적으로 판정한다(프로브 드리프트·프롬프트 해시 드리프트 검출 모델). 프롬프트를 실제로 바꿔 모델 출력이 여전히 통과하는지 보는 **라이브 재평가는 `check --live`로 분리**한다(비결정적, CI 게이트가 아니라 개발자 확인용). 이 분리가 ratchetlock을 "재현 가능한 회귀 가드"로 만든다 — ARCHITECTURE.md에서 정면으로 다룬다.

핵심 가설(파일럿으로 지지됨): **promptfoo에 없는 것 = 통과 계약 동결 · 실패 케이스 누적 · 프롬프트/프로브 동시 버전 관리.** 이게 도구의 차별화 코어다.

**차별화 근거 확정**(공식 문서·소스 검증): promptfoo에는 baseline 스냅샷·동결·실패 케이스의 영구 회귀 승격(래칫) 개념이 **없다**. 관련 이슈(#428, #5847)도 미해결. 통용되는 회귀 방지는 사용자가 직접 짜는 워크플로우(`--filter-failing`, `jq`로 pass rate 추출, `promptfoo-action`의 매 PR diff — 이것도 "동결"이 아니라 매번 재계산)뿐이다. ratchetlock은 이 사용자 워크플로우를 도구화한다.

---

## 2. Guardrails

### Must Have
- promptfoo를 **평가 엔진으로만** 사용. eval 실행·assert 적용·리포팅은 promptfoo가 한다.
- 래칫 상태는 **단일 JSON 파일**(`ratchet.json`)에 저장. stdlib `fs` + `JSON`만 사용.
- check 게이트는 promptfoo의 종료 코드에 의존하지 않고 **eval 결과 JSON을 직접 파싱해 자체 판정**한다 (게이트 로직을 우리가 소유 → 외부 exit code 불확실성 제거, floor 대조가 우리 책임).
- 사용자의 프롬프트 원본 파일은 **절대 수정하지 않는다** (래칫은 제약만 추가). 상태 변이는 `ratchet.json`과 append-only 테스트 파일에만.
- 카드뉴스 프롬프트 실적용 예제로 before/after 실적을 만든다.
- ARCHITECTURE.md("왜" 중심) + 자연스러운 산문 README (채용 담당자가 읽는 글).

### Must NOT Have
- promptfoo가 하는 일(평가 실행·assert 채점·리포트) **재구현 금지**.
- DB 금지 (SQLite·Postgres·ORM 어느 것도).
- 의미 왜곡 검출(LLM 루브릭)은 **MVP 제외** — 로드맵에만.
- 요청 안 한 추상화·유연성·설정 옵션 추가 금지 (YAGNI 사다리 준수).

---

## 3. 아키텍처 개요

### 3.1 스택 결정

| 항목 | 결정 | 근거 (YAGNI 사다리) |
|------|------|------|
| 언어 | TypeScript / Node | promptfoo가 npm 도구다. 같은 런타임에서 `promptfoo eval`을 자식 프로세스로 호출하고 JSON을 파싱하는 게 가장 단순하다. 플래그십 프로브(asserts.js)도 이미 Node다. agentscore(Python)와 달리 여기선 Node가 자연스러운 선택. |
| CLI 파싱 | stdlib `node:util` `parseArgs` | 서브커맨드 5개엔 commander/yargs 불필요. Node 25 로컬 확인됨. 의존성 0. |
| 상태 저장 | 단일 `ratchet.json` (stdlib `fs`) | DB 금지 제약. JSON은 stdlib 네이티브. promptfoo config만 YAML(사용자 소유). |
| promptfoo 호출 | `child_process.execFile('npx',['promptfoo','eval',...])` | 내부 node API(불안정) 대신 CLI + JSON 출력(안정 계약)을 소비. |
| 해시 | stdlib `crypto.createHash('sha256')` | 프롬프트/프로브 버전 식별. 의존성 0. |
| 테스트 | stdlib `node --test` | jest/vitest 불필요. |
| 빌드 | `tsc` → `dist/`, `bin` 엔트리 | devDeps = typescript, @types/node 뿐. |

**런타임 의존성: `promptfoo` 1개.** devDeps: typescript, @types/node. 린 구성 자체가 포트폴리오 신호(YAGNI 규율).

### 3.2 파일 레이아웃

```
ratchetlock/
  package.json            # bin: ratchetlock, dep: promptfoo
  tsconfig.json
  src/
    cli.ts                # parseArgs 라우팅 → 서브커맨드
    state.ts              # ratchet.json 로드/저장, 타입, sha256 해시
    promptfoo.ts          # 어댑터: live eval + 결정적 replay eval 실행 + 결과 정규화 (CaseResult[])
    replay-provider.js    # promptfoo exec 프로바이더: 동결 출력을 vars 키로 되돌려줌(결정적 check용)
    floor.ts              # frozen[] + failCases[] + activePrompt → "통과해야 할 (promptId,caseId) 집합" 도출
    commands/
      init.ts
      check.ts
      freeze.ts
      addFail.ts
      status.ts
  test/
    *.test.js             # node --test
  examples/
    cardnews/             # 플래그십 (파일럿 데이터 이식)
      promptfooconfig.yaml, prompt.txt, prompt_v2.txt,
      asserts.js, tests.yaml, provider.sh,
      fixtures/baseline.json, fixtures/ab.json   # 캡처된 실측 출력 = 결정적 재현 자산
      ratchet.json, demo.sh, README.md
  ARCHITECTURE.md
  README.md
```

- `provider.sh`: 파일럿의 `claude_provider.sh`를 이식하되 **하드코딩 경로(`/opt/homebrew/bin/claude`) 제거** → `command -v claude`로 해석(공개 repo 재현성, M3). claude CLI가 없는 환경을 위해 `--live` 없이는 이 프로바이더를 타지 않는다.
- `fixtures/`: 파일럿에서 캡처한 `baseline.json`(v1 출력)·`ab.json`(v1+v2 출력)을 1급 재현 자산으로 동봉. `demo.sh`와 결정적 `check`는 claude 구독 없이 이 fixture만으로 완주된다.

### 3.3 래칫 상태 파일 스키마 (`ratchet.json`)

```jsonc
{
  "schemaVersion": 1,
  "target": {
    "config": "promptfooconfig.yaml",   // 감쌀 promptfoo config (사용자 소유)
    "prompts": ["prompt.txt", "prompt_v2.txt"],
    "probes":  ["asserts.js"],
    "tests":   "tests.yaml"
  },
  "activePrompt": "prompt_v2.txt",        // C1: floor가 바인딩되는 프롬프트 포인터 (config 편집 없이 v1↔v2 전환)
  "current": {                            // 현재 작업본 해시 (드리프트 감지용)
    "prompts": { "prompt_v2.txt": "sha256:…" },
    "probes":  { "asserts.js":   "sha256:…" }
  },
  "frozen": [                             // 동결된 계약 = 래칫 바닥(floor)
    {
      "id": "2026-07-22T09-00-00Z",
      "promptId": "prompt_v2.txt",        // C1: 이 스냅샷이 어느 프롬프트의 것인지
      "note": "v2 4/5 baseline",
      "promptHash": "sha256:…",
      "probeHash":  "sha256:…",           // asserts.js 동결 해시
      "cases": {                          // 이 (프롬프트) 스냅샷에서 통과한 케이스
        "07-21 ② fastmcp": {
          "pass": true, "score": 1,
          "output": "{\"title\":…}"       // C2: 동결 시 모델 출력 스냅샷 (결정적 replay용)
        }
        // OmniRoute는 프레이밍 휴리스틱 fail → 미동결 (M1, 로드맵)
      }
    }
  ],
  "failCases": [                          // 래칫: 한번 잡은 실패 → 영구 가드
    {
      "id": "fail-codefence-01",
      "addedAt": "2026-07-22T…",
      "promptId": "prompt.txt",           // C1: 어느 프롬프트에서 잡힌 실패인지
      "caseRef": "07-21 ② fastmcp",       // tests.yaml의 description
      "expectedPass": true,
      "note": "v1 코드펜스 실패 → v2 제약으로 회복. 영구 회귀 가드."
    }
  ]
}
```

**케이스 키잉(C1)**: 케이스 식별자는 `(promptId, caseId)` 복합 키다. ab.json은 프롬프트 2종 × 케이스 5건 = 10행이라 caseId(description)만으로 키잉하면 같은 caseId에 v1(fail)·v2(pass)가 공존해 floor가 오판한다. promptId는 어댑터가 `results.results[i].prompt.label`에서 얻는다(확인됨). floor는 항상 `activePrompt` 한 프롬프트에 바인딩된다.

**floor(래칫 바닥) 도출(B1)**: 두 원천의 층위가 다르다.
- **frozen[]는 promptId-scoped** — `activePrompt`와 일치하는 계약들이 `pass:true`로 기록한 caseId만 합집합에 넣는다(특정 프롬프트 버전이 그 출력으로 통과했다는 스냅샷이므로).
- **failCases[]는 프롬프트-무관** — `expectedPass:true`인 caseRef는 **activePrompt와 상관없이 항상 floor에 참여**한다. failCase의 `promptId`는 "어느 버전에서 처음 잡혔나"의 provenance 기록일 뿐 필터가 아니다. "한번 잡은 실패는 어느 버전에서든 통과를 요구한다"는 래칫 서사와 정합 — v1에서 잡은 코드펜스 실패는 v2로 전환해도 여전히 게이트에 걸린다.

`check`는 이 합집합의 모든 케이스가 여전히 통과할 것을 요구한다. 하나라도 떨어지면 회귀 → 게이트 반려.

**프롬프트·프로브 동시 버전 관리**(요구 ③): 동결 스냅샷은 프롬프트 해시와 프로브 해시를 **함께** 기록한다. 기본 `check`는 동결된 출력에 **현재 프로브**를 재적용하므로, 프로브가 조용히 약해졌으면(발견 ③) 동결 통과작이 이제 fail로 나와 즉시 잡힌다. 추가로 현재 프로브 해시가 동결 해시와 다르면 경고하고, `--probe-locked`로 불일치를 하드 페일로 승격 가능.

### 3.4 promptfoo 연동 방식 (공식 문서·소스 검증 완료 — v0.121.x)

- 호출: `execFile('npx', ['promptfoo','eval','-c',<config>,'-o',<tmp.json>], {env})`.
  - 샌드박스에서 `~/.promptfoo` EPERM 방지 위해 `PROMPTFOO_CONFIG_DIR`을 프로젝트 로컬로 재지정(파일럿 실측 요건). 이 변수는 config·eval 히스토리·캐시 저장 위치를 오버라이드한다(기본 `~/.promptfoo`).
  - `PROMPTFOO_FAILED_TEST_EXIT_CODE=0`으로 설정 — assert 실패 시 promptfoo가 기본 종료코드 100으로 죽는데, 우리는 이를 크래시가 아닌 정상 데이터로 받아 JSON을 파싱한 뒤 **래칫 관점의 verdict를 자체 계산**한다. (promptfoo의 실패 = "assert 하나라도 실패", 래칫의 실패 = "동결된 floor 케이스가 회귀" — 둘은 다르다. floor 밖 케이스는 실패해도 게이트 통과다.)
- 결과 파싱(확정 스키마): `-o` JSON = `OutputFile.results`(EvaluateSummaryV3) → `.results[]`(EvaluateResult) 순회.
  - 케이스 최상위 pass/score = `results.results[i].success` / `.score`.
  - caseId = `results.results[i].testCase.description`(tests.yaml에 존재) — 유실 시 `.vars` 직렬화 해시로 폴백.
  - **promptId = `results.results[i].prompt.label`**(C1 복합 키의 프롬프트 차원, 확인됨).
  - 모델 출력 = `results.results[i].response.output`(freeze 시 스냅샷 저장 대상).
  - 실패 assert 목록 = `results.results[i].gradingResult.componentResults[]` 순회 → 각 `.pass`/`.reason`/`.assertion`(type·value). error 행·assert 없는 행에는 `gradingResult`가 없을 수 있어 방어 파싱.
  - 정규화 산출: `CaseResult = { promptId, caseId, pass, score, output, failedAsserts[] }`.
- 게이트 판정은 **우리가** 한다(exit code 비의존 — floor 대조가 우리 책임). 어댑터는 `CaseResult[]`만 반환, floor 대조·verdict는 `check.ts`.
- **출력 위생**: eval 원시 출력은 로그 파일(`PROMPTFOO_LOG_DIR` 또는 리다이렉트)로. stdout에는 verdict 몇 줄(통과/회귀 케이스 목록)만.

**결정적 check = replay 프로바이더(C2)**: 기본 `check`는 LLM을 재호출하지 않는다. 어댑터가 임시 promptfoo config를 생성하는데, 그 프로바이더를 `provider.sh` 대신 **`replay-provider.js`**(exec 프로바이더)로 바꾼다. replay 프로바이더는 vars(또는 caseId)를 키로 `frozen[].cases[caseId].output`을 그대로 반환한다. promptfoo는 이 고정 출력에 **현재 `asserts.js`를 적용**해 결정적으로 pass/fail을 낸다. 즉 assert 실행은 여전히 promptfoo가 하고(Anti-ISC-1 유지), LLM 비결정성만 제거된다. `check --live`일 때만 진짜 `provider.sh`(claude CLI)를 타서 fresh 출력을 만든다.

**직전 eval 영속(add-fail --from-last 데이터 출처, MINOR)**: `check`/`freeze`는 상태(ratchet.json) 관점에선 read-only지만, 정규화한 `CaseResult[]`를 **런 아티팩트** `.ratchet/last-eval.json`에 매번 덮어쓴다(상태가 아닌 캐시 — DB 아님). `add-fail --from-last <caseId>`는 여기서 해당 케이스 결과를 읽어 등록한다.

---

## 4. CLI 커맨드 세트

바이너리: `ratchetlock`. 5개 커맨드.

공통 옵션: `--prompt <label>`(대상 프롬프트 지정, 생략 시 `activePrompt`; 지정 시 `activePrompt`로 영속). `check`/`freeze`는 기본 결정적(동결 출력 replay), `--live`로 실 LLM 재평가.

| 커맨드 | 입력 | 부작용 | 출력 |
|--------|------|--------|------|
| `init` | `-c <config>` (없으면 cwd에서 promptfooconfig 탐지) | `ratchet.json` 생성 — target 추출 + 현재 해시 기록, `activePrompt`=첫 프롬프트, `frozen:[]` `failCases:[]` 초기화 | 감지된 대상 파일·프롬프트 목록 |
| `check` | `ratchet.json` 읽음, `[--prompt L] [--live] [--probe-locked]` | 상태 불변(read-only 게이트). `.ratchet/last-eval.json` 갱신, 원시출력은 로그로 | floor 케이스 통과/회귀 요약. **회귀 시 exit 1, 통과 시 exit 0**. 기본=동결 출력에 현재 프로브 재적용(결정적), `--live`=fresh LLM |
| `freeze` | `ratchet.json` 읽음, `[--prompt L] [--note T] [--allow-partial]` | 라이브 eval 실행 → `frozen[]`에 스냅샷 append(통과 케이스 + **출력** + 프롬프트/프로브 해시), `current`·`activePrompt` 갱신. **바닥을 올린다** | 동결된 케이스 수·미동결 케이스·해시 |
| `add-fail` | `--from-last <caseId>` 또는 `--signal <file> --desc <text>` `[--prompt L]` | (a) 새 케이스면 tests 파일에 append, (b) `failCases[]`에 `promptId`+`expectedPass:true`로 등록 → 이후 check가 통과를 요구 | 등록 확인 |
| `status` | `ratchet.json` 읽음 | 없음 | activePrompt·현재 해시·frozen 수·floor 크기·failCases·드리프트(프롬프트/프로브 변경) |

**커맨드 규약 상세**
- `freeze`는 **라이브 eval**(진짜 LLM 또는 fixture 재생)로 출력을 만들고 그 출력을 스냅샷에 저장한다. 이후 결정적 check가 이 출력을 replay한다.
- `freeze` 사전조건: 대상 케이스가 **전부 green**이어야 동결(깨진 상태에서 바닥 못 올림). 실패분 존재 시 기본 거부, `--allow-partial`로 통과분만 동결하고 미동결 케이스를 명시 출력(M1: v2 4/5 시 4건 동결·OmniRoute 1건 미동결).
- `check`가 게이트 코어: (기본) 동결 출력 replay + 현재 프로브 → floor 대조 → exit 0/1. (`--live`) fresh LLM eval → floor 대조. 회귀 케이스·실패 assert를 짚어 출력.
- `add-fail`이 래칫 코어: 방금 잡은 실패를 영구 회귀 케이스로 승격. `--from-last`는 `.ratchet/last-eval.json`에서 결과를 읽는다.
- `--prompt`로 `activePrompt`를 전환해 **config 편집 없이** v1↔v2를 오간다(M2, C1).

---

## 5. 구현 티켓 분해

각 티켓 = fresh context 1개 크기. 의존 순서: **T1 → T2 → {T3, T4} → T5 → T6.**

### T1 — 스캐폴딩 + 상태 모델 + `init`
- npm/tsconfig/bin 엔트리, package.json(promptfoo dep, tsc 빌드 스크립트).
- `state.ts`: 타입 정의 + `ratchet.json` load/save + 대상 파일 sha256 해시.
- `init.ts`: promptfooconfig 탐지 → prompt/probe/tests 참조 추출 → 초기 `ratchet.json` 기록.
- 의존: 없음.

### T2 — promptfoo 어댑터 (live + replay eval 실행 + 결과 정규화)
- `promptfoo.ts`: `promptfoo eval -c … -o tmp.json` 셸아웃, `PROMPTFOO_CONFIG_DIR`·`PROMPTFOO_FAILED_TEST_EXIT_CODE=0` 처리, 출력 JSON(`results.results[].{success,score,prompt.label,testCase.description,response.output,gradingResult.componentResults[]}`) → `CaseResult[]`(promptId 포함) 정규화. 스키마는 3.4에 확정.
- `replay-provider.js` + 임시 config 생성: 동결 출력을 되돌려주는 exec 프로바이더로 갈아끼워 **결정적 check** 지원. 라이브 모드는 원본 `provider.sh` 사용.
- 에러 처리: promptfoo 미설치·타임아웃·exec 실패, `gradingResult` 없는 행 방어 파싱.
- 의존: T1(타입).

### T3 — `check` 게이트 (floor 대조 + exit code)
- `floor.ts`: `frozen[]`(activePrompt와 promptId 일치분만) ∪ `failCases[]`(**promptId 필터 없이 전부**, B1) → 통과 필수 케이스 집합. failCase의 promptId는 provenance일 뿐 floor 참여 조건이 아님을 코드 주석으로 명시.
- `check.ts`: (기본) 동결 출력 replay eval → floor 대조; (`--live`) fresh eval → floor 대조 → verdict → exit 0/1. 프롬프트/프로브 해시 드리프트·`--probe-locked` 감지. 출력 위생(verdict만 stdout).
- 의존: T1, T2.

### T4 — `freeze` + `add-fail` + `status` (래칫 상태 변이)
- `freeze.ts`: require-green 사전조건, `frozen[]` 스냅샷.
- `addFail.ts`: `failCases[]` 등록 + 신규 케이스 tests append.
- `status.ts`: 상태 출력.
- 의존: T1, T2.

### T5 — 플래그십 예제: 카드뉴스 프롬프트 실적용 (정직한 before/after)
- `examples/cardnews/`에 파일럿 데이터 이식(prompt v1/v2, asserts.js, tests.yaml, config, `provider.sh` 경로 하드코딩 제거) + `fixtures/baseline.json`·`ab.json` 동봉(M3 재현 자산).
- **asserts.js 이식 범위 명시 결정(M1)**: 파일럿 asserts.js를 그대로 이식하며 **프레이밍 휴리스틱(저자 주장 한정어 소실 체크, 47~52행) 포함**. 이 휴리스틱은 키워드 기반 **결정적** 체크이지 LLM 의미 판정이 아니다 — 로드맵의 "의미 왜곡 검출(LLM 루브릭)"과 다른 층위다. README/ARCHITECTURE에 이 구분을 1문장 명시해 "MVP 제외" 선언과의 모순을 해소한다.
- **정직한 래칫 흐름**(demo.sh, fixture 재생 모드 기본 → claude 구독 불필요):
  1. `init` (activePrompt=prompt.txt) → `check --live`(fixture replay) v1 → **0/5**(baseline.json 실측: 파싱실패 1건 + 코드펜스 4건).
  2. v1에서 잡힌 실패 케이스들을 `add-fail`로 등록(코드펜스 4건 등). **B1 덕분에** 이 failCase들은 이후 v2로 전환해도 floor에 남아 게이트에 계속 작용한다 — add-fail이 no-op이 아님을 데모가 보인다.
  3. `--prompt prompt_v2.txt`로 전환 → `freeze --allow-partial` → v2 **4/5 동결**. OmniRoute 1건은 **기존 키워드 프로브(저자 주장 한정어 소실 체크)가 v2 재작성의 실제 한정어 누락을 잡아낸 것 — 도구가 실이슈를 검출한 사례**로 미동결(MINOR). "로드맵 대기"가 아니라 "래칫이 실제 회귀를 붙든 증거"로 서술한다.
  4. `check`(결정적 replay) → 동결 4건 + v1에서 add-fail한 케이스(v2에서도 통과) 전부 통과 → **exit 0**. 이후 asserts.js를 약화시키면 결정적 check가 회귀를 잡는 걸 시연.
- before/after 트랜스크립트를 예제 README에 **1급 자산으로 캡처**(M3).
- 의존: T1~T4 (동작하는 커맨드 필요).

### T6 — 문서: ARCHITECTURE.md + README
- `ARCHITECTURE.md`("왜" 중심): promptfoo 위에 래칫을 얹는 이유, **결정성 정책(왜 check가 LLM을 재호출하지 않고 동결 출력을 replay하는가 — LLM 비결정성이 게이트를 플레이키하게 만들기 때문, C2)**, 파일 상태(비-DB) 선택 이유, `(promptId,caseId)` 복합 키가 필요한 이유(C1), 프로브 동시 버전 관리 근거, YAGNI 결정들.
- `README.md`(자연스러운 산문): 무엇인지·설치·5개 커맨드·카드뉴스 예제(히어로 데모, **baseline.json 실측대로**: 파싱실패 1건+코드펜스 4건, 헤드라인 0/5→4/5)·프레이밍 휴리스틱 vs LLM 의미 판정 구분·**OmniRoute 미동결을 "도구가 실이슈를 잡은 사례"로 서술**(MINOR, 더 강한 서사)·로드맵(의미 왜곡 LLM 루브릭 = MVP 제외).
- 마무리: hangeul-deai 스킬로 문체 패스(AI 티·번역체 제거).
- 의존: T5 (정직한 실측 예제 출력을 문서화).

---

## 6. Criteria (ISC 이진 프로브)

각 기준 = 실행 명령 1개의 출력으로 pass/fail 판정. ISC ID는 편집 시 재번호하지 않는다.

### 기능 계약 (ISC)
```
ISC-1.1: `npx tsc --noEmit → 0 errors` → pass/fail
ISC-1.2: `node dist/cli.js init -c examples/cardnews/promptfooconfig.yaml; test -f examples/cardnews/ratchet.json` → exit 0 → pass/fail
ISC-1.3: `node -e "const s=require('./examples/cardnews/ratchet.json'); process.exit(s.target&&s.activePrompt&&Array.isArray(s.frozen)&&Array.isArray(s.failCases)?0:1)"` → exit 0 (activePrompt 포함) → pass/fail
ISC-2.1: `node --test test/promptfoo.test.js → 0 failures` (어댑터가 `results.results[].{success,prompt.label,response.output,gradingResult.componentResults[]}` 형태의 샘플 eval JSON 픽스처를 CaseResult[]로 정규화, promptId·output·실패 assert 추출 검증) → pass/fail
ISC-2.2: `node dist/cli.js check --prompt prompt_v2.txt 1>out.log 2>/dev/null; grep -qE "통과|회귀|pass|fail" out.log` → verdict가 stdout에 출력됨(스트림 일치) → pass/fail
ISC-2.3: ab.json fixture(프롬프트 2×케이스 5=10행) 정규화 결과에 `(prompt.txt, X)`와 `(prompt_v2.txt, X)`가 **별개 키**로 공존 — `node --test test/keying.test.js → 0 failures` → pass/fail
ISC-3.1: v2 4건 동결 후 asserts.js를 약화(또는 동결 출력 변조) → `check; echo $?` → 회귀 감지로 non-zero → pass/fail
ISC-3.2: `freeze --prompt prompt_v2.txt --allow-partial`(4건 동결) 후 결정적 `check; echo $?` → 0 → pass/fail
ISC-3.3: `node dist/cli.js check … 1>/dev/null 2>/dev/null; node dist/cli.js check … 2>/dev/null | wc -l` → ≤ 12 (verdict만) → pass/fail
ISC-3.4: `check --live`가 replay가 아닌 provider.sh 경로를 타는지 — `check --live --prompt prompt_v2.txt` 로그에 fixture/live eval 실행 흔적 존재 → pass/fail
ISC-3.5 (B1): v1(prompt.txt)에서 `add-fail`한 케이스가 `--prompt prompt_v2.txt` 전환 후에도 floor에 참여 — `node --test test/floor.test.js`로 "activePrompt=prompt_v2.txt일 때 failCase(promptId=prompt.txt)가 floor 집합에 포함" 검증 → 0 failures → pass/fail
ISC-4.1: `freeze --prompt prompt_v2.txt --allow-partial` → `node -e "process.exit(require('./…/ratchet.json').frozen.length>=1?0:1)"` → exit 0 → pass/fail
ISC-4.2: 대상 케이스에 실패 존재 시 `--allow-partial` 없이 `freeze; echo $?` → non-zero AND frozen 길이 불변 → pass/fail
ISC-4.3: `add-fail --from-last <caseId>` 후 `node -e "const f=require('./…/ratchet.json').failCases; process.exit(f.some(x=>x.expectedPass&&x.promptId)?0:1)"` → exit 0 (promptId 포함) → pass/fail
ISC-4.4: 동결된 케이스가 출력 스냅샷을 보유 — `node -e "const c=Object.values(require('./…/ratchet.json').frozen[0].cases)[0]; process.exit(c.output&&c.output.length>0?0:1)"` → exit 0 (C2 결정적 replay 근거) → pass/fail
ISC-5.1: `bash examples/cardnews/demo.sh → exit 0` (claude 구독 없이 fixture 재생으로 init→v1 0/5→add-fail→v2 freeze 4건 동결·1건 미동결→결정적 check 통과 완주) → pass/fail
ISC-6.1: `test -f ARCHITECTURE.md && test -f README.md` → exit 0 → pass/fail
```

### 금지 동작 검증 (Anti-ISC) — Guardrails/Out-of-Scope에서 파생
```
Anti-ISC-1 (promptfoo 재구현 금지): `grep -rEl "child_process|node:child_process" src/promptfoo.ts` → ≥1 (셸아웃) AND `grep -rl "runAssertions\|applyAssert\|gradeOutput\|new OpenAI\|callApi" src/` → no matches (자체 평가/채점 엔진 없음) → pass/fail
Anti-ISC-2 (DB 금지): `grep -rEi "sqlite|better-sqlite3|postgres|prisma|mongoose|typeorm|\"pg\"" package.json` → no matches → pass/fail
Anti-ISC-3 (프롬프트 원본 불변 — 래칫은 제약만 추가): `freeze`·`add-fail` 실행 후 `git -C examples/cardnews diff --exit-code prompt.txt prompt_v2.txt` → exit 0 (원본 프롬프트 파일 미변경) → pass/fail
Anti-ISC-4 (의미 왜곡 검출 MVP 제외): `grep -rEi "llm.?rubric|semantic.?distort|의미.?왜곡|루브릭" src/` → no matches → pass/fail
```

### 리뷰 게이트 (비-ISC, 이진 판정 불가)
- README·ARCHITECTURE 산문 자연스러움: hangeul-deai 스킬 통과 + critic 리뷰. (grep으로 판정 불가하므로 ISC 아님.)

---

## 7. Success Criteria (플랜 완료 정의)

1. `ratchetlock` 바이너리가 5개 커맨드(init/check/freeze/add-fail/status)를 제공하고 ISC-1~4 전부 통과.
2. 카드뉴스 프롬프트에서 **정직한** before/after(v1 0/5 → v2 4/5, 1건 로드맵 미해결 명시)가 `demo.sh`로 **claude 구독 없이 fixture 재생만으로** 재현되고 예제 README에 캡처됨(ISC-5.1).
3. 기본 `check`가 **결정적**(동결 출력 replay, LLM 재호출 없음) CI 게이트로 동작 — 회귀 시 non-zero(ISC-3.1), 무회귀 시 0(ISC-3.2). 라이브 재평가는 `--live`로 분리(ISC-3.4).
4. floor가 `(promptId,caseId)` 복합 키로 프롬프트 차원 오판 없음(ISC-2.3).
5. Anti-ISC 1~4 전부 통과 (promptfoo 재구현·DB·프롬프트 변조·의미왜곡 검출 없음).
6. ARCHITECTURE.md(결정성 정책 "왜" 포함) + 자연스러운 산문 README 완성, hangeul-deai/critic 리뷰 통과.

---

## 8. 로드맵 (MVP 이후)

- **의미 왜곡 검출 (LLM 루브릭)** — 파일럿 발견 ②: 이진 assert의 사각지대. "Trending +1,107"(당일 스타 증가)을 "순위 1,107 상승"으로 재작성한 실왜곡을 잡으려면 수치·단위 의미 보존을 별도 LLM 그레이더로 검증. promptfoo의 `llm-rubric`/`model-graded` assert를 래칫 프로브로 편입.
- **`promptfoo optimize` 편입** — 파일럿 미검증 항목(후보 생성 그레이더 요건). 자동 개선안 생성 → check 게이트 통과분만 채택하는 루프.
- **프로브 락 강제 모드** — 프로브 해시 불일치를 기본 하드 페일로. 측정기 드리프트 원천 차단.
- **다중 타깃** — 한 저장소에서 여러 프롬프트 계약을 병렬 관리.

---

## Open Questions
- (해소됨) promptfoo `eval -o` JSON 스키마·종료코드·config 참조·javascript assert·래칫 부재·환경변수 — 공식 문서/소스(`src/types/index.ts`, promptfoo.dev) 검증 완료, 3.4·T2에 반영. 남은 미세 확인: `testCase.description`·`prompt.label`이 출력 JSON에 항상 실리는지 T2 구현 시 실측 픽스처(baseline.json/ab.json)로 최종 확인(폴백=vars 해시 이미 설계됨).
- (T2 실측 완료) `testCase.description`·`prompt.label`은 baseline.json(5행)·ab.json(10행) 전 15행에 예외 없이 실렸다(폴백 vars 해시 경로는 실제로 타지 않음, 방어 코드로만 유지). 단, `prompt.label`은 짧은 파일명이 아니라 `"<파일명>: <템플릿 원문(vars 치환 전)>"` 형태였다(실측·소스 확인: file:// 프롬프트 로드 시 promptfoo가 이렇게 채운다) — `ratchet.json`의 `activePrompt`/`target.prompts`(파일명만)와 맞추려면 어댑터가 콜론 앞 파일명 토큰만 잘라 promptId로 써야 한다(`src/promptfoo.ts`의 `extractPromptId`). §3.4 서술의 "promptId = prompt.label"은 이 추출을 거친 값으로 정정.
- (해소됨, T2) replay 프로바이더의 케이스↔출력 매칭 키 — 계획 초안(vars 해시 우선·description 보조)에서 **description 우선·vars 해시 폴백으로 순서를 뒤집어 확정**했다. 근거: (1) §3.3 `ratchet.json` 스키마의 `frozen[].cases`가 이미 description을 딕셔너리 키로 직접 쓴다(예시: `"07-21 ② fastmcp": {...}`), (2) `src/promptfoo.ts`의 `CaseResult.caseId` 추출도 description 우선·vars 해시 폴백이라 두 쪽 순서가 어긋나면 replay 매칭이 깨진다, (3) `.ratchet/probe` 실측 실험으로 exec 프로바이더가 `argv[4]`(context JSON)에 `test.description`을 그대로 받는 걸 확인해 별도 변환 없이 바로 키로 쓸 수 있다. `test/promptfoo.test.js`·`test/keying.test.js`·replay-provider 스모크로 검증.
- (구현 시 결정) `add-fail`이 신규 시그널을 tests 파일에 append할 때 YAML append 방식 — 파일럿 tests.yaml은 리스트 포맷이라 stdlib로 안전 append 가능. `file://tests.js` 생성기 형태였다면 append 불가 → ratchet.json에만 등록하고 수동 추가 안내(구현 시 분기).

---

## 부록: critic APPROVE WITH CHANGES 반영 내역 (2026-07-22)
- **C1(floor 프롬프트 차원)**: 케이스 키를 `(promptId, caseId)`로 확장(promptId=`prompt.label`), `ratchet.json`에 `activePrompt` 포인터 도입, floor를 activePrompt에 바인딩. §3.3·§3.4·T2·T3·ISC-1.3/2.3/4.3 반영.
- **C2(LLM 비결정성 정책)**: 기본 `check`를 동결 출력 replay + 현재 프로브 재적용의 **결정적 모델**로 전환, 라이브 재평가는 `--live`로 분리. freeze가 출력 스냅샷 저장. replay-provider.js 도입. §1 결정성 정책·§3.4·§4·ISC-3.1/3.2/3.4/4.4 반영. ARCHITECTURE "왜"에 명시(T6).
- **M1(서사 정직화)**: v2=4/5로 재서술, `--allow-partial`로 4건 동결·OmniRoute 1건 미동결(로드맵). asserts.js 프레이밍 휴리스틱은 포함하되 "결정적 키워드 체크 ≠ LLM 의미 판정"으로 로드맵과 구분 명시. T5·README 반영.
- **M2(v2 전환 메커니즘)**: config 편집 없이 `--prompt`/activePrompt로 전환. §4·T5.
- **M3(공개 repo 재현성)**: provider.sh 하드코딩 경로 제거, baseline.json/ab.json fixture 동봉, demo.sh 기본 fixture 재생 모드, 트랜스크립트 1급 자산 승격. §3.2·T5.
- **MINOR**: ISC-2.2 스트림 일치(stdout), add-fail --from-last 출처=`.ratchet/last-eval.json` 정의, README를 baseline.json 실측대로 서술.

### 재심사 반영 (2026-07-22, 2차)
- **B1(failCase가 프롬프트 전환 시 floor에서 이탈 → add-fail no-op)**: (a)안 확정. floor 규칙에서 failCase의 `promptId==activePrompt` 조건 제거 → failCase는 프롬프트 무관하게 항상 floor 참여, promptId는 provenance 기록으로만 유지. frozen[]는 여전히 promptId-scoped(층위 차이를 §3.3에 명시). §3.3 floor 규칙·T3 floor.ts·T5 데모(add-fail이 v2 전환 후에도 게이트에 작용)·신규 ISC-3.5로 반영.
- **MINOR(OmniRoute 서사 강화)**: 미동결 사유를 "로드맵 대기"에서 "기존 키워드 프로브가 v2의 저자 주장 한정어 누락을 실제로 잡아낸 것 — 도구가 실이슈를 검출한 사례"로 T5·T6 README 서사에 반영.
