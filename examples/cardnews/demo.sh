#!/usr/bin/env bash
# demo.sh — 카드뉴스 프롬프트 v1 -> v2 개선을 ratchetlock으로 재현하는 플래그십 데모.
#
# 기본(인자 없음): fixture 재생 모드. fixtures/{baseline,ab}.json에 담긴 실측 claude 출력을
#   replay-provider.js로 되돌려 현재 asserts.js로 재채점한다 — claude 구독 없이 완주한다(M3).
# --live: 실제 provider.sh(claude CLI 헤드리스 호출)를 그대로 태운다. claude CLI 설치가 필요하다.
#
# 흐름: init(v1) -> v1 실측 0/5 -> add-fail 4건 -> --prompt prompt_v2.txt 전환(B1 시연) ->
#   freeze --allow-partial(4건 동결, OmniRoute 미동결) -> 결정적 check 통과 -> 회귀 시연(변조/원복) ->
#   ratchet.json 리셋. 재실행 가능(멱등)하며 종료 시 examples/cardnews를 원상태로 되돌린다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST="$REPO_ROOT/dist"
CLI=(node "$DIST/cli.js")

LIVE=0
if [[ "${1:-}" == "--live" ]]; then
  LIVE=1
fi

cd "$SCRIPT_DIR"
mkdir -p .ratchet/demo

echo "[demo] dist 빌드 확인 중..."
(cd "$REPO_ROOT" && npm run build >/dev/null)

# ── 정리 트랩: 어떤 경로로 끝나든 promptfooconfig.yaml 원본을 복원한다 ──
CONFIG_SWAPPED=0
restore_config() {
  if [[ "$CONFIG_SWAPPED" == "1" && -f .ratchet/demo/promptfooconfig.yaml.bak ]]; then
    cp .ratchet/demo/promptfooconfig.yaml.bak promptfooconfig.yaml
    CONFIG_SWAPPED=0
  fi
}
trap restore_config EXIT

section() { echo; echo "== $1 =="; }

# fixture(promptfoo -o 캡처)에서 (description -> output) replay map을 뽑는다.
# replay-provider.js가 이 맵을 caseId(description) 키로 되돌린다.
build_replay_map() {
  local fixture_file="$1" prompt_filter="$2" out_file="$3"
  node -e "
    const fs = require('fs'); const path = require('path');
    function extractPromptId(label) {
      const m = (label || '').match(/^(\\S+):\\s/);
      return m ? path.basename(m[1]) : (label || '');
    }
    const data = JSON.parse(fs.readFileSync('$fixture_file', 'utf-8'));
    const rows = data.results.results;
    const map = {};
    for (const r of rows) {
      const pid = extractPromptId(r.prompt && r.prompt.label);
      if ('$prompt_filter' && pid !== '$prompt_filter') continue;
      const desc = r.testCase && r.testCase.description;
      const out = r.response && r.response.output;
      if (desc) map[desc] = typeof out === 'string' ? out : JSON.stringify(out);
    }
    fs.writeFileSync('$out_file', JSON.stringify(map, null, 2) + '\n');
  "
}

# promptfooconfig.yaml의 providers를 replay-provider.js로 일시 치환하고 ratchetlock 명령을
# 그대로 실행한 뒤 즉시 원복한다(freeze.ts/check.ts 수정 없이 fixture 재생을 태우는 방법 —
# 두 커맨드 모두 state.target.config를 cwd 기준 그대로 읽으므로, 그 파일 자체를 잠깐 바꿔치기한다).
# --live면 스왑 없이 진짜 provider.sh(claude CLI)를 그대로 태운다.
with_fixture_provider() {
  local replay_map="$1"
  shift
  if [[ "$LIVE" == "1" ]]; then
    "${CLI[@]}" "$@"
    return $?
  fi
  cp promptfooconfig.yaml .ratchet/demo/promptfooconfig.yaml.bak
  CONFIG_SWAPPED=1
  node -e "
    const { createReplayConfig } = require('$DIST/promptfoo.js');
    const path = require('node:path');
    const fs = require('node:fs');
    const replayProviderPath = path.resolve('$DIST/replay-provider.js');
    const generated = createReplayConfig(
      path.resolve('promptfooconfig.yaml'),
      replayProviderPath,
      path.resolve('.ratchet/demo'),
    );
    fs.copyFileSync(generated, 'promptfooconfig.yaml');
  "
  local status=0
  RATCHETLOCK_REPLAY_FILE="$SCRIPT_DIR/$replay_map" PROMPTFOO_CACHE_ENABLED=false "${CLI[@]}" "$@" || status=$?
  restore_config
  return "$status"
}

echo "########################################################"
echo "# ratchetlock 플래그십 데모 — 카드뉴스 프롬프트 v1 -> v2"
echo "########################################################"
if [[ "$LIVE" == "1" ]]; then
  echo "[demo] --live 모드: 실제 provider.sh(claude CLI 구독) 호출. claude CLI 설치가 필요하다."
else
  echo "[demo] fixture 재생 모드(기본): claude 구독 없이 fixtures/*.json 실측 데이터로 재현한다."
fi

section "0. 초기화 — 이전 상태 리셋 후 init(activePrompt=prompt.txt)"
rm -f ratchet.json
"${CLI[@]}" init -c promptfooconfig.yaml

section "1. v1(prompt.txt) 실측 확인 — check --live"
if [[ "$LIVE" != "1" ]]; then
  build_replay_map fixtures/baseline.json prompt.txt .ratchet/demo/replay-map-v1.json
fi
with_fixture_provider .ratchet/demo/replay-map-v1.json check --live
echo
node -e "
  const d = JSON.parse(require('fs').readFileSync('.ratchet/last-eval.json', 'utf-8'));
  const rows = d.results.filter((r) => r.promptId === 'prompt.txt');
  const pass = rows.filter((r) => r.pass).length;
  console.log('[demo] v1(prompt.txt) 실측 스코어카드: ' + pass + '/' + rows.length + ' pass');
  for (const r of rows) {
    const reason = r.pass ? '' : ' — ' + (r.failedAsserts.map((a) => a.reason).join(', ') || 'fail');
    console.log('  - ' + r.caseId + ': ' + (r.pass ? 'PASS' : 'FAIL') + reason);
  }
"

section "2. v1 실패 케이스 4건을 add-fail로 영구 등록 (OmniRoute는 3단계에서 설명 — 제외)"
FAIL_CASES=(
  "07-19 ② Claude Code 업데이트 (기술 용어 밀도 최고)"
  "07-20 ① Fable 5 한도 개방 (구독 정책 — 과장 유혹 높음)"
  "07-21 ⑤ Anthropic 그랜트 (날짜·금액 보존 확인)"
  "07-21 ② fastmcp (저자 주장 2회 포함)"
)
for c in "${FAIL_CASES[@]}"; do
  "${CLI[@]}" add-fail --from-last "$c"
done

section "3. B1 시연 — v2로 아직 전환·동결 전인데 add-fail 케이스가 이미 floor에 참여하는가"
if [[ "$LIVE" != "1" ]]; then
  build_replay_map fixtures/ab.json prompt_v2.txt .ratchet/demo/replay-map-v2.json
fi
with_fixture_provider .ratchet/demo/replay-map-v2.json check --live --prompt prompt_v2.txt
echo "[demo] 위 floor 4건은 frozen=0(아직 아무것도 동결 안 됨)인 시점에도 나타난다 —"
echo "[demo] failCases가 promptId 무관하게 floor에 참여하기 때문이다(B1). add-fail은 no-op이 아니다."

section "4. --prompt prompt_v2.txt 전환 + freeze --allow-partial"
with_fixture_provider .ratchet/demo/replay-map-v2.json \
  freeze --prompt prompt_v2.txt --allow-partial --note "cardnews v1->v2 파일럿(fixture 재생)"
echo "[demo] OmniRoute만 미동결이다 — 코드펜스는 v2에서 고쳐졌지만, 저자 주장 한정어 프레이밍 프로브가"
echo "[demo] v2 재작성의 실제 한정어 누락을 잡아낸 것이다(로드맵 대기가 아니라 도구가 실이슈를 검출한 사례)."

section "5. 결정적 check — 동결 계약(floor) 전부 통과 확인 (fixture 스왑 불필요, replay는 check 내장)"
"${CLI[@]}" check

section "6. 회귀 시연 — 동결 출력을 인위적으로 변조하면 check가 잡아내는가"
cp ratchet.json .ratchet/demo/ratchet.json.pretamper.bak
node -e "
  const fs = require('fs');
  const d = JSON.parse(fs.readFileSync('ratchet.json', 'utf-8'));
  const snap = d.frozen[d.frozen.length - 1];
  const caseId = Object.keys(snap.cases)[0];
  console.log('[demo] 변조 대상 케이스: ' + caseId + ' (동결 출력에 코드펜스를 인위 삽입)');
  snap.cases[caseId].output = '\`\`\`json\n' + snap.cases[caseId].output + '\n\`\`\`';
  fs.writeFileSync('ratchet.json', JSON.stringify(d, null, 2) + '\n');
"
set +e
"${CLI[@]}" check
TAMPER_STATUS=$?
set -e
echo "[demo] 변조 후 check exit code: $TAMPER_STATUS (0이 아니어야 정상 — 회귀 감지)"
cp .ratchet/demo/ratchet.json.pretamper.bak ratchet.json
if [[ "$TAMPER_STATUS" == "0" ]]; then
  echo "[demo] 오류: 변조된 출력을 check가 잡아내지 못했다 — 회귀 감지 실패." >&2
  exit 1
fi
echo "[demo] 원복 후 재검증:"
"${CLI[@]}" check

section "7. 정리 — ratchet.json을 fresh init 상태로 리셋(재실행 대비, 멱등)"
rm -f ratchet.json
"${CLI[@]}" init -c promptfooconfig.yaml >/dev/null
echo "[demo] ratchet.json 리셋 완료."

section "Anti-ISC-3 자체 검증 — 프롬프트 원본 무변조"
if git -C "$SCRIPT_DIR" diff --exit-code prompt.txt prompt_v2.txt; then
  echo "[demo] PASS: prompt.txt/prompt_v2.txt 무변조."
else
  echo "[demo] FAIL: 프롬프트 원본이 변경되었다." >&2
  exit 1
fi

section "전체 git diff 클린 자체 검증"
if git -C "$REPO_ROOT" diff --exit-code -- examples/cardnews > /dev/null; then
  echo "[demo] PASS: examples/cardnews 전체가 원상태다."
else
  echo "[demo] 경고: examples/cardnews에 변경 흔적이 남았다." >&2
  git -C "$REPO_ROOT" diff --stat -- examples/cardnews
  exit 1
fi

echo
echo "[demo] 완주: init -> v1 0/5 -> add-fail 4건 -> v2 freeze 4/5(OmniRoute 미동결) -> 결정적 check 통과 -> 회귀 시연 -> 리셋."
