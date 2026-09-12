/* @vitest-environment jsdom */

import type { OutcomeDetail, OutcomeListResult, OutcomeSummary } from "@openclaw/outcomes-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import "./outcomes-page.ts";

type OutcomesPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
};

type MutableGateway = {
  connectionRevision: number;
  snapshot: ApplicationGatewaySnapshot;
  subscribe: ApplicationContext["gateway"]["subscribe"];
};

function outcomeSummary(id: string, title: string): OutcomeSummary {
  return {
    acceptanceValidity: "none",
    id,
    phase: "draft",
    readiness: "incomplete",
    revision: 1,
    title,
    updatedAt: 1,
  };
}

function outcomeDetail(id: string, title: string): OutcomeDetail {
  const workRef = {
    boardIdAtLink: "board-1",
    cardCreatedAt: 1,
    cardId: "card-1",
    owner: "workboard" as const,
  };
  return {
    ...outcomeSummary(id, title),
    acceptance: { acceptanceValidity: "none" },
    attention: [{ code: "blocked", criterionId: "criterion-1" }],
    closureHash: null,
    contractRevision: 1,
    createdAt: 1,
    criteria: [
      {
        evidenceSetHash: null,
        id: "criterion-1",
        required: true,
        sourcesVisibility: "complete",
        text: "Verify the release evidence",
        workRefs: [workRef],
      },
    ],
    evidence: [],
    nextActions: ["refresh"],
    objective: `${title} objective`,
    observedAt: 1,
    planGeneration: 0,
    planHash: null,
    recheckAfter: null,
    sourceIssues: [],
    work: [
      {
        currentBoardId: "board-1",
        observedAt: 1,
        ref: workRef,
        status: "blocked",
        upstreamStale: false,
      },
    ],
  };
}

function createGateway(client: GatewayBrowserClient): ApplicationContext["gateway"] {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods(["outcomes.list", "outcomes.get"], ["operator.read"]),
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
    selfUser: { id: "profile-a" },
  };
  return {
    snapshot,
    connection: { gatewayUrl: "", token: "", password: "" },
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
}

function createGatewayWithSnapshotListener(client: GatewayBrowserClient) {
  const gateway = createGateway(client);
  const mutableGateway = gateway as unknown as MutableGateway;
  let receiveSnapshot: ((snapshot: ApplicationGatewaySnapshot) => void) | undefined;
  mutableGateway.connectionRevision = 1;
  mutableGateway.subscribe = (listener) => {
    receiveSnapshot = listener;
    return () => undefined;
  };
  const updateSnapshot = (patch: Partial<ApplicationGatewaySnapshot>) => {
    mutableGateway.snapshot = { ...mutableGateway.snapshot, ...patch };
    receiveSnapshot?.(mutableGateway.snapshot);
  };
  return { gateway, mutableGateway, updateSnapshot };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("OutcomesPage", () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
      expect(request).toHaveBeenCalledWith("outcomes.get", { id: "outcome-a" });
      expect(page.querySelector('[data-outcome-detail-id="outcome-a"]')).not.toBeNull();
    });
    expect(page.textContent).toContain("Outcome A objective");
    expect(page.textContent).toContain("Verify the release evidence");
    expect(page.textContent).toContain("card-1");
    expect(page.textContent).toContain("A linked card is blocked");
    expect(page.textContent).toContain("Refresh");
    expect(page.querySelector('[data-outcome-action="refresh"]')).toBeNull();
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
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')).not.toBeNull();
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
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-action="activate"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="activate"]')?.click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("outcomes.activate", {
        expectedRevision: 1,
        id: "outcome-a",
      });
    });
    expect(page.querySelector<HTMLButtonElement>('[data-outcome-action="activate"]')?.disabled).toBe(
      true,
    );
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
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-action="create"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="create"]')?.click();

    await vi.waitFor(() => {
      expect(page.querySelector('openclaw-modal-dialog[label="Create outcome"]')).not.toBeNull();
    });
    const form = page.querySelector<HTMLFormElement>('[data-outcome-create-form]');
    expect(form).not.toBeNull();
    const title = form?.querySelector<HTMLInputElement>('input[name="title"]');
    const objective = form?.querySelector<HTMLTextAreaElement>('textarea[name="objective"]');
    const criterion = form?.querySelector<HTMLInputElement>('input[name="criterion"]');
    if (!title || !objective || !criterion || !form) {
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
    });
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
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-action="create"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="create"]')?.click();

    await vi.waitFor(() => {
      expect(
        page.querySelector<HTMLButtonElement>("[data-outcome-add-criterion]"),
      ).not.toBeNull();
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
    const criteria = Array.from(form?.querySelectorAll<HTMLInputElement>('input[name="criterion"]') ?? []);
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
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-action="cancel"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="cancel"]')?.click();

    expect(request).not.toHaveBeenCalledWith("outcomes.cancel", expect.anything());
    await vi.waitFor(() => {
      expect(page.querySelector('openclaw-modal-dialog[label="Cancel outcome"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-confirm-cancel]')?.click();

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
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')).not.toBeNull();
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-b"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')).not.toBeNull();
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
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.disabled).toBe(false);
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(page.textContent).toContain("Outcome A (new view) objective");
    });

    resolveRefresh?.({ outcome: outcomeDetail("outcome-a", "Outcome A (stale refresh)") });
    await new Promise((resolve) => setTimeout(resolve, 0));
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
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')).not.toBeNull();
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-b"]')).not.toBeNull();
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-select="outcome-a"]')?.click();
    await vi.waitFor(() => {
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')).not.toBeNull();
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-action="cancel"]')).not.toBeNull();
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
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.disabled).toBe(true);
      expect(page.querySelector<HTMLButtonElement>('[data-outcome-action="cancel"]')?.disabled).toBe(true);
    });
    page.querySelector<HTMLButtonElement>('[data-outcome-action="refresh"]')?.click();
    page.querySelector<HTMLButtonElement>('[data-outcome-action="cancel"]')?.click();
    expect(request.mock.calls.filter(([method]) => method === "outcomes.refresh")).toHaveLength(1);
    expect(request).not.toHaveBeenCalledWith("outcomes.cancel", expect.anything());

    resolveRefresh?.({
      outcome: { ...outcomeDetail("outcome-a", "Outcome A"), revision: 2 },
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    await page.updateComplete;

    expect(page.querySelector('[data-outcome-detail-id="outcome-a"]')).toBeNull();
    expect(page.querySelector('[data-outcome-detail-id="outcome-b"]')).not.toBeNull();
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
