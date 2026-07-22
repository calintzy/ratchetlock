# fixtures — 카드뉴스 파일럿 실측 캡처 (1급 재현 자산)

카드뉴스 재작성 프롬프트 파일럿(2026-07-21)에서 실제 claude(sonnet)로 뽑은 모델 출력을 그대로 캡처한 것이다.
`demo.sh`와 결정적 `check`는 claude 구독 없이 이 fixture만으로 완주한다 — 출력을 replay-provider가 되돌리고
현재 `asserts.js`를 재적용하는 방식이라 LLM 재호출이 없다.

## 파일

| 파일 | 내용 | 성격 |
|------|------|------|
| `baseline.json` | v1(`prompt.txt`) 5건 실측 출력 + **당시(파일럿 시점) 채점 기록** | 원본 보존(원시 출력·vars) |
| `ab.json` | v1+v2 A/B 10건 실측 출력 + 채점 기록 | 원본 보존 |
| `baseline.regraded.json` | `baseline.json`의 출력을 **현재 `asserts.js`로 재채점**한 verdict | 테스트·데모의 채점 기준 |

`output`/`vars`(모델 출력·입력 시그널)는 세 파일 모두 실측 원본이며 절대 수정하지 않는다.

## 프로브 버전 스큐 — 왜 `baseline.regraded.json`을 따로 두는가

`baseline.json`의 채점 기록은 **구버전 `asserts.js`** 산물이다. 파일럿 당시 프레이밍 휴리스틱(저자 주장
한정어 소실 체크, `asserts.js`의 hedge 정규식)에는 `따르면`·`다고 합니다` 패턴이 아직 없었다. 이후 프로브를
교정해 이 표현들을 한정어로 인정하도록 넓혔다(파일럿 발견 ③: "측정기 자체도 래칫 대상").

그 결과 같은 출력을 두 프로브가 다르게 채점한다. 예: **OmniRoute(prompt.txt)**

| 채점 프로브 | fails | score |
|-------------|-------|-------|
| 구버전(`baseline.json` 기록) | 코드펜스 + 한정어 소실 = 2건 | **0.5** |
| 현재(`baseline.regraded.json`·`ab.json`) | 코드펜스 = 1건 | **0.75** |

교정된 프로브가 OmniRoute 출력의 hedge 표현(`~다고 합니다`류)을 이제 인정해 프레이밍 fail이 사라졌다.
`ab.json`은 교정 후 채점이라 자기일관적이고, `baseline.json`만 구프로브 기록이라 어긋났다.

이 어긋남은 버그가 아니라 ratchetlock이 설계한 **프로브 드리프트 검출**이 실제로 동작한 사례다
(계획 §158). 게이트로 강제하는 코드가 없었을 뿐이라, T3에서 `check`의 probeHash 가드와
`test/replay-fidelity.test.js`로 이 정합성을 상시 강제한다.

## v1 0/5 헤드라인은 신프로브에서도 유지된다

프로브 교정은 프레이밍 체크를 **완화**하는 방향(더 많은 한정어를 인정)이라 fail을 늘리지 않는다.
`baseline.regraded.json` 재채점 결과 v1 5건은 여전히 **0/5**다(코드펜스 4건 + JSON 파싱 실패 1건).
OmniRoute만 0.5→0.75로 점수가 올랐지만 코드펜스 위반으로 여전히 fail이라 헤드라인(0/5→4/5)은 그대로다.

## 재생성

`baseline.regraded.json`은 `baseline.json` 출력에 현재 `asserts.js`를 replay 경로로 재적용해 만든다.
`asserts.js`를 바꾸면 이 파일도 다시 생성해야 하며, 안 하면 `test/replay-fidelity.test.js`가 실패해
프로브-fixture 스큐를 즉시 알린다(재발 방지 계약).
