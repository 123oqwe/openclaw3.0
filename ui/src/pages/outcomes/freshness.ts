import type { OutcomeDetail } from "@openclaw/outcomes-contract";

export const OUTCOME_DETAIL_MAX_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/**
 * Derives a display-only deadline from the server observation window. The
 * monotonic request start prevents a client wall-clock rollback from extending
 * permissions implied by a formerly-current projection.
 */
export function outcomeDetailFreshnessDeadline(
  detail: Pick<OutcomeDetail, "observedAt" | "recheckAfter">,
  requestStartedAt: number,
): number | null {
  if (detail.recheckAfter === null) {
    return null;
  }
  const serverWindow = Math.max(0, detail.recheckAfter - detail.observedAt);
  return requestStartedAt + Math.min(serverWindow, OUTCOME_DETAIL_MAX_FRESHNESS_MS);
}

export function isOutcomeDetailFresh(
  deadline: number | null,
  monotonicNow: number,
): boolean {
  return deadline === null || monotonicNow < deadline;
}
