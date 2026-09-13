/* @vitest-environment jsdom */

import type { OutcomeDetail } from "@openclaw/outcomes-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import "./outcomes-page.ts";
import {
  createGateway,
  createGatewayWithSnapshotListener,
  outcomeDetail,
  outcomeSummary,
  type OutcomesPageTestElement,
} from "./outcomes-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OutcomesPage", () => {
  it("renders authorized historical decision and acceptance plans without restoring restricted refs", async () => {
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        const detail = outcomeDetail("outcome-a", "Outcome A");
        return Promise.resolve({
          outcome: {
            ...detail,
            objective: "Current Outcome objective after the contract changed",
            decisions: [
              {
                criterionId: "criterion-1",
                decidedAt: 2,
                decidedPlan: {
                  contractRevision: 1,
                  criteria: [
                    {
                      id: "criterion-1",
                      required: true,
                      sourcesVisibility: "complete" as const,
                      text: "Original release criterion",
                      workRefs: detail.criteria[0]!.workRefs,
                    },
                  ],
                  objective: "Original Outcome objective",
                  outcomeId: detail.id,
                  planGeneration: 0,
                },
                decidedRevision: 2,
                evidenceSetHash: "e".repeat(64),
                id: "decision-a",
                note: "The reviewer found a release blocker.",
                planGeneration: 0,
                planHash: "p".repeat(64),
                status: "rejected" as const,
              },
            ],
            acceptances: [
              {
                acceptedAt: 3,
                acceptedPlan: {
                  contractRevision: 1,
                  criteria: [
                    {
                      id: "criterion-1",
                      required: true,
                      sourcesVisibility: "restricted" as const,
                      text: "Original acceptance criterion",
                      workRefs: [],
                    },
                  ],
                  objective: "Original accepted objective",
                  outcomeId: detail.id,
                  planGeneration: 0,
                },
                acceptedRevision: 3,
                closureHash: "c".repeat(64),
                id: "acceptance-a",
                planGeneration: 0,
                planHash: "p".repeat(64),
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = {
      gateway: createGateway({ request } as unknown as GatewayBrowserClient),
    } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();

    await vi.waitFor(() => {
      const decision = page.querySelector<HTMLElement>('[data-outcome-decision="decision-a"]');
      expect(decision?.textContent).toContain("The reviewer found a release blocker.");
      expect(decision?.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
      expect(decision?.textContent).toContain("Original Outcome objective");
      expect(decision?.textContent).toContain("Original release criterion");
      expect(decision?.querySelector('[data-outcome-history-card="card-1"]')).not.toBeNull();
      const decisionSummary = decision?.querySelector<HTMLElement>("summary");
      decisionSummary?.focus();
      expect(document.activeElement).toBe(decisionSummary);

      const acceptance = page.querySelector<HTMLElement>(
        '[data-outcome-acceptance-history="acceptance-a"]',
      );
      expect(acceptance?.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
      expect(acceptance?.textContent).toContain("Original accepted objective");
      expect(acceptance?.textContent).toContain("Original acceptance criterion");
      expect(acceptance?.querySelector("[data-outcome-history-card]")).toBeNull();
      expect(acceptance?.textContent).toContain(
        "Some linked cards are no longer available to you.",
      );
    });
  });

  it("states when a current acceptance was last successfully checked", async () => {
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        const detail = outcomeDetail("outcome-a", "Outcome A");
        return Promise.resolve({
          outcome: {
            ...detail,
            acceptance: { acceptanceValidity: "current" as const, lastSuccessfulAt: 42 },
            acceptanceValidity: "current" as const,
          },
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = {
      gateway: createGateway({ request } as unknown as GatewayBrowserClient),
    } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();

    await vi.waitFor(() => {
      const checkedAt = page.querySelector<HTMLTimeElement>("[data-outcome-last-successful-check]");
      expect(checkedAt?.dateTime).toBe(new Date(42).toISOString());
      expect(checkedAt?.textContent).toContain("Last checked at");
    });
  });

  it("renders a Workboard-disabled source issue as an explicit unavailable state", async () => {
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.resolve({
          outcome: {
            ...outcomeDetail("outcome-a", "Outcome A"),
            observedAt: 1,
            recheckAfter: 1,
            readiness: "unavailable" as const,
            sourceIssues: [{ criterionId: "criterion-1", reason: "workboard-disabled" }],
          },
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway: createGateway(client) } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();

    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-detail-id="outcome-a"]')).not.toBeNull();
      expect(page.textContent).toContain("Workboard disabled");
    });
    expect(page.querySelector('[data-outcome-readiness="unavailable"]')).not.toBeNull();
    expect(page.querySelector('[data-outcome-acceptance="none"]')).not.toBeNull();
  });

  it("links an authorized Workboard card only after the Gateway confirms it", async () => {
    let resolveLink: ((result: { outcome: OutcomeDetail }) => void) | undefined;
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.resolve({
          outcome: { ...outcomeDetail("outcome-a", "Outcome A"), nextActions: ["link-work"] },
        });
      }
      if (method === "workboard.cards.list") {
        return Promise.resolve({
          cards: [
            {
              createdAt: 2,
              id: "card-2",
              labels: [],
              position: 0,
              priority: "normal",
              status: "todo",
              title: "Prepare the launch",
              updatedAt: 2,
            },
          ],
          statuses: ["todo"],
        });
      }
      if (method === "outcomes.linkWorkboard") {
        return new Promise<{ outcome: OutcomeDetail }>((resolve) => {
          resolveLink = resolve;
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.linkWorkboard", "workboard.cards.list"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>("[data-outcome-select=outcome-a]"),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>("[data-outcome-select=outcome-a]")?.click();
    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>("[data-outcome-action=link-work]"),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>("[data-outcome-action=link-work]")?.click();

    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-link-form] select[name="card"]')).not.toBeNull();
    });
    const form = page.querySelector<HTMLFormElement>("[data-outcome-link-form]");
    const card = form?.querySelector<HTMLSelectElement>('select[name="card"]');
    if (!form || !card) {
      throw new Error("Outcome link form fields are missing");
    }
    card.value = "card-2";
    card.dispatchEvent(new Event("change", { bubbles: true }));
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.linkWorkboard", {
        cardId: "card-2",
        criterionId: "criterion-1",
        expectedRevision: 1,
        id: "outcome-a",
      });
    });
    resolveLink?.({
      outcome: {
        ...outcomeDetail("outcome-a", "Outcome A"),
        revision: 2,
        work: [
          {
            currentBoardId: "board-1",
            observedAt: 2,
            ref: {
              boardIdAtLink: "board-1",
              cardCreatedAt: 2,
              cardId: "card-2",
              owner: "workboard",
            },
            status: "todo",
            upstreamStale: false,
          },
        ],
      },
    });
    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-link-form]")).toBeNull();
    });
  });

  it("unlinks a card only after the Gateway confirms it", async () => {
    let resolveUnlink: ((result: { outcome: OutcomeDetail }) => void) | undefined;
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.resolve({
          outcome: { ...outcomeDetail("outcome-a", "Outcome A"), nextActions: ["unlink-work"] },
        });
      }
      if (method === "outcomes.unlinkWorkboard") {
        return new Promise<{ outcome: OutcomeDetail }>((resolve) => {
          resolveUnlink = resolve;
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.unlinkWorkboard"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>("[data-outcome-select=outcome-a]"),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>("[data-outcome-select=outcome-a]")?.click();
    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>("[data-outcome-unlink-card=card-1]"),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>("[data-outcome-unlink-card=card-1]")?.click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.unlinkWorkboard", {
        cardId: "card-1",
        criterionId: "criterion-1",
        expectedRevision: 1,
        id: "outcome-a",
      });
    });
    expect(page.textContent).toContain("Card card-1");

    const unlinked = outcomeDetail("outcome-a", "Outcome A");
    unlinked.criteria = [{ ...unlinked.criteria[0]!, workRefs: [] }];
    unlinked.work = [];
    unlinked.revision = 2;
    resolveUnlink?.({ outcome: unlinked });
    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-unlink-card=card-1]")).toBeNull();
    });
  });

  it("requires confirmation before cancelling a selected Outcome", async () => {
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.resolve({
          outcome: { ...outcomeDetail("outcome-a", "Outcome A"), nextActions: ["cancel"] },
        });
      }
      if (method === "outcomes.cancel") {
        return Promise.resolve({
          outcome: {
            ...outcomeDetail("outcome-a", "Outcome A"),
            nextActions: [],
            phase: "cancelled" as const,
            revision: 2,
          },
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.cancel"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="cancel"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="cancel"]')?.click();

    expect(request).not.toHaveBeenCalledWith("outcomes.cancel", expect.anything());
    await vi.waitFor(() => {
      expect(page.querySelector('openclaw-modal-dialog[label="Cancel outcome"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>("[data-outcome-confirm-cancel]")?.click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.cancel", {
        expectedRevision: 1,
        id: "outcome-a",
      });
      expect(page.textContent).toContain("Cancelled");
    });
  });

  it("does not let a stale refresh overwrite a newly selected Outcome view", async () => {
    let resolveRefresh: ((result: { outcome: OutcomeDetail }) => void) | undefined;
    let outcomeAReads = 0;
    const request = vi.fn((method: string, params: { id?: string }) => {
      if (method === "outcomes.list") {
        return Promise.resolve({
          outcomes: [
            outcomeSummary("outcome-a", "Outcome A"),
            outcomeSummary("outcome-b", "Outcome B"),
          ],
        });
      }
      if (method === "outcomes.get" && params.id === "outcome-a") {
        outcomeAReads += 1;
        return Promise.resolve({
          outcome:
            outcomeAReads === 1
              ? outcomeDetail("outcome-a", "Outcome A")
              : outcomeDetail("outcome-a", "Outcome A (new view)"),
        });
      }
      if (method === "outcomes.get" && params.id === "outcome-b") {
        return Promise.resolve({ outcome: outcomeDetail("outcome-b", "Outcome B") });
      }
      if (method === "outcomes.refresh") {
        return new Promise<{ outcome: OutcomeDetail }>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.refresh"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]'),
      ).not.toBeNull();
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-b"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.refresh", {
        expectedRevision: 1,
        id: "outcome-a",
      });
    });

    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-b"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-detail-id="outcome-b"]')).not.toBeNull();
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.disabled,
      ).toBe(false);
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(page.textContent).toContain("Outcome A (new view) objective");
    });

    resolveRefresh?.({ outcome: outcomeDetail("outcome-a", "Outcome A (stale refresh)") });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await page.updateComplete;

    expect(page.textContent).toContain("Outcome A (new view) objective");
    expect(page.textContent).not.toContain("Outcome A (stale refresh) objective");
  });

  it("does not submit a second mutation for an Outcome that is still in flight", async () => {
    let resolveRefresh: ((result: { outcome: OutcomeDetail }) => void) | undefined;
    const request = vi.fn((method: string, params: { id?: string }) => {
      if (method === "outcomes.list") {
        return Promise.resolve({
          outcomes: [
            outcomeSummary("outcome-a", "Outcome A"),
            outcomeSummary("outcome-b", "Outcome B"),
          ],
        });
      }
      if (method === "outcomes.get" && params.id === "outcome-a") {
        return Promise.resolve({
          outcome: {
            ...outcomeDetail("outcome-a", "Outcome A"),
            nextActions: ["refresh", "cancel"],
          },
        });
      }
      if (method === "outcomes.get" && params.id === "outcome-b") {
        return Promise.resolve({ outcome: outcomeDetail("outcome-b", "Outcome B") });
      }
      if (method === "outcomes.refresh") {
        return new Promise<{ outcome: OutcomeDetail }>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      if (method === "outcomes.cancel") {
        throw new Error("cancel must remain blocked while refresh is pending");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.refresh", "outcomes.cancel"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]'),
      ).not.toBeNull();
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-b"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]'),
      ).not.toBeNull();
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="cancel"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.refresh", {
        expectedRevision: 1,
        id: "outcome-a",
      });
    });

    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-b"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-detail-id="outcome-b"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.disabled,
      ).toBe(true);
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="cancel"]')?.disabled,
      ).toBe(true);
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.click();
    page.querySelector<HTMLButtonElement>('[data-outcome-action="cancel"]')?.click();
    expect(request.mock.calls.filter(([method]) => method === "outcomes.refresh")).toHaveLength(1);
    expect(request).not.toHaveBeenCalledWith("outcomes.cancel", expect.anything());

    resolveRefresh?.({
      outcome: { ...outcomeDetail("outcome-a", "Outcome A"), revision: 2 },
    });
  });

  it("keeps an unsettled mutation locked through reconnect until its result is revalidated", async () => {
    let refreshCalls = 0;
    let resolveInterruptedRefresh: ((result: { outcome: OutcomeDetail }) => void) | undefined;
    let detailReads = 0;
    const request = vi.fn((method: string, params: { id?: string }) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get" && params.id === "outcome-a") {
        detailReads += 1;
        return Promise.resolve({ outcome: outcomeDetail("outcome-a", "Outcome A") });
      }
      if (method === "outcomes.refresh") {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          return new Promise<{ outcome: OutcomeDetail }>((resolve) => {
            resolveInterruptedRefresh = resolve;
          });
        }
        return Promise.resolve({
          outcome: { ...outcomeDetail("outcome-a", "Outcome A"), revision: 2 },
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, mutableGateway, updateSnapshot } = createGatewayWithSnapshotListener(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.refresh"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.click();
    await vi.waitFor(() => {
      expect(refreshCalls).toBe(1);
    });

    mutableGateway.connectionRevision = 2;
    updateSnapshot({});

    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-detail-id="outcome-a"]')).not.toBeNull();
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.disabled,
      ).toBe(true);
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.click();
    expect(refreshCalls).toBe(1);

    resolveInterruptedRefresh?.({
      outcome: { ...outcomeDetail("outcome-a", "Outcome A (stale refresh)"), revision: 2 },
    });
    await vi.waitFor(() => {
      expect(detailReads).toBe(3);
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.disabled,
      ).toBe(false);
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.click();
    await vi.waitFor(() => {
      expect(refreshCalls).toBe(2);
    });
  });

  it("does not let an old selected Outcome detail overwrite a newer selection", async () => {
    let resolveFirstDetail: ((result: { outcome: OutcomeDetail }) => void) | undefined;
    const request = vi.fn((method: string, params: { id?: string }) => {
      if (method === "outcomes.list") {
        return Promise.resolve({
          outcomes: [
            outcomeSummary("outcome-a", "Outcome A"),
            outcomeSummary("outcome-b", "Outcome B"),
          ],
        });
      }
      if (method === "outcomes.get" && params.id === "outcome-a") {
        return new Promise<{ outcome: OutcomeDetail }>((resolve) => {
          resolveFirstDetail = resolve;
        });
      }
      if (method === "outcomes.get" && params.id === "outcome-b") {
        return Promise.resolve({ outcome: outcomeDetail("outcome-b", "Outcome B") });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway: createGateway(client) } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]'),
      ).not.toBeNull();
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-b"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.get", { id: "outcome-a" });
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-b"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-detail-id="outcome-b"]')).not.toBeNull();
    });

    resolveFirstDetail?.({ outcome: outcomeDetail("outcome-a", "Outcome A") });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await page.updateComplete;

    expect(page.querySelector('[data-outcome-detail-id="outcome-a"]')).toBeNull();
    expect(page.querySelector('[data-outcome-detail-id="outcome-b"]')).not.toBeNull();
  });

  it("does not show an old selected Outcome detail error after a newer selection", async () => {
    let rejectFirstDetail: ((error: Error) => void) | undefined;
    const request = vi.fn((method: string, params: { id?: string }) => {
      if (method === "outcomes.list") {
        return Promise.resolve({
          outcomes: [
            outcomeSummary("outcome-a", "Outcome A"),
            outcomeSummary("outcome-b", "Outcome B"),
          ],
        });
      }
      if (method === "outcomes.get" && params.id === "outcome-a") {
        return new Promise<{ outcome: OutcomeDetail }>((_, reject) => {
          rejectFirstDetail = reject;
        });
      }
      if (method === "outcomes.get" && params.id === "outcome-b") {
        return Promise.resolve({ outcome: outcomeDetail("outcome-b", "Outcome B") });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway: createGateway(client) } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]'),
      ).not.toBeNull();
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-b"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.get", { id: "outcome-a" });
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-b"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-detail-id="outcome-b"]')).not.toBeNull();
    });

    rejectFirstDetail?.(new Error("A detail should no longer be current"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await page.updateComplete;

    expect(page.querySelector('[data-outcome-detail-id="outcome-b"]')).not.toBeNull();
    expect(page.textContent).not.toContain("Couldn't load outcome details");
  });

  it("revalidates a same-identity selection after reconnecting without showing stale detail", async () => {
    let detailRequests = 0;
    let resolveRevalidatedDetail: ((result: { outcome: OutcomeDetail }) => void) | undefined;
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        detailRequests += 1;
        if (detailRequests === 1) {
          return Promise.resolve({ outcome: outcomeDetail("outcome-a", "Outcome A") });
        }
        return new Promise<{ outcome: OutcomeDetail }>((resolve) => {
          resolveRevalidatedDetail = resolve;
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, mutableGateway, updateSnapshot } = createGatewayWithSnapshotListener(client);
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-detail-id="outcome-a"]')).not.toBeNull();
    });

    mutableGateway.connectionRevision = 2;
    updateSnapshot({});

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.get", { id: "outcome-a" });
      expect(detailRequests).toBe(2);
    });
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-detail-id="outcome-a"]')).toBeNull();
      expect(
        page
          .querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')
          ?.getAttribute("aria-current"),
      ).toBe("true");
      expect(page.textContent).toContain("Checking outcome details");
    });

    resolveRevalidatedDetail?.({ outcome: outcomeDetail("outcome-a", "Outcome A (revalidated)") });
    await vi.waitFor(() => {
      expect(page.textContent).toContain("Outcome A (revalidated) objective");
    });
  });
});
