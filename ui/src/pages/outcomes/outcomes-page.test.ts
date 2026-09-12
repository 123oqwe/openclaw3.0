/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutcomeListResult } from "@openclaw/outcomes-contract";
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

function createGateway(client: GatewayBrowserClient): ApplicationContext["gateway"] {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods(["outcomes.list"], ["operator.read"]),
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
    (gateway.snapshot as ApplicationGatewaySnapshot).hello!.auth = null;
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
    expect(page.textContent).toContain("Loading outcomes");
    expect(page.textContent).not.toContain("No outcomes yet");

    resolveList?.({ outcomes: [] });
    await vi.waitFor(() => {
      expect(page.textContent).toContain("No outcomes yet");
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
      expect(alert?.textContent).toContain("Could not load outcomes");
    });
    expect(page.textContent).not.toContain("No outcomes yet");
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

    expect(page.textContent).toContain("Outcome connection is unavailable");
    resolveList?.({ outcomes: [] });
    await page.updateComplete;
    expect(page.textContent).not.toContain("No outcomes yet");
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
      expect(page.querySelector('[data-outcome-id="outcome-visible-before-revocation"]')).not.toBeNull();
    });
    updateSnapshot({ hello: gatewayHelloForMethods(["outcomes.list"], []) });
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(1);
    expect(page.querySelector('[data-outcome-id="outcome-visible-before-revocation"]')).toBeNull();
    expect(page.textContent).toContain("Outcome access is unavailable");
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
    expect(page.textContent).toContain("Outcome access is unavailable");
  });
});
