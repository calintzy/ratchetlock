# AGENTS.md — AI 에이전트용 ratchetlock 운용 계약

이 문서는 사람이 아니라 **이 도구를 조작하는 AI 에이전트**를 위한 실행 계약이다. 도구가 무엇인지는
[README.md](README.md), 설계가 왜 이런지는 [ARCHITECTURE.md](ARCHITECTURE.md)를 읽어라. 이 문서는
"어떻게 굴리고, 무엇을 절대 하지 말 것인가"만 다룬다.

한 줄 요약: ratchetlock은 반복 사용하는 LLM 프롬프트의 **회귀 게이트**다. 판정의 전부는 exit code와
stdout verdict이며, 너의 임무는 게이트를 **통과시키는 것이 아니라 게이트가 잡은 것을 존중하는 것**이다.

## 전제 조건 (작업 시작 전 확인)

- `command -v ratchetlock` — 없으면: 리포에서 `npm install && npm link` (prepare 훅이 빌드까지 돈다).
- 모든 커맨드는 **`promptfooconfig.yaml`이 있는 디렉토리에서** 실행한다. 상태는 그 옆 `ratchet.json`.
- 프로브(asserts) 파일은 **CommonJS**(`module.exports = (output, context) => ...`)여야 한다. ESM이면 로드가 깨진다.
- tests 파일이 YAML 리스트 포맷이어야 `add-fail`의 자동 append가 동작한다.

## 커맨드 계약

| 커맨드 | 효과 | exit 0 | exit 1 | LLM 호출 |
|--------|------|--------|--------|----------|
| `init [-c config]` | `ratchet.json` 생성 (읽기 전용 스캔) | 생성됨 | config 탐지/파싱 실패 | 안 함 |
| `check [--prompt L] [--probe-locked]` | 기준선 회귀 검사 (동결 출력 replay + 현재 프로브 재채점) | 무회귀 | 회귀·스냅샷 불일치·(--probe-locked 시) 프로브 드리프트 | 안 함 |
| `check --live` | 실제 모델로 fresh 평가 후 기준선 대조 | 무회귀 | 회귀 | **함** |
| `freeze [--prompt L] [--note T] [--allow-partial]` | 통과 케이스를 출력 스냅샷째 동결, 기준선 상승 | 동결됨 | 실패 존재(--allow-partial 없이) | **함** |
| `add-fail --from-last <caseId>` | 직전 평가의 실패를 영구 가드로 등록 | 등록됨 | 케이스 못 찾음 | 안 함 |
| `lint --output <파일> [--vars <JSON>] [--prompt L]` | 등록된 프로브를 새 출력 1건에 적용(신규 왜곡 검사). last-eval 갱신 → 위반 케이스를 add-fail로 승격 가능 | 위반 없음 | 프로브 위반 | 안 함 |
| `status` | 상태·드리프트 표시 (읽기 전용) | 항상 | — | 안 함 |

출력 파싱: verdict는 **stdout**에 `통과:` / `반려:` 프리픽스로 나온다. 상세 로그는 `.ratchet/` 아래.
직전 평가의 정규화 결과는 `.ratchet/last-eval.json`(add-fail --from-last가 읽는 파일)에 있다.

**`lint`의 vars 의존성 주의**: `lint`는 프로브를 그대로 재사용한다. 프로브가 `context.vars`를 참조하는
원본 대조형이면 그 `vars`를 `--vars`로 반드시 같이 넘겨야 한다 — 안 그러면 그 프로브들은 스킵되고,
위반이 있어도 exit 0으로 통과한 것처럼 보인다. exit 0을 곧이곧대로 "위반 없음"으로 보고하기 전에
프로브가 vars-gated인지부터 확인해라.

## 상황 → 행동 결정표

| 상황 | 행동 |
|------|------|
| 새 프롬프트를 계약으로 등록하라는 지시 | 아래 레시피 A (전체 5단계 퀵스타트는 [docs/REGISTER.md](docs/REGISTER.md)) |
| 프롬프트를 수정했고 효과를 확인해야 함 | `check --live` → 좋아졌으면 `freeze`, 새 실패가 잡혔으면 `add-fail` |
| 오늘 나온 새 출력 1건에 신규 왜곡을 검사하라는 요청 | `lint --output <파일>` (프로브가 vars를 쓰면 `--vars` 필수 — 없으면 스킵되어 놓친다) → 위반이 잡히면 입력을 tests에 넣고 `add-fail`로 승격 |
| `check`가 exit 1 (회귀) | **프롬프트/원인을 고쳐라.** 프로브나 상태 파일을 고치는 방향은 금지 (아래 금지 행동) |
| stdout에 `[스냅샷 불일치]` | `ratchet.json` 무결성 문제 — 손대지 말고 사람에게 보고 |
| 프로브 해시 드리프트 경고 | 프로브가 동결 이후 바뀐 것. 의도된 변경인지 사람에게 확인 → 의도면 `freeze`로 재동결 |
| 전 케이스 통과 상태 도달 | `freeze --note "<무엇을 개선했는지>"`로 기준선 승격 |
| 일부만 통과하는 신규 등록 | `freeze --allow-partial` + 미동결 케이스를 보고에 명시 |

## 레시피 A — 새 프롬프트를 계약으로 등록

1. `examples/cardnews/`를 참조 구조로 삼는다 (동작하는 실물 예제다).
2. 파일 4개를 만든다: 프롬프트 파일(`.txt`, `{{변수}}` 템플릿), `tests.yaml`(대표 입력 — YAML 리스트),
   `asserts.js`(CJS, `{pass, score, reason}` 반환), `promptfooconfig.yaml`(prompts/providers/defaultTest의
   `javascript: file://asserts.js`/tests 연결).
3. `ratchetlock init` → `ratchetlock freeze`(전부 통과) 또는 `freeze --allow-partial`(부분 — 미동결 케이스 보고).
4. 이미 알고 있는 실패 유형이 있으면 재현 입력을 tests에 넣고 `add-fail`로 등록한다.

## 레시피 B — 기존 계약의 프롬프트 개선

1. 원본을 수정하지 말고 **새 버전 파일**을 만든다 (`prompt.txt` → `prompt_v2.txt`), config의 prompts에 추가.
2. `ratchetlock check --live --prompt prompt_v2.txt` — 기준선(이전 버전에서 등록된 실패 가드 포함)과 대조된다.
3. 통과하면 `freeze --prompt prompt_v2.txt` — activePrompt가 v2로 넘어가고 기준선이 승격된다.
4. 실패가 남으면: 실패 사유를 읽고 **프롬프트에 제약을 추가**하는 방향으로 고친다(기존 문구를 갈아엎지 말 것).

## 금지 행동 — 어기면 도구의 존재 이유가 사라진다

- **check를 통과시키려고 프로브(asserts)를 약화하거나 `failCases`를 삭제하지 마라.** 빨간불이 도구의
  목적이다. 프로브 수정이 정당해 보여도 반드시 사람 승인을 먼저 받아라.
- **`ratchet.json`을 손으로 편집하지 마라.** 모든 상태 변이는 CLI 커맨드로만 한다.
- **회귀가 남은 상태를 `freeze --allow-partial`로 덮지 마라.** allow-partial은 신규 등록의 부분 동결용이지
  회귀 은폐용이 아니다.
- **사용자의 프롬프트 원본을 수정하지 마라.** 개선은 새 버전 파일 + `--prompt` 전환으로 한다.
- **exit code를 무시하고 "통과했다"고 보고하지 마라.** 판정 근거는 exit code와 stdout verdict 인용이 전부다.

## 알려진 제약

- 기본 `check`는 replay라 **프롬프트 수정의 효과를 보지 못한다** (저장된 출력은 옛 프롬프트의 것). 효과
  확인은 반드시 `--live` 또는 `freeze`.
- `--live`/`freeze`는 config의 provider가 실행 가능해야 한다 (예: `claude` CLI가 PATH에 있어야).
- replay는 activePrompt 하나 기준으로만 돈다 (다중 프롬프트 동시 replay 미지원).
- 프로브의 프레이밍 체크는 결정적 키워드 검사다. LLM 기반 의미 왜곡 판정은 로드맵이며 아직 없다 —
  의미 왜곡 검증을 요구받으면 "현재 미지원"이라고 답하라.
- **라이브 통과는 프로덕션 안전을 보장하지 않는다.** 계약 평가와 프로덕션은 모델·컨텍스트·호출
  방식이 다를 수 있다. `check --live` 통과를 "프로덕션 게이트 통과"로 보고하지 마라(근사치일 뿐).
- **결정적 `check`의 초록불은 "계약을 아무도 안 건드렸다"는 뜻이지 "프롬프트가 지금도 잘 작동한다"가
  아니다.** 모델 드리프트·입력 분포 변화는 결정적 check가 못 본다 — 그건 `check --live`로만 보인다.
  이 한계는 [README의 "정직한 한계"](README.md#정직한-한계)에 정리돼 있다.
