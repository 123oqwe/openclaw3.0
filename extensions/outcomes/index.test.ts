import { readFileSync } from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("Outcome plugin shell", () => {
  function createRegistrationStore() {
    const records = new Map<string, unknown>();
    return {
      registerIfAbsent: async (key: string, value: unknown) => {
        if (records.has(key)) {
          return false;
        }
        records.set(key, value);
        return true;
      },
      lookup: async (key: string) => records.get(key),
      entries: async () => Array.from(records, ([key, value]) => ({ key, value })),
      update: async (key: string, decide: (current: unknown) => unknown) => {
        const next = decide(records.get(key));
        if (next === undefined) {
          return false;
        }
        records.set(key, next);
        return true;
      },
      deleteIf: async (key: string, predicate: (current: unknown) => boolean) => {
        const current = records.get(key);
        if (current === undefined || !predicate(current)) {
          return false;
        }
        records.delete(key);
        return true;
      },
    };
  }

  it("declares the disabled bundled shell contract", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const packageManifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest).toEqual({
      id: "outcomes",
      name: "Outcomes",
      description: "Outcome responsibility and acceptance layer.",
      enabledByDefault: false,
      activation: { onStartup: true },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    });
    expect(packageManifest).toMatchObject({
      name: "@openclaw/outcomes",
      version: "2026.8.1",
      private: true,
      type: "module",
      openclaw: { extensions: ["./index.ts"] },
      devDependencies: {
        "@openclaw/plugin-sdk": "workspace:*",
        openclaw: "workspace:*",
      },
      peerDependencies: { openclaw: ">=2026.8.1" },
      peerDependenciesMeta: { openclaw: { optional: true } },
    });
    expect(packageManifest.dependencies).toEqual({
      "@openclaw/outcomes-contract": "workspace:*",
      "@openclaw/workboard-contract": "workspace:*",
      typebox: "1.3.18",
      zod: "4.4.3",
    });
  });

  it("registers the authenticated P-02 first-package method scopes", () => {
    const registerGatewayMethod = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "outcomes",
        name: "Outcomes",
        runtime: {
          state: { openKeyedStore: vi.fn(createRegistrationStore) },
        } as never,
        registerGatewayMethod,
      }),
    );

    expect(
      registerGatewayMethod.mock.calls.map(([method, _handler, options]) => ({ method, options })),
    ).toEqual([
      { method: "outcomes.health", options: { scope: "operator.read" } },
      { method: "outcomes.create", options: { scope: "operator.write" } },
      { method: "outcomes.get", options: { scope: "operator.read" } },
      { method: "outcomes.list", options: { scope: "operator.read" } },
      { method: "outcomes.update", options: { scope: "operator.write" } },
      { method: "outcomes.linkWorkboard", options: { scope: "operator.write" } },
      { method: "outcomes.unlinkWorkboard", options: { scope: "operator.write" } },
      { method: "outcomes.activate", options: { scope: "operator.write" } },
      { method: "outcomes.refresh", options: { scope: "operator.write" } },
      { method: "outcomes.cancel", options: { scope: "operator.write" } },
    ]);
  });

  it("registers the plugin-owned Outcomes tab", () => {
    const registerControlUiDescriptor = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "outcomes",
        name: "Outcomes",
        runtime: {
          state: { openKeyedStore: vi.fn(createRegistrationStore) },
        } as never,
        registerControlUiDescriptor,
      }),
    );

    expect(registerControlUiDescriptor).toHaveBeenCalledWith({
      surface: "tab",
      id: "outcomes",
      label: "Outcomes",
      placement: "route:outcomes",
      icon: "target",
      group: "control",
      requiredScopes: ["operator.read"],
    });
  });

  it("keeps the content-free operator.read health method in the first package", async () => {
    const registerGatewayMethod = vi.fn();
    const registerTool = vi.fn();
    const registerCli = vi.fn();
    const registerService = vi.fn();
    const registerControlUiDescriptor = vi.fn();
    const openKeyedStore = vi.fn(() => ({ update: vi.fn(), deleteIf: vi.fn() }));
    const gatewayRequest = vi.fn(async () => ({
      cards: [{ id: "sensitive-card", title: "must-not-leak-through-health" }],
    }));

    plugin.register(
      createTestPluginApi({
        id: "outcomes",
        name: "Outcomes",
        runtime: {
          state: { openKeyedStore },
          gateway: {
            isAvailable: async () => true,
            request: gatewayRequest,
          },
        } as never,
        registerGatewayMethod,
        registerTool,
        registerCli,
        registerService,
        registerControlUiDescriptor,
      }),
    );

    const healthRegistration = registerGatewayMethod.mock.calls.find(
      ([method]) => method === "outcomes.health",
    );
    const [method, handler, options] = healthRegistration ?? [];
    expect(method).toBe("outcomes.health");
    expect(options).toEqual({ scope: "operator.read" });

    const respond = vi.fn();
    await handler({ params: {}, respond } as never);
    expect(respond).toHaveBeenCalledWith(true, {
      plugin: "outcomes",
      schemaVersion: 1,
      state: { available: true, atomicUpdate: true, atomicDelete: true },
      gateway: { available: true, requestScoped: true },
      workboard: { available: true },
    });
    expect(openKeyedStore).toHaveBeenCalledWith({
      namespace: "outcomes-capability-v1",
      maxEntries: 2,
      overflowPolicy: "reject-new",
    });
    expect(gatewayRequest).toHaveBeenCalledWith(
      "workboard.cards.list",
      {},
      {
        scopes: ["operator.read"],
        requireAuthenticatedRequest: true,
      },
    );
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerCli).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
    expect(registerControlUiDescriptor).toHaveBeenCalledWith({
      surface: "tab",
      id: "outcomes",
      label: "Outcomes",
      placement: "route:outcomes",
      icon: "target",
      group: "control",
      requiredScopes: ["operator.read"],
    });
  });

  it("reports Workboard separately when its method is unavailable", async () => {
    const registerGatewayMethod = vi.fn();
    const gatewayRequest = vi.fn(async () => {
      throw new Error("method unavailable");
    });

    plugin.register(
      createTestPluginApi({
        id: "outcomes",
        name: "Outcomes",
        runtime: {
          state: {
            openKeyedStore: vi.fn(() => ({ update: vi.fn(), deleteIf: vi.fn() })),
          },
          gateway: {
            isAvailable: async () => true,
            request: gatewayRequest,
          },
        } as never,
        registerGatewayMethod,
      }),
    );

    const [, handler] = registerGatewayMethod.mock.calls[0] ?? [];
    const respond = vi.fn();
    await handler({ params: {}, respond } as never);

    expect(gatewayRequest).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, {
      plugin: "outcomes",
      schemaVersion: 1,
      state: { available: true, atomicUpdate: true, atomicDelete: true },
      gateway: { available: true, requestScoped: true },
      workboard: { available: false },
    });
  });

  it("rejects health parameters outside the public empty-object contract before probing", async () => {
    const registerGatewayMethod = vi.fn();
    const openKeyedStore = vi.fn(createRegistrationStore);
    const isAvailable = vi.fn(async () => true);
    const request = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "outcomes",
        name: "Outcomes",
        runtime: {
          state: { openKeyedStore },
          gateway: { isAvailable, request },
        } as never,
        registerGatewayMethod,
      }),
    );
    openKeyedStore.mockClear();
    isAvailable.mockClear();
    request.mockClear();

    const healthRegistration = registerGatewayMethod.mock.calls.find(
      ([method]) => method === "outcomes.health",
    );
    const [, handler] = healthRegistration ?? [];
    const respond = vi.fn();
    await handler({ params: { unexpected: true }, respond } as never);

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "OUTCOME_INVALID_REQUEST",
      message: "Outcome request could not be completed",
    });
    expect(openKeyedStore).not.toHaveBeenCalled();
    expect(isAvailable).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
