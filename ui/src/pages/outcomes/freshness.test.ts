import { describe, expect, it } from "vitest";
import { isOutcomeDetailFresh, outcomeDetailFreshnessDeadline } from "./freshness.ts";

const twentyFourHoursMs = 24 * 60 * 60 * 1000;

describe("Outcome detail freshness", () => {
  it("uses the server observation window from the monotonic request start", () => {
    const deadline = outcomeDetailFreshnessDeadline(
      { observedAt: 1_000, recheckAfter: 1_000 + 60_000 },
      50,
    );

    expect(deadline).toBe(60_050);
    expect(isOutcomeDetailFresh(deadline, 60_049)).toBe(true);
    expect(isOutcomeDetailFresh(deadline, 60_050)).toBe(false);
  });

  it("caps an overlong server window at twenty-four hours", () => {
    expect(
      outcomeDetailFreshnessDeadline(
        { observedAt: 1, recheckAfter: 1 + twentyFourHoursMs * 2 },
        20,
      ),
    ).toBe(20 + twentyFourHoursMs);
  });

  it("does not create a display deadline when the server has none", () => {
    const deadline = outcomeDetailFreshnessDeadline({ observedAt: 1, recheckAfter: null }, 20);

    expect(deadline).toBeNull();
    expect(isOutcomeDetailFresh(deadline, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("is unaffected by client wall-clock rollback because callers supply monotonic time", () => {
    const deadline = outcomeDetailFreshnessDeadline({ observedAt: 100, recheckAfter: 200 }, 10_000);

    expect(isOutcomeDetailFresh(deadline, 10_099)).toBe(true);
    expect(isOutcomeDetailFresh(deadline, 10_100)).toBe(false);
  });
});
