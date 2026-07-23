import type { CaseResult } from "./promptfoo.js";

/**
 * 케이스별 라이브 재시도 오케스트레이터 — round2-B P1.
 *
 * `check --live`/`freeze`의 라이브 eval은 LLM 비결정성(JSON 앞 서두 텍스트·코드펜스 등 형식 위반)으로
 * 케이스가 늘수록 전건 동시 통과가 확률 게임이 된다(실측 8회 전패). 이 모듈은 **실패한 케이스만**
 * 최대 N회까지 다시 태워, 통과하면 확정하고 N회 후에도 실패면 최종 실패로 남긴다.
 *
 * 결정성 게이트(replay 경로)에는 무의미하다 — replay 출력은 고정이라 재시도해도 결과가 같다.
 * 따라서 재시도는 라이브 경로(--live/freeze)에서만 유효하다.
 *
 * 채점은 여전히 promptfoo가 한다(Anti-ISC-1) — 이 모듈은 재평가를 지시하고 결과를 병합할 뿐,
 * pass/fail 판정을 재구현하지 않는다.
 */

/** 재시도 결과: 병합된 최종 결과 + 케이스별 통과 시점 + 최종 실패 케이스. */
export interface RetryOutcome {
  /** 초기 결과에서 대상 프롬프트의 실패 케이스만 재시도 결과로 갱신한 배열(그 외 행은 원본 보존). */
  results: CaseResult[];
  /** caseId → 몇 번째 재시도(1-based)에 통과했는지. 초기 통과분은 담지 않는다. */
  passedOnRetry: Map<string, number>;
  /** N회 후에도 실패로 남은 caseId 목록. */
  finalFailed: string[];
}

/**
 * `--retry <N>` 인자를 검증해 음이 아닌 정수로 변환한다. 미지정이면 0(재시도 없음, 하위호환).
 * 정수가 아니거나 음수면 Error를 던진다(호출자가 stderr+exit 1로 처리).
 */
export function parseRetry(raw: string | undefined): number {
  if (raw == null) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--retry 값은 0 이상의 정수여야 합니다: '${raw}'`);
  }
  return n;
}

/** 실패 케이스만 다시 태우기 위한 promptfoo `--filter-pattern` 정규식을 만든다(앵커+이스케이프). */
export function buildFilterPattern(caseIds: string[]): string {
  const escaped = caseIds.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `^(${escaped.join("|")})$`;
}

/**
 * 대상 프롬프트의 실패 케이스만 최대 maxRetries회 재평가한다(케이스별, 전건 재실행 아님).
 *
 * @param initialResults 최초 라이브 eval 결과(대상·타 프롬프트 혼재 가능).
 * @param targetPrompt 재시도 대상 프롬프트 id.
 * @param maxRetries N. 0이면 재시도 없이 initialResults를 그대로 반환(하위호환).
 * @param reeval 주어진 caseId만 다시 태워 CaseResult[]를 돌려주는 함수(promptfoo 재호출을 감싼다).
 *               테스트에서 실 LLM 없이 시퀀스를 주입할 수 있게 유일한 seam으로 분리했다.
 * @param log 재시도 진행 요약 1줄 출력(stdout 위생 — "재시도 k/N: caseX"). 미지정이면 침묵.
 */
export async function retryFailedLiveCases(
  initialResults: CaseResult[],
  targetPrompt: string,
  maxRetries: number,
  reeval: (caseIds: string[]) => Promise<CaseResult[]>,
  log?: (message: string) => void,
): Promise<RetryOutcome> {
  // 대상 프롬프트 행만 caseId로 인덱싱(pass·fail 모두). 재시도는 이 맵의 실패분만 갱신한다.
  const byCase = new Map<string, CaseResult>();
  for (const r of initialResults) {
    if (r.promptId === targetPrompt) byCase.set(r.caseId, r);
  }

  const passedOnRetry = new Map<string, number>();
  let failing = [...byCase.entries()].filter(([, r]) => !r.pass).map(([id]) => id);

  for (let attempt = 1; attempt <= maxRetries && failing.length > 0; attempt++) {
    const rerun = await reeval(failing);
    // 재평가 결과에서 대상 프롬프트·재시도 대상 caseId만 반영한다(타 프롬프트/무관 행 무시).
    const rerunByCase = new Map<string, CaseResult>();
    for (const r of rerun) {
      if (r.promptId === targetPrompt) rerunByCase.set(r.caseId, r);
    }

    const stillFailing: string[] = [];
    for (const caseId of failing) {
      const updated = rerunByCase.get(caseId);
      if (updated) byCase.set(caseId, updated); // 재평가 결과 반영(통과/실패 무관, 최신값 우선)
      if (updated?.pass) {
        passedOnRetry.set(caseId, attempt);
        log?.(`재시도 ${attempt}/${maxRetries}: ${caseId} → 통과`);
      } else {
        stillFailing.push(caseId);
        log?.(`재시도 ${attempt}/${maxRetries}: ${caseId} → 실패`);
      }
    }
    failing = stillFailing;
  }

  // 최종 결과: 대상 프롬프트 행은 byCase의 최신값으로 치환, 그 외 행은 원본 보존(순서 유지).
  const results = initialResults.map((r) =>
    r.promptId === targetPrompt ? (byCase.get(r.caseId) ?? r) : r,
  );

  return { results, passedOnRetry, finalFailed: failing };
}
