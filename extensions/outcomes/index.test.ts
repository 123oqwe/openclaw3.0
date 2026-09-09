import { readFileSync } from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("Outcome plugin shell", () => {
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
    expect(packageManifest).not.toHaveProperty("dependencies");
  });

  it("registers only the content-free operator.read health method", async () => {
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

    expect(registerGatewayMethod).toHaveBeenCalledOnce();
    const [method, handler, options] = registerGatewayMethod.mock.calls[0] ?? [];
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
    expect(registerControlUiDescriptor).not.toHaveBeenCalled();
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
});
