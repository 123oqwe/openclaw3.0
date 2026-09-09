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
type StrictDispatch = typeof dispatchStrictGatewayMethod;

describe("typed in-process agent authorization (strict matrix)", () => {
  beforeEach(() => {
    startTurn.mockReset();
    waitForTurn.mockReset();
  });
  it("does not restore ambient admin to strict requested scopes", async () => {
    const requestClient = createOperatorClient({
      profileId: "strict-owner",
      scopes: ["operator.read", "operator.admin"],
    });
    const context = createContext();
    let dispatched: GatewayRequestOptions["client"] = null;
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
    const lifetime = new AbortController();
    const scope = {
      client: requestClient,
      context,
      isWebchatConnect: () => false,
      authenticatedRequestAuthority: {
        profileId: "strict-owner",
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
      },
    } as Parameters<typeof withPluginRuntimeGatewayRequestScope>[0];

    await withPluginRuntimeGatewayRequestScope(scope, () =>
      withOperatorToolGatewayAuthority(
        {
          authenticatedUserProfile: requestClient.authenticatedUserProfile!,
          scopes: requestClient.connect.scopes ?? [],
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
    );

    expect(dispatched).toMatchObject({
      authenticatedUserProfile: { profileId: "strict-owner" },
      connect: { scopes: ["operator.read"] },
    });
  });

  it("intersects strict scopes with an independently narrower ambient authority", async () => {
    const requestClient = createOperatorClient({
      profileId: "strict-intersection-owner",
      scopes: ["operator.read", "operator.write"],
    });
    const context = createContext();
    let dispatched: GatewayRequestOptions["client"] = null;
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
    const lifetime = new AbortController();
    const scope = {
      client: requestClient,
      context,
      isWebchatConnect: () => false,
      authenticatedRequestAuthority: {
        profileId: "strict-intersection-owner",
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
      },
    } as Parameters<typeof withPluginRuntimeGatewayRequestScope>[0];

    await withPluginRuntimeGatewayRequestScope(scope, () =>
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
              syntheticScopes: ["operator.read", "operator.write"],
            },
          ),
      ),
    );

    expect(dispatched).toMatchObject({ connect: { scopes: ["operator.read"] } });
  });

  it("dispatches strict read requests when every authority matches and is current", async () => {
    const requestClient = createOperatorClient({
      profileId: "matching-owner",
      scopes: ["operator.read"],
    });
    const lifetime = new AbortController();
    const { context, handler } = createStrictReadContext();
    const scope = {
      client: requestClient,
      context,
      isWebchatConnect: () => false,
      authenticatedRequestAuthority: {
        profileId: "matching-owner",
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
      },
    } as Parameters<typeof withPluginRuntimeGatewayRequestScope>[0];

    await expect(
      withPluginRuntimeGatewayRequestScope(scope, () =>
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
    ).resolves.toEqual({ sessions: [] });
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    ["operator.write", ["operator.read"]],
    ["operator.write", ["operator.talk"]],
    ["operator.admin", ["operator.read"]],
    ["operator.admin", ["operator.write"]],
    ["operator.admin", ["operator.talk"]],
  ] as const)(
    "honors the host implication from %s to %s for every strict authority",
    async (grantedScope, requestedScopes) => {
      const requestClient = createOperatorClient({
        profileId: "implied-scope-owner",
        scopes: [grantedScope],
      });
      const lifetime = new AbortController();
      const { context, handler } = createStrictReadContext(requestedScopes[0]);
      const scope = {
        client: requestClient,
        context,
        isWebchatConnect: () => false,
        authenticatedRequestAuthority: {
          profileId: "implied-scope-owner",
          signal: lifetime.signal,
          assertCurrent: () => lifetime.signal.throwIfAborted(),
        },
      } as Parameters<typeof withPluginRuntimeGatewayRequestScope>[0];

      await expect(
        withPluginRuntimeGatewayRequestScope(scope, () =>
          withOperatorToolGatewayAuthority(
            {
              authenticatedUserProfile: requestClient.authenticatedUserProfile!,
              scopes: [grantedScope],
            },
            () =>
              dispatchStrictGatewayMethod(
                "sessions.list",
                {},
                {
                  forceSyntheticClient: true,
                  requireAuthenticatedRequest: true,
                  syntheticScopes: [...requestedScopes],
                },
              ),
          ),
        ),
      ).resolves.toEqual({ sessions: [] });
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it("rejects a strict write request when one authority only grants read", async () => {
    const requestClient = createOperatorClient({
      profileId: "narrow-scope-owner",
      scopes: ["operator.read"],
    });
    const lifetime = new AbortController();
    const { context, handler } = createStrictReadContext("operator.write");
    const scope = {
      client: requestClient,
      context,
      isWebchatConnect: () => false,
      authenticatedRequestAuthority: {
        profileId: "narrow-scope-owner",
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
      },
    } as Parameters<typeof withPluginRuntimeGatewayRequestScope>[0];

    await expect(
      withPluginRuntimeGatewayRequestScope(scope, () =>
        withOperatorToolGatewayAuthority(
          {
            authenticatedUserProfile: requestClient.authenticatedUserProfile!,
            scopes: ["operator.write"],
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
    ).rejects.toThrow("missing scope: operator.write");
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not combine separate authority grants for a strict request", async () => {
    const requestClient = createOperatorClient({
      profileId: "split-scope-owner",
      scopes: ["operator.read"],
    });
    const lifetime = new AbortController();
    const { context, handler } = createStrictReadContext();
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
            scopes: ["operator.talk"],
          },
          () =>
            dispatchStrictGatewayMethod(
              "sessions.list",
              {},
              {
                forceSyntheticClient: true,
                requireAuthenticatedRequest: true,
                syntheticScopes: ["operator.read", "operator.talk"],
              },
            ),
        ),
      ),
    ).rejects.toThrow("missing scope: operator.read");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects strict dispatch when ambient and request principals differ", async () => {
    const requestClient = createOperatorClient({
      profileId: "request-owner",
      scopes: ["operator.read"],
    });
    const ambientClient = createOperatorClient({
      profileId: "ambient-owner",
      scopes: ["operator.read"],
    });
    const lifetime = new AbortController();
    const { context, handler } = createStrictReadContext();
    const scope = {
      client: requestClient,
      context,
      isWebchatConnect: () => false,
      authenticatedRequestAuthority: {
        profileId: "request-owner",
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
      },
    } as Parameters<typeof withPluginRuntimeGatewayRequestScope>[0];
    const strictDispatch: StrictDispatch = dispatchStrictGatewayMethod;

    await expect(
      withPluginRuntimeGatewayRequestScope(scope, () =>
        withOperatorToolGatewayAuthority(
          {
            authenticatedUserProfile: ambientClient.authenticatedUserProfile!,
            scopes: ambientClient.connect.scopes ?? [],
          },
          () =>
            strictDispatch(
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
    ).rejects.toThrow("authenticated request principal mismatch");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects strict dispatch when the scoped client differs from request authority", async () => {
    const requestClient = createOperatorClient({
      profileId: "scoped-owner",
      scopes: ["operator.read"],
    });
    const lifetime = new AbortController();
    const { context, handler } = createStrictReadContext();
    const scope = {
      client: requestClient,
      context,
      isWebchatConnect: () => false,
      authenticatedRequestAuthority: {
        profileId: "authority-owner",
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
      },
    } as Parameters<typeof withPluginRuntimeGatewayRequestScope>[0];
    const strictDispatch: StrictDispatch = dispatchStrictGatewayMethod;

    await expect(
      withPluginRuntimeGatewayRequestScope(scope, () =>
        strictDispatch(
          "sessions.list",
          {},
          {
            forceSyntheticClient: true,
            requireAuthenticatedRequest: true,
            syntheticScopes: ["operator.read"],
          },
        ),
      ),
    ).rejects.toThrow("authenticated request principal mismatch");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects strict dispatch after authenticated request authority expires", async () => {
    const requestClient = createOperatorClient({
      profileId: "expired-request-owner",
      scopes: ["operator.read"],
    });
    const lifetime = new AbortController();
    const { context, handler } = createStrictReadContext();
    lifetime.abort(new Error("authenticated gateway request expired"));
    const scope = {
      client: requestClient,
      context,
      isWebchatConnect: () => false,
      authenticatedRequestAuthority: {
        profileId: "expired-request-owner",
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
      },
    } as Parameters<typeof withPluginRuntimeGatewayRequestScope>[0];
    const strictDispatch: StrictDispatch = dispatchStrictGatewayMethod;

    await expect(
      withPluginRuntimeGatewayRequestScope(scope, () =>
        strictDispatch(
          "sessions.list",
          {},
          {
            forceSyntheticClient: true,
            requireAuthenticatedRequest: true,
            syntheticScopes: ["operator.read"],
          },
        ),
      ),
    ).rejects.toThrow("authenticated gateway request expired");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rechecks strict request authority before commit and forwards its cancellation", async () => {
    const requestClient = createOperatorClient({
      profileId: "commit-owner",
      scopes: ["operator.read"],
    });
    const lifetime = new AbortController();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const completed = createDeferredCore();
    let observedSignal: AbortSignal | undefined;
    let committed = false;
    const context = createContext();
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "sessions.list",
          scope: "operator.read",
          owner: { kind: "core", area: "sessions" },
          handler: async (options: GatewayRequestHandlerOptions) => {
            const { respond, sessionMutationCommitGuard, signal } = options;
            observedSignal = signal;
            entered.resolve();
            await release.promise;
            try {
              sessionMutationCommitGuard?.();
              committed = true;
              respond(true, { sessions: [] });
            } finally {
              completed.resolve();
            }
          },
        },
      ]);
    const scope = {
      client: requestClient,
      context,
      isWebchatConnect: () => false,
      authenticatedRequestAuthority: {
        profileId: "commit-owner",
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
      },
    } as Parameters<typeof withPluginRuntimeGatewayRequestScope>[0];
    const strictDispatch: StrictDispatch = dispatchStrictGatewayMethod;

    const pending = withPluginRuntimeGatewayRequestScope(scope, () =>
      strictDispatch(
        "sessions.list",
        {},
        {
          forceSyntheticClient: true,
          requireAuthenticatedRequest: true,
          syntheticScopes: ["operator.read"],
        },
      ),
    );
    await Promise.race([
      entered.promise,
      pending.then(
        () => {
          throw new Error("strict dispatch completed before handler admission");
        },
        (error: unknown) => {
          throw error;
        },
      ),
    ]);
    lifetime.abort(new Error("authenticated gateway request expired"));
    release.resolve();

    await expect(pending).rejects.toThrow("authenticated gateway request expired");
    await completed.promise;
    expect(observedSignal?.aborted).toBe(true);
    expect(committed).toBe(false);
  });
});
