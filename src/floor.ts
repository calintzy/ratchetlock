import type { FrozenSnapshot, RatchetState } from "./state.js";

/**
 * floor(래칫 바닥) 도출 — §3.3 B1. check가 "여전히 통과할 것"을 요구하는 케이스 집합이다.
 *
 * 두 원천의 층위가 다르다(§3.3):
 *  - frozen[]는 promptId-scoped: activePrompt와 일치하는 스냅샷이 pass:true로 기록한 caseId만 참여한다
 *    (특정 프롬프트 버전이 그 출력으로 통과했다는 스냅샷이므로).
 *  - failCases[]는 프롬프트-무관: expectedPass:true인 caseRef는 activePrompt와 상관없이 항상 참여한다.
 *    failCase의 promptId는 "어느 버전에서 처음 잡혔나"의 provenance 기록일 뿐 floor 참여 필터가 아니다(B1).
 *    "한번 잡은 실패는 어느 버전에서든 통과를 요구한다"는 래칫 서사 — v1에서 잡은 실패는 v2 전환 후에도 게이트에 남는다.
 */
export interface FloorResult {
  /** 통과 필수 케이스 caseId 합집합(정렬됨) */
  caseIds: string[];
  /** activePrompt 동결 스냅샷에서 온 caseId */
  fromFrozen: string[];
  /** failCases에서 온 caseId(프롬프트 무관) */
  fromFailCases: string[];
}

export function deriveFloor(state: RatchetState): FloorResult {
  const fromFrozen = new Set<string>();
  for (const snap of state.frozen) {
    // frozen[]는 promptId-scoped — activePrompt와 일치하는 스냅샷만 본다.
    if (snap.promptId !== state.activePrompt) continue;
    for (const [caseId, c] of Object.entries(snap.cases)) {
      if (c.pass === true) fromFrozen.add(caseId);
    }
  }

  const fromFailCases = new Set<string>();
  for (const fc of state.failCases) {
    // failCases[]는 프롬프트-무관 — promptId(provenance)로 필터하지 않는다(B1).
    if (fc.expectedPass) fromFailCases.add(fc.caseRef);
  }

  const union = new Set<string>([...fromFrozen, ...fromFailCases]);
  return {
    caseIds: [...union].sort(),
    fromFrozen: [...fromFrozen].sort(),
    fromFailCases: [...fromFailCases].sort(),
  };
}

/**
 * activePrompt(또는 지정 프롬프트)에 바인딩된 가장 최근 동결 스냅샷을 찾는다.
 * 결정적 check의 replay 출처이자 verdict 동결 대조(처방 2)의 기준 기록이다.
 */
export function latestFrozenFor(
  state: RatchetState,
  promptId: string,
): FrozenSnapshot | undefined {
  return [...state.frozen].reverse().find((snap) => snap.promptId === promptId);
}
