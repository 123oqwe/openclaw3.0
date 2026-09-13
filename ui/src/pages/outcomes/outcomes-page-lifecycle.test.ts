/* @vitest-environment jsdom */

import type { OutcomeDetail, OutcomeListResult } from "@openclaw/outcomes-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import "./outcomes-page.ts";
import {
  createGateway,
  createGatewayWithSnapshotListener,
  type MutableGateway,
  outcomeDetail,
  outcomeSummary,
  type OutcomesPageTestElement,
} from "./outcomes-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OutcomesPage lifecycle", () => {
  it("does not treat a connected transport without an authenticated self user as Outcome access", async () => {
    const request = vi.fn(async () => ({ outcomes: [] }));
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).selfUser = null;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await page.updateComplete;
    expect(request).not.toHaveBeenCalled();
  });

  it("requires an advertised operator.read grant before loading Outcomes", async () => {
    const request = vi.fn(async () => ({ outcomes: [] }));
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    const gateway = createGateway(client);
    (gateway.snapshot as ApplicationGatewaySnapshot).hello = null;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await page.updateComplete;
    expect(request).not.toHaveBeenCalled();
  });

  it("loads the authenticated read-only Outcome list when the gateway is connected", async () => {
    const request = vi.fn(async () => ({ outcomes: [] }));
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway: createGateway(client) } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.list", {});
    });
  });

  it("revalidates the first list page after a persisted page restore", async () => {
    let listRequests = 0;
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    const request = vi.fn((method: string) => {
      if (method !== "outcomes.list") {
        throw new Error(`Unexpected method: ${method}`);
      }
      listRequests += 1;
      return Promise.resolve({
        outcomes: [
          outcomeSummary(
            "outcome-a",
            listRequests === 1 ? "Outcome before restore" : "Outcome after restore",
          ),
        ],
      });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway: createGateway(client) } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(page.textContent).toContain("Outcome before restore");
    });
    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listRequests).toBe(1);
    visibilityState = "visible";
    const restore = new Event("pageshow");
    Object.defineProperty(restore, "persisted", { value: true });
    globalThis.dispatchEvent(restore);

    await vi.waitFor(() => {
      expect(listRequests).toBe(2);
      expect(page.textContent).toContain("Outcome after restore");
    });
  });

  it("hides selected Outcome details and revalidates them after the page becomes visible", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    let detailRequests = 0;
    let resolveRevalidatedDetail: ((result: { outcome: OutcomeDetail }) => void) | undefined;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
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
    });

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(detailRequests).toBe(2);
      expect(page.querySelector('[data-outcome-detail-id="outcome-a"]')).toBeNull();
      expect(page.textContent).toContain("Checking outcome details");
    });

    resolveRevalidatedDetail?.({ outcome: outcomeDetail("outcome-a", "Outcome A (revalidated)") });
    await vi.waitFor(() => {
      expect(page.textContent).toContain("Outcome A (revalidated) objective");
    });
  });

  it("does not present an authenticated list as empty while its first read is loading", async () => {
    let resolveList: ((result: { outcomes: [] }) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<{ outcomes: [] }>((resolve) => {
          resolveList = resolve;
        }),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway: createGateway(client) } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.list", {});
    });
    expect(page.textContent).toContain("Loading");
    expect(page.textContent).not.toContain("No outcomes");

    resolveList?.({ outcomes: [] });
    await vi.waitFor(() => {
      expect(page.textContent).toContain("No outcomes");
    });
  });

  it("renders the authenticated Outcome summaries after the first read succeeds", async () => {
    const request = vi.fn(async () => ({
      outcomes: [
        {
          id: "outcome-1",
          title: "Launch beta",
          phase: "draft",
          revision: 1,
          updatedAt: 1,
          readiness: "incomplete",
          acceptanceValidity: "none",
        },
      ],
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway: createGateway(client) } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      const outcome = page.querySelector('[data-outcome-id="outcome-1"]');
      expect(outcome).not.toBeNull();
      expect(outcome?.textContent).toContain("Launch beta");
    });
  });

  it("loads the next opaque Outcome page without duplicating or reordering summaries", async () => {
    const request = vi.fn((_method: string, params: Record<string, unknown>) => {
      if (params.cursor === undefined) {
        return Promise.resolve({
          nextCursor: "opaque-page-two",
          outcomes: [
            { ...outcomeSummary("outcome-a", "Outcome A"), updatedAt: 10 },
            { ...outcomeSummary("outcome-c", "Outcome C"), updatedAt: 5 },
          ],
        });
      }
      return Promise.resolve({
        outcomes: [
          { ...outcomeSummary("outcome-a", "Outcome A refreshed"), updatedAt: 11 },
          { ...outcomeSummary("outcome-b", "Outcome B"), updatedAt: 8 },
        ],
      });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway: createGateway(client) } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-outcome-action="load-more"]'),
      ).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="load-more"]')?.click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.list", { cursor: "opaque-page-two" });
    });
    await vi.waitFor(() => {
      expect(page.querySelector('[data-outcome-action="load-more"]')).toBeNull();
    });

    expect(
      Array.from(page.querySelectorAll<HTMLElement>("[data-outcome-id]")).map((item) =>
        item.getAttribute("data-outcome-id"),
      ),
    ).toEqual(["outcome-a", "outcome-b", "outcome-c"]);
    expect(page.textContent).toContain("Outcome A refreshed");
    expect(page.querySelectorAll('[data-outcome-id="outcome-a"]')).toHaveLength(1);
  });

  it("renders a failed authenticated read as an error instead of an empty Outcome list", async () => {
    const request = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway: createGateway(client) } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      const alert = page.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toContain("Couldn't load outcomes");
    });
    expect(page.textContent).not.toContain("No outcomes");
  });

  it("clears an in-flight authenticated list and shows a disconnected state when the Gateway stops", async () => {
    let resolveList: ((result: { outcomes: [] }) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<{ outcomes: [] }>((resolve) => {
          resolveList = resolve;
        }),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client);
    let receiveSnapshot: ((snapshot: ApplicationGatewaySnapshot) => void) | undefined;
    gateway.subscribe = (listener) => {
      receiveSnapshot = listener;
      return () => undefined;
    };
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.list", {});
    });
    receiveSnapshot?.({ ...gateway.snapshot, client: null, phase: "stopped", selfUser: null });
    await page.updateComplete;

    expect(page.textContent).toContain("Outcome connection unavailable");
    resolveList?.({ outcomes: [] });
    await page.updateComplete;
    expect(page.textContent).not.toContain("No outcomes");
  });

  it("drops an old list response and reloads after a same-client connection revision change", async () => {
    let resolveFirstList: ((result: OutcomeListResult) => void) | undefined;
    let calls = 0;
    const request = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<OutcomeListResult>((resolve) => {
          resolveFirstList = resolve;
        });
      }
      return Promise.resolve({ outcomes: [] });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, mutableGateway, updateSnapshot } = createGatewayWithSnapshotListener(client);
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1);
    });
    mutableGateway.connectionRevision = 2;
    updateSnapshot({});
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
    resolveFirstList?.({
      outcomes: [
        {
          id: "outcome-before-reconnect",
          title: "Must not leak",
          phase: "draft",
          revision: 1,
          updatedAt: 1,
          readiness: "incomplete",
          acceptanceValidity: "none",
        },
      ],
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await page.updateComplete;

    expect(page.querySelector('[data-outcome-id="outcome-before-reconnect"]')).toBeNull();
  });

  it("drops an old list response and reloads after the authenticated identity changes", async () => {
    let resolveFirstList: ((result: OutcomeListResult) => void) | undefined;
    let calls = 0;
    const request = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<OutcomeListResult>((resolve) => {
          resolveFirstList = resolve;
        });
      }
      return Promise.resolve({ outcomes: [] });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, updateSnapshot } = createGatewayWithSnapshotListener(client);
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1);
    });
    updateSnapshot({ selfUser: { id: "profile-b" } });
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
    resolveFirstList?.({
      outcomes: [
        {
          id: "outcome-from-profile-a",
          title: "Must not leak",
          phase: "draft",
          revision: 1,
          updatedAt: 1,
          readiness: "incomplete",
          acceptanceValidity: "none",
        },
      ],
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await page.updateComplete;

    expect(page.querySelector('[data-outcome-id="outcome-from-profile-a"]')).toBeNull();
  });

  it("clears the list and does not reload after operator.read is revoked", async () => {
    let resolveFirstList: ((result: OutcomeListResult) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<OutcomeListResult>((resolve) => {
          resolveFirstList = resolve;
        }),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, updateSnapshot } = createGatewayWithSnapshotListener(client);
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1);
    });
    resolveFirstList?.({
      outcomes: [
        {
          id: "outcome-visible-before-revocation",
          title: "Visible before revocation",
          phase: "draft",
          revision: 1,
          updatedAt: 1,
          readiness: "incomplete",
          acceptanceValidity: "none",
        },
      ],
    });
    await vi.waitFor(() => {
      expect(
        page.querySelector('[data-outcome-id="outcome-visible-before-revocation"]'),
      ).not.toBeNull();
    });
    updateSnapshot({ hello: gatewayHelloForMethods(["outcomes.list"], []) });
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(1);
    expect(page.querySelector('[data-outcome-id="outcome-visible-before-revocation"]')).toBeNull();
    expect(page.textContent).toContain("Outcome access unavailable");
  });

  it("does not reveal an in-flight list after operator.read is revoked", async () => {
    let resolveList: ((result: OutcomeListResult) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<OutcomeListResult>((resolve) => {
          resolveList = resolve;
        }),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, updateSnapshot } = createGatewayWithSnapshotListener(client);
    const page = document.createElement("openclaw-outcomes-page") as OutcomesPageTestElement;
    page.context = { gateway } as ApplicationContext;
    document.body.append(page);

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1);
    });
    updateSnapshot({ hello: gatewayHelloForMethods(["outcomes.list"], []) });
    resolveList?.({
      outcomes: [
        {
          id: "outcome-after-revocation",
          title: "Must not leak",
          phase: "draft",
          revision: 1,
          updatedAt: 1,
          readiness: "incomplete",
          acceptanceValidity: "none",
        },
      ],
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await page.updateComplete;

    expect(page.querySelector('[data-outcome-id="outcome-after-revocation"]')).toBeNull();
    expect(page.textContent).toContain("Outcome access unavailable");
  });

  it("loads the selected Outcome detail through the authenticated Gateway", async () => {
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        const detail = outcomeDetail("outcome-a", "Outcome A");
        return Promise.resolve({
          outcome: {
            ...detail,
            acceptance: { acceptanceValidity: "current", lastSuccessfulAt: 2 },
            acceptanceValidity: "current",
            evidence: [
              {
                criterionId: "criterion-1",
                id: "evidence-1",
                kind: "workboard-proof",
                label: "Hosted verification",
                observedAt: 2,
                planGeneration: 0,
                proofStatus: "passed",
                sourceCreatedAt: 2,
                sourceDigest: "a".repeat(64),
                sourceId: "proof-1",
                workRef: detail.criteria[0]!.workRefs[0]!,
              },
            ],
            work: [{ ...detail.work[0]!, status: "done" }],
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
      expect(request).toHaveBeenCalledWith("outcomes.get", { id: "outcome-a" });
      expect(page.querySelector('[data-outcome-detail-id="outcome-a"]')).not.toBeNull();
    });
    expect(page.textContent).toContain("Outcome A objective");
    expect(page.textContent).toContain("Verify the release evidence");
    expect(page.textContent).toContain("card-1");
    expect(page.textContent).toContain("Acceptance: Current");
    expect(page.textContent).toContain("Linked work");
    expect(page.textContent).toContain("Status: done");
    expect(page.textContent).toContain("Proof: Hosted verification");
    expect(page.textContent).toContain("Proof status: passed");
    expect(page.textContent).toContain("A linked card is blocked");
    expect(page.textContent).toContain("Refresh");
    expect(page.querySelector('[data-outcome-action="refresh"]')).toBeNull();
  });

  it("returns focus to the selected Outcome when leaving its detail", async () => {
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.resolve({ outcome: outcomeDetail("outcome-a", "Outcome A") });
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
    });
    page.querySelector<HTMLButtonElement>(".outcome-detail__back")?.click();

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]'),
      );
    });
  });

  it("lets a failed detail request return to its selected Outcome", async () => {
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.reject(new Error("Outcome source unavailable"));
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
      expect(page.textContent).toContain("Couldn't load outcome details");
    });
    page.querySelector<HTMLButtonElement>(".outcome-detail__back")?.click();

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]'),
      );
    });
  });

  it("marks an expired observation stale and withholds tracking until it is refreshed", async () => {
    const request = vi.fn((method: string) => {
      if (method === "outcomes.list") {
        return Promise.resolve({ outcomes: [outcomeSummary("outcome-a", "Outcome A")] });
      }
      if (method === "outcomes.get") {
        return Promise.resolve({
          outcome: {
            ...outcomeDetail("outcome-a", "Outcome A"),
            acceptance: { acceptanceValidity: "current", lastSuccessfulAt: 1 },
            acceptanceValidity: "current",
            nextActions: ["activate", "refresh"],
            observedAt: 1,
            recheckAfter: 1,
          },
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client) as unknown as MutableGateway;
    gateway.snapshot = {
      ...gateway.snapshot,
      hello: gatewayHelloForMethods(
        ["outcomes.activate", "outcomes.get", "outcomes.list", "outcomes.refresh"],
        ["operator.read", "operator.write"],
      ),
    };
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
      expect(page.textContent).toContain(
        "Outcome details need refreshing before tracking can start.",
      );
    });
    expect(page.querySelector('[data-outcome-readiness="stale"]')).not.toBeNull();
    expect(page.querySelector('[data-outcome-acceptance="needs-review"]')).not.toBeNull();
    expect(page.querySelector('[data-outcome-action="activate"]')).toBeNull();
    expect(page.querySelector('[data-outcome-action="refresh"]')).not.toBeNull();
  });
});
