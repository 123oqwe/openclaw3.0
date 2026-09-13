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
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(verificationParams).toHaveLength(1);
    page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.refresh", {
        id: "outcome-a",
        expectedRevision: 4,
      });
    });
    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-verification-form]")).not.toBeNull();
    });
    page
      .querySelector<HTMLFormElement>("[data-outcome-verification-form]")
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
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
    rejectVerification?.(new Error("response lost"));
    await vi.waitFor(() => {
      expect(page.textContent).toContain("Request failed");
      expect(getCount).toBeGreaterThanOrEqual(2);
    });
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-action="refresh"]')).not.toBeNull();
    });
    expect(page.querySelector('[data-outcome-action="review-evidence"]')).not.toBeNull();
    await vi.waitFor(() => {
      expect(page.querySelector("[data-outcome-verification-form]")).not.toBeNull();
    });
    page
      .querySelector<HTMLFormElement>("[data-outcome-verification-form]")
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
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
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
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
});
