# 실전 적용 피드백 라운드 2 — v0.2.0 재테스트 (2026-07-23)

CHANGES-2026-07-23.md의 항목별 재테스트 프로브를 **적용 A(브리핑, daily-briefing)** 환경에서 실행한 결과다.
적용 B(물어오리, daily-news-reels) 전용 프로브(7·9, 5의 B맥락)는 이 세션 관할 밖이라 미실행.
→ 적용 B의 라운드 2 보고(2 blind 완주 pass 포함 + 신규 발견 P0·P1): [FIELD-FEEDBACK-2026-07-23-round2-B.md](FIELD-FEEDBACK-2026-07-23-round2-B.md)

- **재테스트 환경(적용 A)**: npm **11.12.1** / node **v25.9.0** / macOS(darwin). ratchetlock은 클론+`npm link` 상태(`/opt/homebrew/bin/ratchetlock`).
- **설치 갱신**: `~/ClaudeProject/ratchetlock`에서 `npm install`(prepare 자동 빌드 성공) → `npm run build`(exit 0). link 반영됨.
- 브리핑 계약: `RyanVault/06-BRIEFINGS/ratchet/framing/`(v2 freeze 5케이스, failCases 5). v0.2.0으로 `check` 여전히 exit 0(호환 확인).

## 판정표

| # | 항목 | 프로브 | 판정 |
|---|------|--------|------|
| 1 | 설치 | 클론+link → `command -v ratchetlock && status` exit 0 | **PASS** (+prepare 원인 데이터) |
| 2 | 등록 워크플로 | REGISTER.md만으로 등록 완주 | **부분** (문서 자족적, blind 실습은 미수행) |
| 3 | 라이브 lint | 수제 린터를 `lint --output`으로 대체 | **FAIL** (대체 불가 — 새 막힘) |
| 4 | 드리프트 포지셔닝 | 읽기 판정 | **PASS** |
| 5 | status 케이스 병기 | `status` frozen 줄 케이스 수 | **PASS** |
| 6 | LLM 판정 결정화 | 문구 확인 | **확인** |
| 8 | 정직한 한계 | 읽기 판정 | **PASS** |

---

## 항목 1 — 설치: PASS + prepare 실패 원인 데이터

프로브 통과: `command -v ratchetlock` → `/opt/homebrew/bin/ratchetlock`, `ratchetlock status` exit 0.

**핵심 데이터(요청분)**: 적용 A 환경 **npm 11.12.1 / node v25.9.0**에서 `npm install`의 **prepare 훅이 자동 빌드에 성공**했다(`dist/cli.js` 재생성 확인). 즉 라운드 1에서 겪은 prepare 실패는 이 환경에서 재현되지 않는다.
- 라운드 1의 실패는 서브에이전트가 `/tmp`에 clone 후 install했을 때 발생 — 그때는 `npm run build` 수동 실행이 필요했다.
- 이번엔 영구 경로(`~/ClaudeProject/ratchetlock`) 클론에서 `npm install`만으로 빌드됨.
- **결론**: 적용 B(ubuntu github: 설치 성공)와 합치면, prepare 실패는 **전역 결함이 아니라 환경/설치방식 의존 증상**이라는 판단이 강화된다. npm 11.12.1은 "정상" 쪽 데이터다. 남은 실패 재현은 라운드 1의 정확한 npm 버전이 필요하나, 그 환경(서브에이전트 /tmp)의 npm은 현재 셸과 동일(11.12.1)일 가능성이 높아 — 실패 변수는 **npm 버전이 아니라 `/tmp` clone + link 미적용 상태에서의 install 경로**였을 수 있다. npm 배포가 이 모든 분기를 없앤다는 결론은 유효.

## 항목 3 — 라이브 lint 대체: FAIL (새로 막힌 지점)

`lint` 커맨드 자체는 정상 구현됐다. 그러나 **적용 A(브리핑)에서 수제 린터(`framing_lint.mjs`)를 대체하지 못한다.**

### 실측 증거

| 실행 | 결과 |
|------|------|
| `lint --output <위반 md>` (vars 없음) | 위반 0건, **exit 0** (놓침) |
| `lint --output <위반 md> --vars <메타>` | 위반 2건(스타·신규프레이밍), **exit 1** (잡음) |
| `framing_lint.mjs <같은 위반 md> --strict` | 위반 1건, **exit 1** (vars 없이 잡음) |

위반 md는 `- **foo/bar** ⭐3537 — 오늘 신규 공개된 프레임워크. 10배 빠른 성능.` 한 줄.

### 근본 원인 — 두 프로브의 입력 모델이 다르다

브리핑 계약의 `asserts.js`는 **전 프로브가 vars-gated**다:
```
if (vars.dailyStars && vars.cumulativeStars) ...   // 스타 왜곡
if (typeof vars.ageDays === 'number' && vars.ageDays > 30) ...  // 신규 프레이밍
if (signal.includes('저자 주장') || vars.unverifiedClaim) ...  // 한정어
if (vars.compatUnverified) ...   // 실행 권고
if (vars.reignition) ...         // 재점화
```
즉 판정 메타(생성일·누적/당일 스타 구분·저자주장 플래그·호환성)를 **vars로 받아야만** 작동한다. 이건 "재작성 충실도를 **원본 대조**로 검증"하는 계약 프로브의 본질이다.

반면 라이브 브리핑 md에는 그 vars가 없다 — md는 이미 렌더된 최종 텍스트이고, 원본 메타는 텍스트 밖(생성 시점의 소스)에 있다. 그래서:
- `lint --output <브리핑 md>`는 vars 없이 → **전 프로브 스킵 → false negative**(exit 0).
- 수제 린터는 md를 파싱해 **표면 패턴으로 메타를 추정**(⭐+숫자만 있고 누적 없으면 의심, "신규 공개"+생성일 미표기면 위반)하므로 vars 없이 잡는다.

### 이건 PROBES.md 단일 모듈 패턴으로도 안 풀린다

항목 3 변경②(단일 모듈 패턴: validate.mjs ↔ asserts가 같은 모듈 require)는 **적용 B에 맞는 해법**이다 — 그쪽은 둘 다 "단일 재작성 출력 1건 + vars"라는 **같은 입력 단위**를 쓴다. 적용 A는 다르다:
- 계약 `asserts.js`: 입력 = 개별 항목 output + **vars**(원본 대조형).
- 라이브 `framing_lint.mjs`: 입력 = **md 문서 전체**(파싱→항목 분리→표면 추정형).
입력 단위(항목+vars vs 문서)와 검사 성격(원본 대조 vs 표면 추정)이 근본적으로 달라 **하나의 프로브로 합칠 수 없다**.

### 제안 (다음 라운드 후보)

lint로 라이브 사후 검사를 흡수하려면 셋 중 하나가 필요하다:
1. **md→(항목, vars) 추출 어댑터** — lint 앞단에서 브리핑 md를 파싱해 항목별 output+추정 vars를 만들어 넣는다. 사실상 수제 린터의 파서를 lint 파이프라인에 편입하는 것.
2. **asserts에 vars-free 폴백 모드** — vars가 없으면 표면 패턴으로 추정 검사(수제 린터 로직을 asserts에 통합). 단 계약(대조형)과 라이브(추정형)의 엄밀성 차이를 status에 표기해야 착시 방지(항목 8과 연결).
3. **대체 목표 철회를 문서화** — 계약 프로브(회귀 가드, vars 대조)와 라이브 린터(사후 표면 검사)는 **별개 도구**임을 인정. 이 경우 항목 3의 "수제 린터 대체"는 적용 B 한정 목표로 좁힌다.

현 상태에서 적용 A는 **계약(회귀 가드) + 수제 린터(라이브) 이중 운영**이 불가피하며, 규칙 SSOT는 BRIEFING_SPEC을 정본으로 두고 asserts.js·framing_lint.mjs를 파생으로 동기화하는 방식으로 이미 못박아 두었다(드리프트 위험 완화).

## 항목 5 — status 케이스 병기: PASS

`frozen: 1건 (케이스 5건)` 병기 확인. v0.2.0 재설치로 반영됨.

## 항목 4 / 8 — 읽기 판정: PASS (실사용 일치)

- **4 (드리프트 전면 배치)**: README "채점하는 자(프로브)가 조용히 헐거워지는 것도 잡는다" — 실사용과 정확히 일치. 이번 재테스트 중에도 asserts.js에 SSOT 주석을 넣자 프로브 해시가 바뀌어 `check`가 `[probe drift]`를 검출했고, 재동결로 해소했다. 포지셔닝이 과장이 아님을 실측으로 재확인.
- **8 (정직한 한계)**: README "라이브 통과는 근사치", "계약 통과 = 안전으로 읽으면 안 된다" + AGENTS.md "에이전트가 통과=안전 보고 금지" — 라운드 1에서 지적한 "가짜 안전감"과 정확히 일치. 특히 항목 3의 false negative(vars 없는 lint가 위반을 놓치고 exit 0)가 이 경고의 실증 사례다.

## 항목 6 — LLM 판정 결정화: 확인

README 로드맵에 "판정도 fixture처럼 동결 / check는 그 판정을 replay / 루브릭 해시 바뀔 때만 재판정"으로 채택 확인. 라운드 1 제안이 공식 방향이 됐다.

## 항목 2 — 등록 워크플로: 부분

REGISTER.md는 5단계 퀵스타트 + demo.sh 리셋 경고 + 준비물 체크리스트로 구조가 자족적이다. 다만 이 세션은 이미 framing 계약을 등록해본 상태라 "cardnews를 안 보는" blind 실습의 순수성을 만들 수 없어, 문서 자족성은 **구조상 충분해 보임**으로만 판정한다(엄밀 프로브는 미수행). 순수 blind 완주 판정은 계약 경험이 없는 세션이 해야 유효.

---

## 요약

- **PASS**: 1(설치, +prepare는 환경 의존 확증), 4·5·8(포지셔닝·status·정직한 한계 — 실사용 일치), 6(로드맵 채택).
- **FAIL**: 3(라이브 lint가 브리핑 수제 린터 대체 불가 — asserts.js vars-gated vs 라이브 md는 vars 부재. lint 커맨드 자체는 정상이나 입력 모델 불일치가 근본).
- **부분**: 2(문서 자족적이나 blind 실습 미수행).
- **다음 라운드 핵심**: 적용 A의 라이브 검사를 lint로 흡수할지(어댑터/폴백) 아니면 별개 도구로 인정할지 결정. 현재는 계약+수제 린터 이중 운영 + SSOT 파생 동기화로 운영 중.
