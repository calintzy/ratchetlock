#!/bin/bash
# promptfoo exec 프로바이더 — 구독 기반 claude CLI 헤드리스 호출 (API 키 불필요).
# 공개 repo 재현성(M3): 하드코딩 경로(/opt/homebrew/bin/claude) 대신 PATH에서 해석한다.
# claude CLI가 없으면 명확히 안내하고 종료한다 — 결정적 check는 이 프로바이더를 타지 않는다(replay).
CLAUDE_BIN="$(command -v claude)"
if [ -z "$CLAUDE_BIN" ]; then
  echo "claude CLI를 찾을 수 없습니다. --live 평가는 claude CLI가 필요합니다(결정적 check는 불필요)." >&2
  exit 1
fi
exec "$CLAUDE_BIN" --model sonnet -p "$1"
