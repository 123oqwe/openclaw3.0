/* @vitest-environment jsdom */

import type { OutcomeDetail } from "@openclaw/outcomes-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import "./outcomes-page.ts";
import {
  createGateway,
  outcomeDetail,
  type OutcomesPageTestElement,
} from "./outcomes-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OutcomesPage freshness", () => {
  it("renders a timer-expired observation stale and clears the latch on a fresh observation", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(100);
    const client = {
      request: vi.fn(async () => ({ outcomes: [] })),
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway: createGateway(client) } as ApplicationContext;
    document.body.append(page);
    const internalPage = page as unknown as {
      replaceOutcome(detail: OutcomeDetail, requestStartedAt: number): void;
      selectedOutcomeId: string | null;
    };
    internalPage.selectedOutcomeId = "outcome-a";

    internalPage.replaceOutcome(
      {
        ...outcomeDetail("outcome-a", "Outcome A"),
        observedAt: 1_000,
        recheckAfter: 1_100,
      },
      100,
    );

    await page.updateComplete;
    expect(page.querySelector('[data-outcome-readiness="incomplete"]')).not.toBeNull();
    vi.advanceTimersByTime(100);
    await page.updateComplete;
    expect(page.querySelector('[data-outcome-readiness="stale"]')).not.toBeNull();

    internalPage.replaceOutcome(
      {
        ...outcomeDetail("outcome-a", "Outcome A"),
        observedAt: 2_000,
        recheckAfter: 2_100,
      },
      100,
    );

    await page.updateComplete;
    expect(page.querySelector('[data-outcome-readiness="stale"]')).toBeNull();
    expect(page.querySelector('[data-outcome-readiness="incomplete"]')).not.toBeNull();
  });
});
