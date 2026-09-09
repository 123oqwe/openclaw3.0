import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createInternalAgentTurnFacade } from "./agent-turn/internal-facade.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestOptions,
} from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";

const startTurn = vi.hoisted(() => vi.fn());
const waitForTurn = vi.hoisted(() => vi.fn());

vi.mock("./agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({
    startTurn,
    waitForTurn,
  }),
}));

function createContext(): GatewayRequestContext {
  const context = {
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn() },
  } as unknown as GatewayRequestContext;
  context.createAgentTurnFacade = (principal) =>
    createInternalAgentTurnFacade({
      ...principal,
      getContext: () => context,
      ...(context.getGatewayMethodRegistry
        ? { getMethodRegistry: context.getGatewayMethodRegistry }
        : {}),
    });
  return context;
}

function createOperatorClient(params: {
  caps?: string[];
  profileId: string;
  scopes: string[];
}): NonNullable<GatewayRequestOptions["client"]> {
  return {
    connId: `conn-${params.profileId}`,
    authenticatedUserId: `${params.profileId}@example.com`,
    authenticatedUserProfile: {
      profileId: params.profileId,
      displayName: params.profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      ...(params.caps ? { caps: params.caps } : {}),
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      role: "operator",
      scopes: params.scopes,
      client: {
        id: GATEWAY_CLIENT_IDS.TEST,
        version: "1",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.TEST,
      },
    },
  };
}

function createStrictReadContext(
  requiredScope: "operator.read" | "operator.talk" | "operator.write" = "operator.read",
) {
  const handler = vi.fn();
  const context = createContext();
  context.getGatewayMethodRegistry = () =>
    createGatewayMethodRegistry([
      {
        name: "sessions.list",
        scope: requiredScope,
        owner: { kind: "core", area: "sessions" },
        handler: ({ respond }: GatewayRequestHandlerOptions) => {
          handler();
          respond(true, { sessions: [] });
        },
      },
    ]);
  return { context, handler };
}

const dispatchStrictGatewayMethod = dispatchGatewayMethodInProcess as <T>(
  method: string,
  params: Record<string, unknown>,
  options: {
    forceSyntheticClient: true;
    requireAuthenticatedRequest: true;
    syntheticScopes: string[];
  },
) => Promise<T>;
async function dispatchScopedMethod(params: {
  client: NonNullable<GatewayRequestOptions["client"]>;
  context: GatewayRequestContext;
  method: "agent" | "agent.wait";
  params: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  return await withPluginRuntimeGatewayRequestScope(
    {
      client: params.client,
      context: params.context,
      isWebchatConnect: () => false,
    },
    async () =>
      await dispatchGatewayMethodInProcess(params.method, params.params, {
        disableSyntheticClient: true,
        requireScopedClient: true,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
  );
}

describe("typed in-process agent authorization (dispatch matrix)", () => {
  beforeEach(() => {
    startTurn.mockReset();
    waitForTurn.mockReset();
  });
  it.each([
    ["agent", { message: "owned turn", idempotencyKey: "host-owned" }],
    ["agent.wait", { runId: "host-owned" }],
  ] as const)(
    "uses the captured host factory for %s and refuses an ownerless context",
    async (method, params) => {
      const client = createOperatorClient({ profileId: "owner", scopes: ["operator.write"] });
      const context = createContext();
      const createFacade = vi.fn(context.createAgentTurnFacade!);
      context.createAgentTurnFacade = createFacade;
      const result = { runId: "host-owned", status: "ok" };
      startTurn.mockImplementation(async ({ io }) => io.emitAcceptance([true, result, undefined]));
      waitForTurn.mockResolvedValue(result);

      await expect(dispatchScopedMethod({ client, context, method, params })).resolves.toEqual(
        result,
      );
      expect(createFacade).toHaveBeenCalledOnce();
      expect(createFacade.mock.calls[0]?.[0].client).toBe(client);

      delete context.createAgentTurnFacade;
      await expect(dispatchScopedMethod({ client, context, method, params })).rejects.toThrow(
        "Gateway instance agent turn facade unavailable",
      );
    },
  );

  it.each([
    ["operator.write", "operator.read"],
    ["operator.read", "operator.write"],
  ] as const)(
    "allows strict read when request grants %s and ambient authority grants %s",
    async (requestGrant, ambientGrant) => {
      const requestClient = createOperatorClient({
        profileId: "heterogeneous-scope-owner",
        scopes: [requestGrant],
      });
      const lifetime = new AbortController();
      const { context, handler } = createStrictReadContext();
      const scope = {
        client: requestClient,
        context,
        isWebchatConnect: () => false,
        authenticatedRequestAuthority: {
          profileId: "heterogeneous-scope-owner",
          signal: lifetime.signal,
          assertCurrent: () => lifetime.signal.throwIfAborted(),
        },
      } as Parameters<typeof withPluginRuntimeGatewayRequestScope>[0];

      await expect(
        withPluginRuntimeGatewayRequestScope(scope, () =>
          withOperatorToolGatewayAuthority(
            {
              authenticatedUserProfile: requestClient.authenticatedUserProfile!,
              scopes: [ambientGrant],
            },
            () =>
              dispatchStrictGatewayMethod(
                "sessions.list",
                {},
                {
                  forceSyntheticClient: true,
                  requireAuthenticatedRequest: true,
                  syntheticScopes: ["operator.read"],
                },
              ),
          ),
        ),
      ).resolves.toEqual({ sessions: [] });
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it("does not combine separate ambient and request grants to authorize write", async () => {
    const requestClient = createOperatorClient({
      profileId: "split-scope-owner",
      scopes: ["operator.write"],
    });
    const lifetime = new AbortController();
    const { context, handler } = createStrictReadContext("operator.write");
    const scope = {
      client: requestClient,
      context,
      isWebchatConnect: () => false,
      authenticatedRequestAuthority: {
        profileId: "split-scope-owner",
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
      },
    } as Parameters<typeof withPluginRuntimeGatewayRequestScope>[0];

    await expect(
      withPluginRuntimeGatewayRequestScope(scope, () =>
        withOperatorToolGatewayAuthority(
          {
            authenticatedUserProfile: requestClient.authenticatedUserProfile!,
            scopes: ["operator.read"],
          },
          () =>
            dispatchStrictGatewayMethod(
              "sessions.list",
              {},
              {
                forceSyntheticClient: true,
                requireAuthenticatedRequest: true,
                syntheticScopes: ["operator.write"],
              },
            ),
        ),
      ),
    ).rejects.toThrow(/operator\.write|scope/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["agent", { message: "retired turn", idempotencyKey: "retired-host" }],
    ["agent.wait", { runId: "retired-host" }],
  ] as const)(
    "revalidates the captured host after awaiting its %s factory",
    async (method, params) => {
      const context = createContext();
      let current = context;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const createFacade = context.createAgentTurnFacade!;
      context.createAgentTurnFacade = async (principal) => {
        entered.resolve();
        await release.promise;
        return createFacade(principal);
      };

      const pending = dispatchGatewayMethodInProcess(method, params, {
        forceSyntheticClient: true,
        operatorRoleActor: { kind: "system" },
        resolveGatewayContext: () => current,
      });
      const rejected = expect(pending).rejects.toThrow("current gateway instance binding");
      await entered.promise;
      current = createContext();
      release.resolve();

      await rejected;
      expect(startTurn).not.toHaveBeenCalled();
      expect(waitForTurn).not.toHaveBeenCalled();
    },
  );

  it.each(["operator", "system"] as const)(
    "preserves %s attribution and never widens a synthetic tool caller's scopes",
    async (actorKind) => {
      const operatorRoleActor = actorKind === "system" ? { kind: "system" as const } : undefined;
      const owner = createOperatorClient({
        profileId: "tool-owner",
        scopes: ["operator.read"],
      });
      let dispatched: GatewayRequestOptions["client"] = null;
      const context = createContext();
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "sessions.list",
            scope: "operator.read",
            owner: { kind: "core", area: "sessions" },
            handler: ({ client, respond }: GatewayRequestHandlerOptions) => {
              dispatched = client;
              respond(true, { sessions: [] });
            },
          },
        ]);

      await withOperatorToolGatewayAuthority(
        {
          authenticatedUserProfile: owner.authenticatedUserProfile!,
          operatorRoleActor,
          scopes: owner.connect.scopes ?? [],
        },
        async () =>
          await dispatchGatewayMethodInProcess(
            "sessions.list",
            {},
            {
              forceSyntheticClient: true,
              syntheticScopes: ["operator.read", "operator.admin"],
              resolveGatewayContext: () => context,
            },
          ),
      );

      expect(dispatched).toMatchObject({
        authenticatedUserProfile: { profileId: "tool-owner" },
        connect: { scopes: ["operator.read"] },
        internal: { syntheticClient: true, ...(operatorRoleActor ? { operatorRoleActor } : {}) },
      });
    },
  );
});
