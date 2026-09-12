/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import "./outcomes-page.ts";

type OutcomesPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
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
});
