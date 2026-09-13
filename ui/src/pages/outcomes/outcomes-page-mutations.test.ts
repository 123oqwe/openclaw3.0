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
  outcomeSummary,
  type OutcomesPageTestElement,
} from "./outcomes-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OutcomesPage mutations", () => {
  it("requires refresh after a revision conflict before creating a new verification request", async () => {
    const verificationParams: Array<Record<string, unknown>> = [];
    const staleDetail = {
      ...outcomeDetail("outcome-a", "Outcome A"),
      criteria: [
        {
          ...outcomeDetail("outcome-a", "Outcome A").criteria[0]!,
          evidenceSetHash: "e".repeat(64),
        },
      ],
      nextActions: ["review-evidence", "refresh"] as const,
      phase: "active" as const,
      planGeneration: 1,
      planHash: "a".repeat(64),
      revision: 4,
    };
    const freshDetail = {
      ...staleDetail,
      criteria: [{ ...staleDetail.criteria[0]!, evidenceSetHash: "f".repeat(64) }],
      planHash: "b".repeat(64),
      revision: 5,
    };
    const request = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.resolve({ outcome: staleDetail });
      }
      if (method === "outcomes.verifyCriterion") {
        verificationParams.push(params);
        if (verificationParams.length === 1) {
          return Promise.reject(
            Object.assign(new Error("changed"), { code: "OUTCOME_REVISION_CONFLICT" }),
          );
        }
        return Promise.resolve({ outcome: { ...freshDetail, revision: 6 } });
      }
      if (method === "outcomes.refresh") {
        return Promise.resolve({ outcome: freshDetail });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.refresh", "outcomes.verifyCriterion"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-select="outcome-a"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-action="review-evidence"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="review-evidence"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-verification-form]")).not.toBeNull();
    });
    const form = page.querySelector<HTMLFormElement>("[data-outcome-verification-form]");
    form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(verificationParams).toHaveLength(1));
    await vi.waitFor(() => expect(page.textContent).toContain("Refresh the Outcome"));
    form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(verificationParams).toHaveLength(1);
    page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.refresh", {
        id: "outcome-a",
        expectedRevision: 4,
      });
    });
    form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(verificationParams).toHaveLength(2));
    expect(verificationParams[1]).toMatchObject({
      decisionId: expect.any(String),
      evidenceSetHash: "f".repeat(64),
      expectedRevision: 5,
      planHash: "b".repeat(64),
    });
    expect(verificationParams[1]?.decisionId).not.toBe(verificationParams[0]?.decisionId);
  });

  it("replays the same acceptance payload only after an explicit user retry", async () => {
    let rejectAcceptance: ((reason?: unknown) => void) | undefined;
    const acceptanceParams: Array<Record<string, unknown>> = [];
    const detail = {
      ...outcomeDetail("outcome-a", "Outcome A"),
      closureHash: "c".repeat(64),
      nextActions: ["accept"] as const,
      phase: "active" as const,
      planGeneration: 1,
      planHash: "a".repeat(64),
      revision: 4,
    };
    const request = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.resolve({ outcome: detail });
      }
      if (method === "outcomes.accept") {
        acceptanceParams.push(params);
        if (acceptanceParams.length === 1) {
          return new Promise((_resolve, reject) => {
            rejectAcceptance = reject;
          });
        }
        return Promise.resolve({ outcome: { ...detail, revision: 5 } });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.accept"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-select="outcome-a"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="accept"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="accept"]')?.click();
    await vi.waitFor(() => expect(acceptanceParams).toHaveLength(1));
    rejectAcceptance?.(new Error("response lost"));
    await vi.waitFor(() => expect(page.textContent).toContain("Request failed"));
    page.querySelector<HTMLButtonElement>('[data-outcome-action="accept"]')?.click();
    await vi.waitFor(() => expect(acceptanceParams).toHaveLength(2));
    expect(acceptanceParams[1]).toEqual(acceptanceParams[0]);
  });

  it("replays the same verification payload only after an explicit user retry", async () => {
    let rejectVerification: ((reason?: unknown) => void) | undefined;
    const verificationParams: Array<Record<string, unknown>> = [];
    const detail = {
      ...outcomeDetail("outcome-a", "Outcome A"),
      criteria: [
        {
          ...outcomeDetail("outcome-a", "Outcome A").criteria[0]!,
          evidenceSetHash: "e".repeat(64),
        },
      ],
      nextActions: ["review-evidence"] satisfies OutcomeDetail["nextActions"],
      phase: "active" as const,
      planGeneration: 1,
      planHash: "a".repeat(64),
      revision: 4,
    };
    const request = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.resolve({ outcome: detail });
      }
      if (method === "outcomes.verifyCriterion") {
        verificationParams.push(params);
        if (verificationParams.length === 1) {
          return new Promise((_resolve, reject) => {
            rejectVerification = reject;
          });
        }
        return Promise.resolve({ outcome: { ...detail, revision: 5 } });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.verifyCriterion"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-select="outcome-a"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-action="review-evidence"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="review-evidence"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-verification-form]")).not.toBeNull();
    });
    const form = page.querySelector<HTMLFormElement>("[data-outcome-verification-form]");
    form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(verificationParams).toHaveLength(1));
    rejectVerification?.(new Error("response lost"));
    await vi.waitFor(() => expect(page.textContent).toContain("Request failed"));
    expect(
      page.querySelector<HTMLSelectElement>(
        '[data-outcome-verification-form] select[name="status"]',
      )?.disabled,
    ).toBe(true);
    form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(verificationParams).toHaveLength(2));
    expect(verificationParams[1]).toEqual(verificationParams[0]);
  });

  it("keeps an unknown verification request replayable after refresh reports an unavailable owner", async () => {
    let rejectVerification: ((reason?: unknown) => void) | undefined;
    const verificationParams: Array<Record<string, unknown>> = [];
    const detail = {
      ...outcomeDetail("outcome-a", "Outcome A"),
      attention: [{ code: "owner-unavailable", criterionId: "criterion-1" }] as const,
      criteria: [
        {
          ...outcomeDetail("outcome-a", "Outcome A").criteria[0]!,
          evidenceSetHash: "e".repeat(64),
        },
      ],
      nextActions: ["refresh"] as const,
      phase: "active" as const,
      planGeneration: 1,
      planHash: "a".repeat(64),
      revision: 4,
    };
    let getCount = 0;
    const request = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        getCount += 1;
        return Promise.resolve({
          outcome:
            getCount === 1
              ? { ...detail, attention: [], nextActions: ["review-evidence"] }
              : detail,
        });
      }
      if (method === "outcomes.verifyCriterion") {
        verificationParams.push(params);
        if (verificationParams.length === 1) {
          return new Promise((_resolve, reject) => {
            rejectVerification = reject;
          });
        }
        return Promise.resolve({ outcome: { ...detail, revision: 5 } });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.verifyCriterion"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-select="outcome-a"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-action="review-evidence"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="review-evidence"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-verification-form]")).not.toBeNull();
    });
    const form = page.querySelector<HTMLFormElement>("[data-outcome-verification-form]");
    form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(verificationParams).toHaveLength(1));
    rejectVerification?.(new Error("response lost"));
    await vi.waitFor(() => {
      expect(page.textContent).toContain("Request failed");
      expect(getCount).toBeGreaterThanOrEqual(2);
    });
    expect(page.querySelector('[data-outcome-action="refresh"]')).not.toBeNull();
    expect(page.querySelector('[data-outcome-action="review-evidence"]')).not.toBeNull();
    form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(verificationParams).toHaveLength(2));
    expect(verificationParams[1]).toEqual(verificationParams[0]);
  });

  it("does not let a late verification response overwrite a newly selected outcome", async () => {
    let resolveVerification:
      | ((value: { outcome: ReturnType<typeof outcomeDetail> }) => void)
      | undefined;
    const detailFor = (id: string, title: string) => ({
      ...outcomeDetail(id, title),
      criteria: [
        {
          ...outcomeDetail(id, title).criteria[0]!,
          evidenceSetHash: "e".repeat(64),
        },
      ],
      nextActions: ["review-evidence"] satisfies OutcomeDetail["nextActions"],
      phase: "active" as const,
      planGeneration: 1,
      planHash: "a".repeat(64),
      revision: 4,
    });
    const detailA = detailFor("outcome-a", "Outcome A");
    const detailB = detailFor("outcome-b", "Outcome B");
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
        return Promise.resolve({ outcome: detailA });
      }
      if (method === "outcomes.get" && params.id === "outcome-b") {
        return Promise.resolve({ outcome: detailB });
      }
      if (method === "outcomes.verifyCriterion") {
        return new Promise((resolve) => {
          resolveVerification = resolve as (value: {
            outcome: ReturnType<typeof outcomeDetail>;
          }) => void;
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.verifyCriterion"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-select="outcome-a"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-action="review-evidence"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="review-evidence"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-verification-form]")).not.toBeNull();
    });
    page
      .querySelector<HTMLFormElement>("[data-outcome-verification-form]")
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(resolveVerification).toBeDefined());
    page.querySelector<HTMLButtonElement>(".outcome-detail__back")?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-select="outcome-b"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-b"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-detail-id="outcome-b"]')).not.toBeNull();
    });
    resolveVerification?.({ outcome: { ...detailA, revision: 5 } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(page.querySelector('[data-outcome-detail-id="outcome-b"]')).not.toBeNull();
    expect(page.querySelector('[data-outcome-detail-id="outcome-a"]')).toBeNull();
  });

  it("clears a pending verification dialog and its private rejection note when selection changes", async () => {
    const detailFor = (id: string, title: string) => ({
      ...outcomeDetail(id, title),
      criteria: [
        {
          ...outcomeDetail(id, title).criteria[0]!,
          evidenceSetHash: "e".repeat(64),
        },
      ],
      nextActions: ["review-evidence"] as const,
      phase: "active" as const,
      planGeneration: 1,
      planHash: "a".repeat(64),
    });
    const request = vi.fn((method: string, params?: { id?: string }) => {
      if (method === "outcomes.list") {
        return Promise.resolve({
          outcomes: [
            outcomeSummary("outcome-a", "Outcome A"),
            outcomeSummary("outcome-b", "Outcome B"),
          ],
        });
      }
      if (method === "outcomes.get" && params?.id === "outcome-a") {
        return Promise.resolve({ outcome: detailFor("outcome-a", "Outcome A") });
      }
      if (method === "outcomes.get" && params?.id === "outcome-b") {
        return Promise.resolve({ outcome: detailFor("outcome-b", "Outcome B") });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.verifyCriterion"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-select="outcome-a"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-action="review-evidence"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="review-evidence"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-verification-form]")).not.toBeNull();
    });
    const status = page.querySelector<HTMLSelectElement>(
      '[data-outcome-verification-form] select[name="status"]',
    );
    if (!status) {
      throw new Error("Verification status selector missing");
    }
    status.value = "rejected";
    status.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(
        page.querySelector('[data-outcome-verification-form] textarea[name="note"]'),
      ).not.toBeNull();
    });
    const note = page.querySelector<HTMLTextAreaElement>(
      '[data-outcome-verification-form] textarea[name="note"]',
    );
    note!.value = "private A rejection";
    note!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    page.querySelector<HTMLButtonElement>(".outcome-detail__back")?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-select="outcome-b"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-b"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-detail-id="outcome-b"]')).not.toBeNull();
    });
    expect(page.querySelector("[data-outcome-verification-form]")).toBeNull();
    expect(page.textContent).not.toContain("private A rejection");
  });

  it("submits a human verification only through the advertised Gateway method", async () => {
    const detail = {
      ...outcomeDetail("outcome-a", "Outcome A"),
      criteria: [
        {
          ...outcomeDetail("outcome-a", "Outcome A").criteria[0]!,
          evidenceSetHash: "e".repeat(64),
        },
      ],
      nextActions: ["review-evidence"] as const,
      phase: "active" as const,
      planGeneration: 1,
      planHash: "a".repeat(64),
      revision: 4,
    };
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.resolve({ outcome: detail });
      }
      if (method === "outcomes.verifyCriterion") {
        return Promise.resolve({ outcome: { ...detail, revision: 5 } });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.verifyCriterion"],
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
        page.querySelector<HTMLButtonElement>('[data-outcome-action="review-evidence"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="review-evidence"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-verification-form]")).not.toBeNull();
    });
    page
      .querySelector<HTMLFormElement>("[data-outcome-verification-form]")
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.verifyCriterion", {
        criterionId: "criterion-1",
        decisionId: expect.any(String),
        evidenceSetHash: "e".repeat(64),
        expectedRevision: 4,
        id: "outcome-a",
        planHash: "a".repeat(64),
        status: "verified",
      });
    });
  });

  it("refreshes a selected Outcome only after the Gateway confirms the mutation", async () => {
    let resolveRefresh: ((result: { outcome: OutcomeDetail }) => void) | undefined;
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.resolve({
          outcome: { ...outcomeDetail("outcome-a", "Outcome A"), readiness: "stale" as const },
        });
      }
      if (method === "outcomes.refresh") {
        return new Promise<{ outcome: OutcomeDetail }>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      throw new Error(`Unexpected method: ${method}`);
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
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();

    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-detail-id="outcome-a"]')).not.toBeNull();
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
    expect(page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.disabled).toBe(
      true,
    );
    expect(
      page
        .querySelector('[data-outcome-detail-id="outcome-a"] .outcome-detail__readiness')
        ?.getAttribute("data-outcome-readiness"),
    ).toBe("stale");

    resolveRefresh?.({
      outcome: { ...outcomeDetail("outcome-a", "Outcome A"), readiness: "blocked", revision: 2 },
    });
    await vi.waitFor(() => {
      expect(
        page
          .querySelector('[data-outcome-detail-id="outcome-a"] .outcome-detail__readiness')
          ?.getAttribute("data-outcome-readiness"),
      ).toBe("blocked");
    });
  });

  it("activates a selected Outcome only after the Gateway confirms the mutation", async () => {
    let resolveActivation: ((result: { outcome: OutcomeDetail }) => void) | undefined;
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.resolve({
          outcome: { ...outcomeDetail("outcome-a", "Outcome A"), nextActions: ["activate"] },
        });
      }
      if (method === "outcomes.activate") {
        return new Promise<{ outcome: OutcomeDetail }>((resolve) => {
          resolveActivation = resolve;
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.activate"],
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
        page.querySelector<HTMLButtonElement>('[data-outcome-action="activate"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="activate"]')?.click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.activate", {
        expectedRevision: 1,
        id: "outcome-a",
      });
    });
    expect(
      page.querySelector<HTMLButtonElement>('[data-outcome-action="activate"]')?.disabled,
    ).toBe(true);
    expect(page.textContent).not.toContain("Active");

    resolveActivation?.({
      outcome: {
        ...outcomeDetail("outcome-a", "Outcome A"),
        nextActions: ["refresh", "cancel"],
        phase: "active",
        planGeneration: 1,
        planHash: "plan-hash",
        revision: 2,
      },
    });
    await vi.waitFor(() => {
      expect(page.textContent).toContain("Active");
    });
  });

  it("creates a draft only after the Gateway confirms the form submission", async () => {
    let resolveCreate: ((result: { outcome: OutcomeDetail }) => void) | undefined;
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [] });
      }
      if (method === "outcomes.create") {
        return new Promise<{ outcome: OutcomeDetail }>((resolve) => {
          resolveCreate = resolve;
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.create"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="create"]'),
      ).not.toBeNull();
    });
    const create = page.querySelector<HTMLButtonElement>('[data-outcome-action="create"]');
    create?.focus();
    create?.click();

    await vi.waitFor(() => {
      expect(page.querySelector('openclaw-modal-dialog[label="Create outcome"]')).not.toBeNull();
    });
    const form = page.querySelector<HTMLFormElement>("[data-outcome-create-form]");
    expect(form).not.toBeNull();
    const title = form?.querySelector<HTMLInputElement>('input[name="title"]');
    const objective = form?.querySelector<HTMLTextAreaElement>('textarea[name="objective"]');
    const criterion = form?.querySelector<HTMLInputElement>('input[name="criterion"]');
    if (!title || !objective || !criterion || !form) {
      throw new Error("Outcome create form fields are missing");
    }
    expect(title.autofocus).toBe(true);
    title.value = "Launch the release";
    title.dispatchEvent(new InputEvent("input", { bubbles: true }));
    objective.value = "Confirm the release is ready";
    objective.dispatchEvent(new InputEvent("input", { bubbles: true }));
    criterion.value = "Release evidence is available";
    criterion.dispatchEvent(new InputEvent("input", { bubbles: true }));
    page
      .querySelector<HTMLFormElement>("[data-outcome-create-form]")
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.create", {
        criteria: [
          {
            id: expect.any(String),
            required: true,
            text: "Release evidence is available",
          },
        ],
        id: expect.any(String),
        objective: "Confirm the release is ready",
        title: "Launch the release",
      });
    });
    expect(page.textContent).toContain("No outcomes");

    resolveCreate?.({ outcome: outcomeDetail("outcome-new", "Launch the release") });
    await vi.waitFor(() => {
      expect(page.textContent).toContain("Launch the release");
      expect(page.querySelector('openclaw-modal-dialog[label="Create outcome"]')).toBeNull();
      expect(document.activeElement).toBe(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="create"]'),
      );
    });
  });

  it("keeps one create request identity when the user explicitly retries an unknown result", async () => {
    let rejectCreate: ((reason?: unknown) => void) | undefined;
    const createParams: Array<Record<string, unknown>> = [];
    const request = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [] });
      }
      if (method === "outcomes.create") {
        createParams.push(params);
        if (createParams.length === 1) {
          return new Promise<{ outcome: OutcomeDetail }>((_resolve, reject) => {
            rejectCreate = reject;
          });
        }
        return Promise.resolve({ outcome: outcomeDetail("outcome-new", "Launch the release") });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.create"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="create"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="create"]')?.click();

    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-create-form]")).not.toBeNull();
    });
    const form = page.querySelector<HTMLFormElement>("[data-outcome-create-form]");
    const title = form?.querySelector<HTMLInputElement>('input[name="title"]');
    const objective = form?.querySelector<HTMLTextAreaElement>('textarea[name="objective"]');
    const criterion = form?.querySelector<HTMLInputElement>('input[name="criterion"]');
    if (!form || !title || !objective || !criterion) {
      throw new Error("Outcome create form fields are missing");
    }
    title.value = "Launch the release";
    title.dispatchEvent(new InputEvent("input", { bubbles: true }));
    objective.value = "Confirm the release is ready";
    objective.dispatchEvent(new InputEvent("input", { bubbles: true }));
    criterion.value = "Release evidence is available";
    criterion.dispatchEvent(new InputEvent("input", { bubbles: true }));
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(createParams).toHaveLength(1);
    });
    rejectCreate?.(new Error("response lost"));
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-create-form] [role="alert"]')).not.toBeNull();
    });
    page
      .querySelector<HTMLFormElement>("[data-outcome-create-form]")
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(createParams).toHaveLength(2);
    });
    expect(createParams[1]).toEqual(createParams[0]);
  });

  it("requires ending an unknown create attempt before a changed form gets a new identity", async () => {
    let rejectCreate: ((reason?: unknown) => void) | undefined;
    const createParams: Array<Record<string, unknown>> = [];
    const request = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [] });
      }
      if (method === "outcomes.create") {
        createParams.push(params);
        if (createParams.length === 1) {
          return new Promise<{ outcome: OutcomeDetail }>((_resolve, reject) => {
            rejectCreate = reject;
          });
        }
        if (createParams.length === 2) {
          return Promise.reject(new Error("still unknown"));
        }
        return Promise.resolve({ outcome: outcomeDetail("outcome-new", "Changed title") });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.create"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="create"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="create"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-create-form]")).not.toBeNull();
    });
    const form = page.querySelector<HTMLFormElement>("[data-outcome-create-form]");
    const title = form?.querySelector<HTMLInputElement>('input[name="title"]');
    const objective = form?.querySelector<HTMLTextAreaElement>('textarea[name="objective"]');
    const criterion = form?.querySelector<HTMLInputElement>('input[name="criterion"]');
    if (!form || !title || !objective || !criterion) {
      throw new Error("Outcome create form fields are missing");
    }
    title.value = "Original title";
    title.dispatchEvent(new InputEvent("input", { bubbles: true }));
    objective.value = "Original objective";
    objective.dispatchEvent(new InputEvent("input", { bubbles: true }));
    criterion.value = "Original criterion";
    criterion.dispatchEvent(new InputEvent("input", { bubbles: true }));
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(createParams).toHaveLength(1));
    rejectCreate?.(new Error("response lost"));
    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-pending-create]")).not.toBeNull();
    });
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-create-form] [role="alert"]')).not.toBeNull();
    });

    const pendingForm = page.querySelector<HTMLFormElement>("[data-outcome-create-form]");
    const pendingTitle = pendingForm?.querySelector<HTMLInputElement>('input[name="title"]');
    if (!pendingForm || !pendingTitle) {
      throw new Error("Pending Outcome create form fields are missing");
    }
    expect(pendingTitle.disabled).toBe(true);
    pendingTitle.value = "Changed title";
    pendingTitle.dispatchEvent(new InputEvent("input", { bubbles: true }));
    pendingForm.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(createParams).toHaveLength(2));
    expect(createParams[1]).toEqual(createParams[0]);

    const abandonPendingCreate = page.querySelector<HTMLButtonElement>(
      "[data-outcome-abandon-pending-create]",
    );
    if (!abandonPendingCreate) {
      throw new Error("Pending Outcome create abandonment control is missing");
    }
    await vi.waitFor(() => expect(abandonPendingCreate.disabled).toBe(false));

    abandonPendingCreate.click();
    const editableForm = page.querySelector<HTMLFormElement>("[data-outcome-create-form]");
    const editableTitle = editableForm?.querySelector<HTMLInputElement>('input[name="title"]');
    if (!editableForm || !editableTitle) {
      throw new Error("Editable Outcome create form fields are missing");
    }
    await vi.waitFor(() => expect(editableTitle.disabled).toBe(false));
    editableTitle.value = "Changed title";
    editableTitle.dispatchEvent(new InputEvent("input", { bubbles: true }));
    editableForm.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(createParams).toHaveLength(3));
    expect(createParams[2]).toMatchObject({ title: "Changed title" });
    expect(createParams[2]).not.toEqual(createParams[0]);
  });

  it("submits five explicit Outcome criteria through the authenticated Gateway", async () => {
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [] });
      }
      if (method === "outcomes.create") {
        return Promise.resolve({ outcome: outcomeDetail("outcome-new", "Launch the release") });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.create"],
      ["operator.read", "operator.write"],
    );
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="create"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="create"]')?.click();

    await vi.waitFor(() => {
      expect(page.querySelector<HTMLButtonElement>("[data-outcome-add-criterion]")).not.toBeNull();
    });
    for (let index = 1; index < 5; index += 1) {
      page.querySelector<HTMLButtonElement>("[data-outcome-add-criterion]")?.click();
    }

    await vi.waitFor(() => {
      expect(page.querySelectorAll<HTMLInputElement>('input[name="criterion"]')).toHaveLength(5);
    });
    const form = page.querySelector<HTMLFormElement>("[data-outcome-create-form]");
    const title = form?.querySelector<HTMLInputElement>('input[name="title"]');
    const objective = form?.querySelector<HTMLTextAreaElement>('textarea[name="objective"]');
    const criteria = Array.from(
      form?.querySelectorAll<HTMLInputElement>('input[name="criterion"]') ?? [],
    );
    if (!form || !title || !objective || criteria.length !== 5) {
      throw new Error("Outcome create form fields are missing");
    }
    title.value = "Launch the release";
    title.dispatchEvent(new InputEvent("input", { bubbles: true }));
    objective.value = "Confirm the release is ready";
    objective.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const criterionTexts = [
      "Release evidence is available",
      "Operations has approved the launch",
      "The rollout guide is current",
      "Support has reviewed the release",
      "The change log is published",
    ];
    for (const [index, input] of criteria.entries()) {
      input.value = criterionTexts[index]!;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.create", {
        criteria: criterionTexts.map((text) => ({ id: expect.any(String), required: true, text })),
        id: expect.any(String),
        objective: "Confirm the release is ready",
        title: "Launch the release",
      });
    });
  });

  it("updates an editable contract only after the Gateway confirms it", async () => {
    let resolveUpdate: ((result: { outcome: OutcomeDetail }) => void) | undefined;
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.resolve({
          outcome: { ...outcomeDetail("outcome-a", "Outcome A"), nextActions: ["edit-contract"] },
        });
      }
      if (method === "outcomes.update") {
        return new Promise<{ outcome: OutcomeDetail }>((resolve) => {
          resolveUpdate = resolve;
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = gatewayHelloForMethods(
      ["outcomes.list", "outcomes.get", "outcomes.update"],
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
        page.querySelector<HTMLButtonElement>("[data-outcome-action=edit-contract]"),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>("[data-outcome-action=edit-contract]")?.click();

    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-edit-form]")).not.toBeNull();
    });
    const form = page.querySelector<HTMLFormElement>("[data-outcome-edit-form]");
    const title = form?.querySelector<HTMLInputElement>('input[name="title"]');
    if (!form || !title) {
      throw new Error("Outcome edit form fields are missing");
    }
    title.value = "Outcome A revised";
    title.dispatchEvent(new InputEvent("input", { bubbles: true }));
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.update", {
        expectedRevision: 1,
        id: "outcome-a",
        patch: {
          criteria: [
            {
              id: "criterion-1",
              required: true,
              text: "Verify the release evidence",
            },
          ],
          objective: "Outcome A objective",
          title: "Outcome A revised",
        },
      });
    });
    expect(page.textContent).toContain("Outcome A objective");

    resolveUpdate?.({
      outcome: { ...outcomeDetail("outcome-a", "Outcome A revised"), revision: 2 },
    });
    await vi.waitFor(() => {
      expect(page.textContent).toContain("Outcome A revised objective");
      expect(page.querySelector("[data-outcome-edit-form]")).toBeNull();
    });
  });
});
