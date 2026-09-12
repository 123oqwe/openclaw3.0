import { randomUUID } from "node:crypto";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { loadBundledPluginPublicSurfaceModule } from "../plugin-sdk/facade-runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";

type OutcomeRuntimeApi = {
  registerOutcomeGatewayMethods(api: ReturnType<typeof createTestPluginApi>): void;
};

type WorkboardRuntimeApi = {
  registerWorkboardGatewayMethods(params: { api: ReturnType<typeof createTestPluginApi> }): void;
};

type Registration = {
  method: string;
  handler: never;
  pluginId: "outcomes" | "workboard";
  scope: "operator.read" | "operator.write";
};

const outcomeId = "123e4567-e89b-42d3-a456-426614175000";
const criterionId = "123e4567-e89b-42d3-a456-426614175001";

let outcomeRuntimeApi: OutcomeRuntimeApi | undefined;
let workboardRuntimeApi: WorkboardRuntimeApi | undefined;

beforeAll(async () => {
  [outcomeRuntimeApi, workboardRuntimeApi] = await Promise.all([
    loadBundledPluginPublicSurfaceModule<OutcomeRuntimeApi>({
      dirName: "outcomes",
      artifactBasename: "runtime-api.js",
    }),
    loadBundledPluginPublicSurfaceModule<WorkboardRuntimeApi>({
      dirName: "workboard",
      artifactBasename: "runtime-api.js",
    }),
  ]);
});

afterEach(() => resetPluginStateStoreForTests());

function createOperatorClient(profileId: string, scopes: string[]) {
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

function createContext(): GatewayRequestContext {
  return {
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn() },
  } as unknown as GatewayRequestContext;
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
          if (params.revoked) {
            throw new Error("authenticated request authority expired");
          }
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

function createHarness(state: { env: NodeJS.ProcessEnv }) {
  if (!outcomeRuntimeApi || !workboardRuntimeApi) {
    throw new Error("bundled public runtime surfaces were not loaded");
  }
  const registrations: Registration[] = [];
  const outcomeWrites = { register: 0, update: 0, delete: 0 };
  const outcomeStore = createPluginStateKeyedStoreForTests("outcomes", {
    namespace: `outcomes-v1-public-workboard-${randomUUID()}`,
    maxEntries: 500,
    overflowPolicy: "reject-new",
    env: state.env,
  });
  const trackedOutcomeStore = {
    ...outcomeStore,
    registerIfAbsent: async (...args: Parameters<typeof outcomeStore.registerIfAbsent>) => {
      outcomeWrites.register += 1;
      return await outcomeStore.registerIfAbsent(...args);
    },
    update: async (...args: Parameters<NonNullable<typeof outcomeStore.update>>) => {
      outcomeWrites.update += 1;
      return await outcomeStore.update!(...args);
    },
    deleteIf: async (...args: Parameters<NonNullable<typeof outcomeStore.deleteIf>>) => {
      outcomeWrites.delete += 1;
      return await outcomeStore.deleteIf!(...args);
    },
  };
  const context = createContext();
  let workboardAvailable = true;
  let workboardListRequests = 0;
  const buildRegistry = () =>
    createGatewayMethodRegistry(
      registrations
        .filter((registration) => workboardAvailable || registration.pluginId !== "workboard")
        .map((registration) => ({
          name: registration.method,
          handler: registration.handler,
          scope: registration.scope,
          owner: { kind: "plugin" as const, pluginId: registration.pluginId },
        })),
    );
  context.getGatewayMethodRegistry = buildRegistry;
  const requestPublicGateway = async (
    method: string,
    params: Record<string, unknown>,
    options?: { requireAuthenticatedRequest?: boolean; scopes?: string[]; timeoutMs?: number },
  ) => {
    if (method === "workboard.cards.list") {
      workboardListRequests += 1;
    }
    return await dispatchGatewayMethodInProcess(method, params, {
      forceSyntheticClient: true,
      requireAuthenticatedRequest: options?.requireAuthenticatedRequest === true,
      requireScopedClient: options?.requireAuthenticatedRequest === true,
      ...(options?.scopes ? { syntheticScopes: [...options.scopes] } : {}),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  };
  const createApi = (pluginId: Registration["pluginId"], runtime: unknown) =>
    createTestPluginApi({
      id: pluginId,
      name: pluginId,
      runtime: runtime as never,
      registerGatewayMethod(method, handler, options) {
        registrations.push({
          method,
          handler: handler as never,
          pluginId,
          scope: options?.scope as Registration["scope"],
        });
      },
    });
  const outcomeApi = createApi("outcomes", {
    state: { openKeyedStore: () => trackedOutcomeStore },
    gateway: { isAvailable: async () => true, request: requestPublicGateway },
  } as never);
  const workboardApi = createApi("workboard", {
    gateway: { isAvailable: async () => true, request: requestPublicGateway },
  } as never);
  outcomeRuntimeApi.registerOutcomeGatewayMethods(outcomeApi);
  workboardRuntimeApi.registerWorkboardGatewayMethods({ api: workboardApi });
  return {
    context,
    outcomeWrites,
    outcomeStore,
    getWorkboardListRequests() {
      return workboardListRequests;
    },
    setWorkboardAvailable(available: boolean) {
      workboardAvailable = available;
    },
  };
}

describe("Outcome public Workboard Gateway integration", () => {
  it("reads a public Workboard card, proof, and artifact through both bundled runtime APIs", async () => {
    await withOpenClawTestState(
      { label: "outcome-public-workboard", scenario: "minimal" },
      async (state) => {
        const harness = createHarness(state);
        const owner = createOperatorClient("manager-a", ["operator.read", "operator.write"]);
        const cardResult = (await dispatch({
          client: owner,
          context: harness.context,
          method: "workboard.cards.create",
          request: { title: "Public integration source", priority: "normal" },
        })) as { card: { id: string } };
        await dispatch({
          client: owner,
          context: harness.context,
          method: "workboard.cards.proof",
          request: { id: cardResult.card.id, status: "passed", label: "Hosted proof" },
        });
        await dispatch({
          client: owner,
          context: harness.context,
          method: "workboard.cards.artifact",
          request: { id: cardResult.card.id, label: "Hosted artifact", path: "/tmp/result.json" },
        });
        await dispatch({
          client: owner,
          context: harness.context,
          method: "outcomes.create",
          request: {
            id: outcomeId,
            title: "Public integration",
            objective: "Read the public Workboard source",
            criteria: [{ id: criterionId, text: "Public evidence", required: true }],
          },
        });
        await dispatch({
          client: owner,
          context: harness.context,
          method: "outcomes.linkWorkboard",
          request: { id: outcomeId, expectedRevision: 1, criterionId, cardId: cardResult.card.id },
        });
        const writesBeforeGet = { ...harness.outcomeWrites };
        const listRequestsBeforeGet = harness.getWorkboardListRequests();
        const detail = await dispatch({
          client: owner,
          context: harness.context,
          method: "outcomes.get",
          request: { id: outcomeId },
        });
        expect(detail).toMatchObject({
          outcome: {
            id: outcomeId,
            work: [{ ref: { cardId: cardResult.card.id } }],
            evidence: [
              { label: "Hosted artifact", sourceId: expect.any(String) },
              { label: "Hosted proof", sourceId: expect.any(String) },
            ],
          },
        });
        expect(harness.outcomeWrites).toEqual(writesBeforeGet);
        expect(harness.getWorkboardListRequests()).toBe(listRequestsBeforeGet + 1);
        await expect(
          dispatch({
            client: owner,
            context: harness.context,
            method: "outcomes.refresh",
            request: { id: outcomeId, expectedRevision: 2 },
          }),
        ).resolves.toMatchObject({
          refresh: { status: "available" },
          outcome: { id: outcomeId, revision: 3 },
        });
        await expect(harness.outcomeStore.lookup(outcomeId)).resolves.toMatchObject({
          revision: 3,
          projections: [
            {
              availability: "available",
              ref: { cardId: cardResult.card.id },
              proofs: [expect.objectContaining({ sourceId: expect.any(String) })],
              artifacts: [expect.objectContaining({ sourceId: expect.any(String) })],
            },
          ],
        });
      },
    );
  });

  it("does not expose an Outcome or write through a foreign or revoked public Gateway request", async () => {
    await withOpenClawTestState(
      { label: "outcome-public-workboard-authority", scenario: "minimal" },
      async (state) => {
        const harness = createHarness(state);
        const owner = createOperatorClient("manager-a", ["operator.read", "operator.write"]);
        const foreign = createOperatorClient("manager-b", ["operator.read"]);
        const card = (await dispatch({
          client: owner,
          context: harness.context,
          method: "workboard.cards.create",
          request: { title: "Owner-only Workboard source", priority: "normal" },
        })) as { card: { id: string } };
        await dispatch({
          client: owner,
          context: harness.context,
          method: "outcomes.create",
          request: {
            id: outcomeId,
            title: "Private integration",
            objective: "Do not disclose ownership",
            criteria: [{ id: criterionId, text: "Private evidence", required: true }],
          },
        });
        await dispatch({
          client: owner,
          context: harness.context,
          method: "outcomes.linkWorkboard",
          request: { id: outcomeId, expectedRevision: 1, criterionId, cardId: card.card.id },
        });
        await expect(
          dispatch({
            client: owner,
            context: harness.context,
            method: "outcomes.get",
            request: { id: outcomeId },
          }),
        ).resolves.toMatchObject({ outcome: { id: outcomeId } });
        const writesBefore = { ...harness.outcomeWrites };
        const listRequestsBefore = harness.getWorkboardListRequests();
        await expect(
          dispatch({
            client: foreign,
            context: harness.context,
            method: "outcomes.get",
            request: { id: outcomeId },
          }),
        ).rejects.toMatchObject({ code: "OUTCOME_NOT_FOUND" });
        await expect(
          dispatch({
            client: owner,
            context: harness.context,
            method: "outcomes.get",
            request: { id: outcomeId },
            revoked: true,
          }),
        ).rejects.toThrow("authenticated request authority expired");
        expect(harness.outcomeWrites).toEqual(writesBefore);
        expect(harness.getWorkboardListRequests()).toBe(listRequestsBefore);
      },
    );
  });

  it("keeps get read-only and persists an unavailable refresh after the real Workboard registration disappears", async () => {
    await withOpenClawTestState(
      { label: "outcome-public-workboard-disabled", scenario: "minimal" },
      async (state) => {
        const harness = createHarness(state);
        const owner = createOperatorClient("manager-a", ["operator.read", "operator.write"]);
        const card = (await dispatch({
          client: owner,
          context: harness.context,
          method: "workboard.cards.create",
          request: { title: "Disable after link", priority: "normal" },
        })) as { card: { id: string } };
        await dispatch({
          client: owner,
          context: harness.context,
          method: "outcomes.create",
          request: {
            id: outcomeId,
            title: "Disabled owner",
            objective: "Retain only unavailable state",
            criteria: [{ id: criterionId, text: "Owner source", required: true }],
          },
        });
        await dispatch({
          client: owner,
          context: harness.context,
          method: "outcomes.linkWorkboard",
          request: { id: outcomeId, expectedRevision: 1, criterionId, cardId: card.card.id },
        });
        harness.setWorkboardAvailable(false);
        const writesBeforeGet = { ...harness.outcomeWrites };
        await expect(
          dispatch({
            client: owner,
            context: harness.context,
            method: "outcomes.get",
            request: { id: outcomeId },
          }),
        ).resolves.toMatchObject({ outcome: { sourceIssues: [{ reason: "workboard-disabled" }] } });
        expect(harness.outcomeWrites).toEqual(writesBeforeGet);
        await expect(
          dispatch({
            client: owner,
            context: harness.context,
            method: "outcomes.refresh",
            request: { id: outcomeId, expectedRevision: 2 },
          }),
        ).resolves.toMatchObject({
          refresh: { status: "unavailable", reason: "workboard-disabled" },
        });
        expect(harness.outcomeWrites.update).toBe(writesBeforeGet.update + 1);
        await expect(harness.outcomeStore.lookup(outcomeId)).resolves.toMatchObject({
          revision: 3,
          projections: [
            {
              availability: "unavailable",
              errorCode: "workboard-disabled",
              ref: { cardId: card.card.id },
            },
          ],
        });
      },
    );
  });
});
