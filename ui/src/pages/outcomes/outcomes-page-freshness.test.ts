/* @vitest-environment jsdom */

import type { OutcomeDetail } from "@openclaw/outcomes-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
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

  it("does not offer new verification or acceptance after the detail freshness deadline", async () => {
    const client = {
      request: vi.fn(async () => ({ outcomes: [] })),
    } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.verifyCriterion", "outcomes.accept"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);
    const internalPage = page as unknown as {
      detail: OutcomeDetail | null;
      detailExpired: boolean;
      observeGatewaySnapshot(snapshot: ApplicationGatewaySnapshot): void;
      selectedOutcomeId: string | null;
    };
    internalPage.observeGatewaySnapshot(gateway.snapshot as ApplicationGatewaySnapshot);
    internalPage.selectedOutcomeId = "outcome-a";
    internalPage.detail = {
      ...outcomeDetail("outcome-a", "Outcome A"),
      closureHash: "c".repeat(64),
      criteria: [
        {
          ...outcomeDetail("outcome-a", "Outcome A").criteria[0]!,
          evidenceSetHash: "e".repeat(64),
        },
      ],
      nextActions: ["review-evidence", "accept"],
      phase: "active",
      planGeneration: 1,
      planHash: "p".repeat(64),
      recheckAfter: 2,
    };
    internalPage.detailExpired = true;

    await page.updateComplete;

    expect(page.querySelector('[data-outcome-action="review-evidence"]')).toBeNull();
    expect(page.querySelector('[data-outcome-action="accept"]')).toBeNull();
  });
});
