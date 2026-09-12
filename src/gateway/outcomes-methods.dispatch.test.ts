import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { registerOutcomeGatewayMethods } from "../../extensions/outcomes/runtime-api.js";

const outcomeId = "123e4567-e89b-42d3-a456-426614174000";

function createContext(): GatewayRequestContext {
  return {
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn() },
  } as unknown as GatewayRequestContext;
}

function createOperatorClient(
  profileId: string,
  scopes: string[],
): NonNullable<GatewayRequestOptions["client"]> {
  return {
    connId: `conn-${profileId}`,
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: { profileId, displayName: profileId, hasAvatar: false, updatedAt: 1 },
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      role: "operator",
      scopes,
      client: {
        id: GATEWAY_CLIENT_IDS.TEST,
        version: "1",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.TEST,
      },
    },
  } as unknown as NonNullable<GatewayRequestOptions["client"]>;
}

function registerHarness() {
  const records = new Map<string, unknown>();
  const registrations: Array<{
    method: string;
    handler: never;
    options: { scope: "operator.read" | "operator.write" };
  }> = [];
  const api = createTestPluginApi({
    id: "outcomes",
    name: "Outcomes",
    runtime: {
      state: {
        openKeyedStore: () => ({
          registerIfAbsent: async (key: string, value: unknown) => {
            if (records.has(key)) return false;
            records.set(key, value);
            return true;
          },
          lookup: async (key: string) => records.get(key),
          entries: async () => Array.from(records, ([key, value]) => ({ key, value })),
          update: async (key: string, decide: (current: unknown) => unknown) => {
            const next = decide(records.get(key));
            if (next === undefined) return false;
            records.set(key, next);
            return true;
          },
          deleteIf: async (key: string, predicate: (current: unknown) => boolean) => {
            const current = records.get(key);
            if (current === undefined || !predicate(current)) return false;
            records.delete(key);
            return true;
          },
        }),
      },
      gateway: { isAvailable: async () => false, request: async () => ({}) },
    } as never,
    registerGatewayMethod: (method, handler, options) => {
      registrations.push({
        method,
        handler: handler as never,
        options: options as { scope: "operator.read" | "operator.write" },
      });
    },
  });
  registerOutcomeGatewayMethods(api);
  const context = createContext();
  context.getGatewayMethodRegistry = () =>
    createGatewayMethodRegistry(
      registrations.map((registration) => ({
        name: registration.method,
        handler: registration.handler,
        scope: registration.options.scope,
        owner: { kind: "plugin" as const, pluginId: "outcomes" },
      })),
    );
  return { context, registrations };
}

async function dispatch(params: {
  client: NonNullable<GatewayRequestOptions["client"]>;
  context: GatewayRequestContext;
  method: string;
  request: Record<string, unknown>;
  revoked?: boolean;
}) {
  const authority = new AbortController();
  return await withPluginRuntimeGatewayRequestScope(
    {
      client: params.client,
      context: params.context,
      isWebchatConnect: () => false,
      authenticatedRequestAuthority: {
        profileId: params.client.authenticatedUserProfile!.profileId,
        signal: authority.signal,
        assertCurrent: () => {
          if (params.revoked) throw new Error("authenticated request authority expired");
          authority.signal.throwIfAborted();
        },
      },
    },
    async () =>
      await withOperatorToolGatewayAuthority(
        {
          authenticatedUserProfile: params.client.authenticatedUserProfile!,
          scopes: params.client.connect.scopes ?? [],
        },
        async () =>
          await dispatchGatewayMethodInProcess(params.method, params.request, {
            forceSyntheticClient: true,
            requireAuthenticatedRequest: true,
            requireScopedClient: true,
            syntheticScopes: ["operator.read", "operator.write"],
          }),
      ),
  );
}

describe("P-02 Outcome Gateway admission", () => {
  it("refuses an unscoped authenticated request before its handler runs", async () => {
    const { context, registrations } = registerHarness();
    const handler = vi.fn(registrations.find(({ method }) => method === "outcomes.get")?.handler);
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "outcomes.get",
          handler: handler as never,
          scope: "operator.read",
          owner: { kind: "plugin", pluginId: "outcomes" },
        },
      ]);
    await expect(
      dispatch({
        client: createOperatorClient("manager-a", []),
        context,
        method: "outcomes.get",
        request: { id: outcomeId },
      }),
    ).rejects.toThrow(/scope/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it("admits operator.write to the read method through host scope implication", async () => {
    const { context, registrations } = registerHarness();
    const handler = vi.fn(registrations.find(({ method }) => method === "outcomes.get")?.handler);
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "outcomes.get",
          handler: handler as never,
          scope: "operator.read",
          owner: { kind: "plugin", pluginId: "outcomes" },
        },
      ]);
    await expect(
      dispatch({
        client: createOperatorClient("manager-a", ["operator.write"]),
        context,
        method: "outcomes.get",
        request: { id: outcomeId },
      }),
    ).rejects.toMatchObject({ code: "OUTCOME_NOT_FOUND" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("refuses an expired authenticated authority before its handler runs", async () => {
    const { context, registrations } = registerHarness();
    const handler = vi.fn(registrations.find(({ method }) => method === "outcomes.get")?.handler);
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "outcomes.get",
          handler: handler as never,
          scope: "operator.read",
          owner: { kind: "plugin", pluginId: "outcomes" },
        },
      ]);
    await expect(
      dispatch({
        client: createOperatorClient("manager-a", ["operator.read"]),
        context,
        method: "outcomes.get",
        request: { id: outcomeId },
        revoked: true,
      }),
    ).rejects.toThrow("authenticated request authority expired");
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses an exact create replay after effective write authority is revoked", async () => {
    const { context } = registerHarness();
    const request = {
      id: outcomeId,
      title: "Ship safely",
      objective: "Ship the Outcome beta safely",
      criteria: [
        {
          id: "123e4567-e89b-42d3-a456-426614174001",
          text: "Hosted evidence is available",
          required: true,
        },
      ],
    };
    await expect(
      dispatch({
        client: createOperatorClient("manager-a", ["operator.write"]),
        context,
        method: "outcomes.create",
        request,
      }),
    ).resolves.toMatchObject({ outcome: { id: outcomeId }, replayed: false });
    await expect(
      dispatch({
        client: createOperatorClient("manager-a", ["operator.read"]),
        context,
        method: "outcomes.create",
        request,
      }),
    ).rejects.toThrow(/scope/i);
  });
});
