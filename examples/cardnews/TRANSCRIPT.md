# TRANSCRIPT — `demo.sh` 실행 기록

`bash examples/cardnews/demo.sh` 실행 결과를 그대로 캡처한 것이다(수동 편집 없음, 로그 타임스탬프만
실행마다 달라진다). 무엇을 재현하는지는 [README.md](README.md)를 먼저 읽는 것을 권한다.

## 단계별로 볼 것

- **0. 초기화** — `ratchet.json`을 지우고 다시 `init`한다. `activePrompt`가 `prompt.txt`(v1)로 잡힌다.
- **1. v1 실측 확인** — `check --live`를 fixture 재생으로 태운다. 이 시점엔 아직 아무것도 동결되지 않아
  `floor 0건`이라 `check` 자체는 트리비얼하게 통과한다(플로어가 비어 있으니 잃을 게 없다는 뜻). 진짜
  헤드라인은 그 아래 스코어카드 — `check`가 남긴 `.ratchet/last-eval.json`을 읽어 뽑은 **v1 0/5**다.
- **2. add-fail** — 코드펜스 3건 + JSON 파싱 실패 1건, 총 4건을 영구 회귀 가드로 등록한다. OmniRoute는
  일부러 뺐다(3단계에서 이유가 나온다).
- **3. B1 시연** — v2로 아직 전환도, 동결도 하지 않은 시점에 `check --live --prompt prompt_v2.txt`를
  돌리면 `floor 4건`이 이미 나타난다. `frozen`은 여전히 0인데도 그렇다. add-fail로 등록한 계약이
  프롬프트가 바뀌어도 사라지지 않는다는 뜻이다 — add-fail은 일회성 메모가 아니라 영구 게이트다.
- **4. freeze --allow-partial** — v2로 전환하며 4건을 동결한다. OmniRoute만 미동결로 남는다. 코드펜스는
  v2에서 고쳐졌지만, 저자 주장 한정어 프레이밍 체크가 v2 재작성에서 실제로 빠진 한정어를 잡아낸 것이다.
- **5. 결정적 check** — 이번엔 fixture 스왑이 필요 없다. 동결 스냅샷을 되돌리는 replay 경로가 `check`
  안에 이미 내장돼 있다. floor 4건이 전부 통과해 exit 0.
- **6. 회귀 시연** — 동결된 출력 하나에 코드펜스를 인위로 끼워 넣고 `check`를 다시 돌리면 즉시
  회귀로 잡혀 exit 1이 된다. 원복하면 다시 통과한다.
- **7. 정리** — `ratchet.json`을 fresh init 상태로 되돌리고, 프롬프트 원본 무변조와 전체 git diff
  클린을 스스로 검증한다.

## 실행 로그

```
[demo] dist 빌드 확인 중...
########################################################
# ratchetlock 플래그십 데모 — 카드뉴스 프롬프트 v1 -> v2
########################################################
[demo] fixture 재생 모드(기본): claude 구독 없이 fixtures/*.json 실측 데이터로 재현한다.

== 0. 초기화 — 이전 상태 리셋 후 init(activePrompt=prompt.txt) ==
ratchet.json 생성됨: /Users/ryan/ClaudeProject/ratchetlock/examples/cardnews/ratchet.json
  prompts: prompt.txt, prompt_v2.txt
  probes: asserts.js
  tests: file://tests.yaml
  activePrompt: prompt.txt

== 1. v1(prompt.txt) 실측 확인 — check --live ==
[check] prompt.txt (live) — floor 0건
통과: floor 0건 전부 pass.

[demo] v1(prompt.txt) 실측 스코어카드: 0/5 pass
  - 07-21 ① OmniRoute (저자 주장 한정어 포함): FAIL — 코드펜스 출력(금지)
  - 07-21 ② fastmcp (저자 주장 2회 포함): FAIL — JSON 파싱 실패
  - 07-21 ⑤ Anthropic 그랜트 (날짜·금액 보존 확인): FAIL — 코드펜스 출력(금지)
  - 07-20 ① Fable 5 한도 개방 (구독 정책 — 과장 유혹 높음): FAIL — 코드펜스 출력(금지)
  - 07-19 ② Claude Code 업데이트 (기술 용어 밀도 최고): FAIL — 코드펜스 출력(금지)

== 2. v1 실패 케이스 4건을 add-fail로 영구 등록 (OmniRoute는 3단계에서 설명 — 제외) ==
failCase 등록됨: fail-1784723662540 (prompt.txt, 07-19 ② Claude Code 업데이트 (기술 용어 밀도 최고))
failCase 등록됨: fail-1784723662589 (prompt.txt, 07-20 ① Fable 5 한도 개방 (구독 정책 — 과장 유혹 높음))
failCase 등록됨: fail-1784723662638 (prompt.txt, 07-21 ⑤ Anthropic 그랜트 (날짜·금액 보존 확인))
failCase 등록됨: fail-1784723662688 (prompt.txt, 07-21 ② fastmcp (저자 주장 2회 포함))

== 3. B1 시연 — v2로 아직 전환·동결 전인데 add-fail 케이스가 이미 floor에 참여하는가 ==
[check] prompt_v2.txt (live) — floor 4건
통과: floor 4건 전부 pass.
[demo] 위 floor 4건은 frozen=0(아직 아무것도 동결 안 됨)인 시점에도 나타난다 —
[demo] failCases가 promptId 무관하게 floor에 참여하기 때문이다(B1). add-fail은 no-op이 아니다.

== 4. --prompt prompt_v2.txt 전환 + freeze --allow-partial ==
동결됨: prompt_v2.txt — 4건 (snapshot 2026-07-22T12-34-25Z)
미동결 1건:
  - 07-21 ① OmniRoute (저자 주장 한정어 포함)
[demo] OmniRoute만 미동결이다 — 코드펜스는 v2에서 고쳐졌지만, 저자 주장 한정어 프레이밍 프로브가
[demo] v2 재작성의 실제 한정어 누락을 잡아낸 것이다(로드맵 대기가 아니라 도구가 실이슈를 검출한 사례).

== 5. 결정적 check — 동결 계약(floor) 전부 통과 확인 (fixture 스왑 불필요, replay는 check 내장) ==
[check] prompt_v2.txt (replay) — floor 4건
통과: floor 4건 전부 pass.

== 6. 회귀 시연 — 동결 출력을 인위적으로 변조하면 check가 잡아내는가 ==
[demo] 변조 대상 케이스: 07-21 ② fastmcp (저자 주장 2회 포함) (동결 출력에 코드펜스를 인위 삽입)
[check] prompt_v2.txt (replay) — floor 4건
[결정성 버그] 07-21 ② fastmcp (저자 주장 2회 포함): 프로브 동일한데 동결 1 ≠ 재채점 0.75
[회귀] 07-21 ② fastmcp (저자 주장 2회 포함): 코드펜스 출력(금지)
반려: 동결 계약 회귀 1건, 결정성 버그 1건.
[demo] 변조 후 check exit code: 1 (0이 아니어야 정상 — 회귀 감지)
[demo] 원복 후 재검증:
[check] prompt_v2.txt (replay) — floor 4건
통과: floor 4건 전부 pass.

== 7. 정리 — ratchet.json을 fresh init 상태로 리셋(재실행 대비, 멱등) ==
[demo] ratchet.json 리셋 완료.

== Anti-ISC-3 자체 검증 — 프롬프트 원본 무변조 ==
[demo] PASS: prompt.txt/prompt_v2.txt 무변조.

== 전체 git diff 클린 자체 검증 ==
[demo] PASS: examples/cardnews 전체가 원상태다.

[demo] 완주: init -> v1 0/5 -> add-fail 4건 -> v2 freeze 4/5(OmniRoute 미동결) -> 결정적 check 통과 -> 회귀 시연 -> 리셋.
```
