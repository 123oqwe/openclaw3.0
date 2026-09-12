import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";
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
import { summarizeBenchmarkTimings } from "../../scripts/lib/benchmark-harness.mts";
import { loadBundledPluginPublicSurfaceModule } from "../plugin-sdk/facade-runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";

const outcomeId = "123e4567-e89b-42d3-a456-426614174000";
const OUTCOME_BENCHMARK_SAMPLES = 20;
const OUTCOME_BENCHMARK_SCENARIOS = [
  { recordCount: 50, recordBytes: 4 * 1024 },
  { recordCount: 50, recordBytes: 96 * 1024 },
  { recordCount: 50, recordBytes: 128 * 1024 },
  { recordCount: 500, recordBytes: 4 * 1024 },
  { recordCount: 500, recordBytes: 96 * 1024 },
  { recordCount: 500, recordBytes: 128 * 1024 },
] as const;
const BENCHMARK_OWNER_ID = "manager-a";
const BENCHMARK_OWNER_CARD = {
  owner: "workboard",
  cardId: "card-proof-artifact",
  cardCreatedAt: 1_700_000_000_000,
  boardIdAtLink: "release-board",
} as const;

type BenchmarkCriterion = {
  id: string;
  text: string;
  required: boolean;
  workRefs: Array<typeof BENCHMARK_OWNER_CARD>;
};

type BenchmarkPlan = {
  outcomeId: string;
  objective: string;
  contractRevision: number;
  planGeneration: number;
  criteria: BenchmarkCriterion[];
};

type BenchmarkOutcomeRecord = {
  schemaVersion: 1;
  id: string;
  createRequestHash: string;
  managerProfileId: string;
  title: string;
  objective: string;
  phase: "active";
  revision: number;
  contractRevision: number;
  planGeneration: number;
  planHash: string;
  criteria: BenchmarkCriterion[];
  projections: [];
  evidence: [];
  decisions: Array<{
    id: string;
    criterionId: string;
    planGeneration: number;
    decidedRevision: number;
    status: "verified";
    requestHash: string;
    profileId: string;
    planHash: string;
    decidedPlan: BenchmarkPlan;
    evidenceSetHash: string;
    note?: string;
    decidedAt: number;
  }>;
  operations: [];
  acceptances: [];
  createdAt: number;
  updatedAt: number;
};

function outcomeRecordBytes(record: unknown): number {
  return Buffer.byteLength(stableStringify(record), "utf8");
}

function benchmarkPlanHash(plan: BenchmarkPlan): string {
  return createHash("sha256")
    .update(
      `openclaw:outcome-plan:v1\0${stableStringify({
        outcomeId: plan.outcomeId,
        objective: plan.objective,
        contractRevision: plan.contractRevision,
        planGeneration: plan.planGeneration,
        criteria: [...plan.criteria]
          .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
          .map((criterion) => ({
            id: criterion.id,
            text: criterion.text,
            required: criterion.required,
            workRefs: [...criterion.workRefs].toSorted((left, right) => {
              if (left.cardId !== right.cardId) {
                return left.cardId < right.cardId ? -1 : 1;
              }
              if (left.cardCreatedAt !== right.cardCreatedAt) {
                return left.cardCreatedAt - right.cardCreatedAt;
              }
              return left.boardIdAtLink < right.boardIdAtLink
                ? -1
                : left.boardIdAtLink > right.boardIdAtLink
                  ? 1
                  : 0;
            }),
          })),
      })}`,
      "utf8",
    )
    .digest("hex");
}

function activeBenchmarkRecord(
  id: string,
  targetBytes: number,
  workRefs: BenchmarkCriterion["workRefs"] = [],
): BenchmarkOutcomeRecord {
  const criteria: BenchmarkCriterion[] = [
    { id: randomUUID(), text: "Benchmark criterion", required: true, workRefs },
  ];
  const plan: BenchmarkPlan = {
    outcomeId: id,
    objective: "Benchmark registered Outcome Gateway handlers",
    contractRevision: 1,
    planGeneration: 1,
    criteria,
  };
  const planHash = benchmarkPlanHash(plan);
  const record: BenchmarkOutcomeRecord = {
    schemaVersion: 1,
    id,
    createRequestHash: createHash("sha256").update(id, "utf8").digest("hex"),
    managerProfileId: BENCHMARK_OWNER_ID,
    title: "same",
    objective: plan.objective,
    phase: "active",
    revision: 100,
    contractRevision: 1,
    planGeneration: 1,
    planHash,
    criteria,
    projections: [],
    evidence: [],
    decisions: [],
    operations: [],
    acceptances: [],
    createdAt: 100,
    updatedAt: 100,
  };
  for (let index = 1; index <= 100 && outcomeRecordBytes(record) < targetBytes; index += 1) {
    const decision = {
      id: randomUUID(),
      criterionId: criteria[0]!.id,
      planGeneration: 1,
      decidedRevision: index,
      status: "verified" as const,
      requestHash: createHash("sha256").update(`${id}:${index}`, "utf8").digest("hex"),
      profileId: BENCHMARK_OWNER_ID,
      planHash,
      decidedPlan: plan,
      evidenceSetHash: "b".repeat(64),
      note: "",
      decidedAt: index,
    };
    record.decisions.push(decision);
    const bytesBeforeNote = outcomeRecordBytes(record);
    if (bytesBeforeNote > targetBytes) {
      record.decisions.pop();
      break;
    }
    decision.note = "x".repeat(Math.min(2_000, targetBytes - bytesBeforeNote));
  }
  if (outcomeRecordBytes(record) < targetBytes * 0.9 || outcomeRecordBytes(record) > targetBytes) {
    throw new Error(`unable to construct ${targetBytes}-byte Outcome benchmark record`);
  }
  return record;
}

function writeOutcomeGatewayBenchmarkArtifact(report: object): void {
  const artifactPath = process.env.OPENCLAW_OUTCOME_BENCHMARK_ARTIFACT_PATH;
  if (!artifactPath) {
    return;
  }
  const parsed = path.parse(artifactPath);
  const destination = path.join(parsed.dir, `${parsed.name}-gateway-rpc${parsed.ext || ".json"}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

afterEach(() => resetPluginStateStoreForTests());

type OutcomeRuntimeApi = {
  registerOutcomeGatewayMethods(api: ReturnType<typeof createTestPluginApi>): void;
};

let outcomeRuntimeApi: OutcomeRuntimeApi | undefined;

beforeAll(async () => {
  outcomeRuntimeApi = await loadBundledPluginPublicSurfaceModule<OutcomeRuntimeApi>({
    dirName: "outcomes",
    artifactBasename: "runtime-api.js",
  });
});

function registerOutcomeGatewayMethods(api: ReturnType<typeof createTestPluginApi>): void {
  if (!outcomeRuntimeApi) {
    throw new Error("Outcome public runtime surface was not loaded before the harness");
  }
  outcomeRuntimeApi.registerOutcomeGatewayMethods(api);
}

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

function registerHarness(
  options: { gatewayRequest?: (method: string, params: unknown) => unknown; store?: unknown } = {},
) {
  const records = new Map<string, unknown>();
  const storeMutationCalls = { deletes: 0, registers: 0, updates: 0 };
  const registrations: Array<{
    method: string;
    handler: never;
    options: { scope: "operator.read" | "operator.write" };
  }> = [];
  const store = options.store ?? {
    registerIfAbsent: async (key: string, value: unknown) => {
      storeMutationCalls.registers += 1;
      if (records.has(key)) return false;
      records.set(key, value);
      return true;
    },
    lookup: async (key: string) => records.get(key),
    entries: async () => Array.from(records, ([key, value]) => ({ key, value })),
    update: async (key: string, decide: (current: unknown) => unknown) => {
      storeMutationCalls.updates += 1;
      const next = decide(records.get(key));
      if (next === undefined) return false;
      records.set(key, next);
      return true;
    },
    deleteIf: async (key: string, predicate: (current: unknown) => boolean) => {
      storeMutationCalls.deletes += 1;
      const current = records.get(key);
      if (current === undefined || !predicate(current)) return false;
      records.delete(key);
      return true;
    },
  };
  const api = createTestPluginApi({
    id: "outcomes",
    name: "Outcomes",
    runtime: {
      state: { openKeyedStore: () => store },
      gateway: {
        isAvailable: async () => false,
        request: options.gatewayRequest ?? (async () => ({})),
      },
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
  const registry = createGatewayMethodRegistry(
    registrations.map((registration) => ({
      name: registration.method,
      handler: registration.handler,
      scope: registration.options.scope,
      owner: { kind: "plugin" as const, pluginId: "outcomes" },
    })),
  );
  context.getGatewayMethodRegistry = () => registry;
  return { context, records, registrations, storeMutationCalls };
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

async function dispatchWithoutAuthenticatedRequest(params: {
  context: GatewayRequestContext;
  method: string;
  request: Record<string, unknown>;
}) {
  return await withPluginRuntimeGatewayRequestScope(
    {
      context: params.context,
      isWebchatConnect: () => false,
    },
    async () =>
      await dispatchGatewayMethodInProcess(params.method, params.request, {
        forceSyntheticClient: true,
        requireAuthenticatedRequest: true,
        requireScopedClient: true,
        syntheticScopes: ["operator.read", "operator.write"],
      }),
  );
}

describe("P-02 Outcome Gateway admission", () => {
  it("registers each P-02 scope and rejects insufficient authority before every handler", async () => {
    const { context, records, registrations } = registerHarness();
    const expectedMethods = [
      ["outcomes.create", "operator.write"],
      ["outcomes.get", "operator.read"],
      ["outcomes.list", "operator.read"],
      ["outcomes.update", "operator.write"],
      ["outcomes.linkWorkboard", "operator.write"],
      ["outcomes.unlinkWorkboard", "operator.write"],
      ["outcomes.activate", "operator.write"],
      ["outcomes.refresh", "operator.write"],
      ["outcomes.cancel", "operator.write"],
    ] as const;
    expect(
      registrations
        .filter(({ method }) => method !== "outcomes.health")
        .map(({ method, options }) => [method, options.scope]),
    ).toEqual(expectedMethods);

    for (const [method, scope] of expectedMethods) {
      const registration = registrations.find((candidate) => candidate.method === method);
      expect(registration).toBeDefined();
      const handler = vi.fn(registration!.handler);
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: method,
            handler: handler as never,
            scope,
            owner: { kind: "plugin", pluginId: "outcomes" },
          },
        ]);
      const insufficientScopes = scope === "operator.read" ? [] : ["operator.read"];
      await expect(
        dispatch({
          client: createOperatorClient("manager-a", insufficientScopes),
          context,
          method,
          request: {},
        }),
      ).rejects.toThrow(/scope/i);
      expect(handler).not.toHaveBeenCalled();
    }
    expect(records).toEqual(new Map());
  });

  it("refuses a missing authenticated request authority before the Outcome handler", async () => {
    const { context, records, registrations } = registerHarness();
    const registration = registrations.find(({ method }) => method === "outcomes.get");
    expect(registration).toBeDefined();
    const handler = vi.fn(registration!.handler);
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
      dispatchWithoutAuthenticatedRequest({
        context,
        method: "outcomes.get",
        request: { id: outcomeId },
      }),
    ).rejects.toThrow(/authenticated plugin request scope/i);
    expect(handler).not.toHaveBeenCalled();
    expect(records).toEqual(new Map());
  });

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

  it("hides a foreign Outcome from real dispatcher reads without writing", async () => {
    const { context, records, storeMutationCalls } = registerHarness();
    const owner = createOperatorClient("manager-a", ["operator.write"]);
    const foreignReader = createOperatorClient("manager-b", ["operator.read"]);
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
        client: owner,
        context,
        method: "outcomes.create",
        request,
      }),
    ).resolves.toMatchObject({ outcome: { id: outcomeId }, replayed: false });

    const persistedBeforeForeignReads = structuredClone(Array.from(records.entries()));
    const mutationsBeforeForeignReads = { ...storeMutationCalls };
    await expect(
      dispatch({
        client: foreignReader,
        context,
        method: "outcomes.get",
        request: { id: outcomeId },
      }),
    ).rejects.toMatchObject({ code: "OUTCOME_NOT_FOUND" });
    await expect(
      dispatch({
        client: foreignReader,
        context,
        method: "outcomes.list",
        request: {},
      }),
    ).resolves.toEqual({ outcomes: [] });
    expect(storeMutationCalls).toEqual(mutationsBeforeForeignReads);
    expect(Array.from(records.entries())).toEqual(persistedBeforeForeignReads);
  });

  it("records the six-scenario P-02 dispatcher and host-state cost matrix", async () => {
    const reports: Array<{
      finalActualRecordBytes: number;
      initialActualRecordBytes: number;
      list: ReturnType<typeof summarizeBenchmarkTimings>;
      listSamplesMs: number[];
      mutation: ReturnType<typeof summarizeBenchmarkTimings>;
      mutationSamplesMs: number[];
      recordCount: number;
      reserveBytes: number;
      requestedRecordBytes: number;
      targetsMs: { listP95: number; mutationP95: number };
      withinTargets: { listP95: boolean; mutationP95: boolean };
    }> = [];
    const ownerResponse = {
      cards: [
        {
          id: BENCHMARK_OWNER_CARD.cardId,
          status: "done",
          createdAt: BENCHMARK_OWNER_CARD.cardCreatedAt,
          updatedAt: 1_700_000_000_100,
          metadata: { automation: { boardId: BENCHMARK_OWNER_CARD.boardIdAtLink } },
        },
      ],
    };

    await withOpenClawTestState(
      { label: "outcome-gateway-dispatch-performance", applyEnv: false },
      async (state) => {
        for (const scenario of OUTCOME_BENCHMARK_SCENARIOS) {
          const reserveBytes = 128;
          const store = createPluginStateKeyedStoreForTests<BenchmarkOutcomeRecord>("outcomes", {
            namespace: `outcomes-v1-gateway-performance-${randomUUID()}`,
            maxEntries: scenario.recordCount,
            overflowPolicy: "reject-new",
            env: state.env,
          });
          const records = Array.from({ length: scenario.recordCount }, () =>
            activeBenchmarkRecord(randomUUID(), scenario.recordBytes - reserveBytes),
          );
          const actualRecordBytes = records.map(outcomeRecordBytes);
          expect(new Set(actualRecordBytes).size).toBe(1);
          expect(actualRecordBytes[0]).toBeGreaterThanOrEqual(scenario.recordBytes * 0.9);
          expect(actualRecordBytes[0]).toBeLessThanOrEqual(scenario.recordBytes);
          for (const record of records) {
            await expect(store.registerIfAbsent(record.id, record)).resolves.toBe(true);
          }
          expect(records).toHaveLength(scenario.recordCount);

          const ownerRequest = vi.fn(async (method: string) => {
            if (method !== "workboard.cards.list") {
              throw new Error(`unexpected owner method ${method}`);
            }
            return ownerResponse;
          });
          const { context } = registerHarness({ gatewayRequest: ownerRequest, store });
          const client = createOperatorClient(BENCHMARK_OWNER_ID, ["operator.write"]);
          const target = records[0];
          if (!target) {
            throw new Error("benchmark scenario must seed at least one Outcome record");
          }

          const preflight = await dispatch({
            client,
            context,
            method: "outcomes.list",
            request: { limit: 100 },
          });
          expect(preflight).toMatchObject({ outcomes: expect.any(Array) });
          expect((preflight as { outcomes: unknown[] }).outcomes).toHaveLength(
            Math.min(100, scenario.recordCount),
          );
          expect(ownerRequest).not.toHaveBeenCalled();

          const listSamplesMs: number[] = [];
          const mutationSamplesMs: number[] = [];
          for (let sample = 0; sample < OUTCOME_BENCHMARK_SAMPLES; sample += 1) {
            const listStartedAt = performance.now();
            const list = await dispatch({
              client,
              context,
              method: "outcomes.list",
              request: { limit: 100 },
            });
            listSamplesMs.push(performance.now() - listStartedAt);
            expect(list).toMatchObject({ outcomes: expect.any(Array) });
            expect((list as { outcomes: unknown[] }).outcomes).toHaveLength(
              Math.min(100, scenario.recordCount),
            );

            const mutationStartedAt = performance.now();
            const mutation = await dispatch({
              client,
              context,
              method: "outcomes.update",
              request: {
                id: target.id,
                expectedRevision: 100 + sample,
                patch: { title: sample.toString().padStart(4, "0") },
              },
            });
            mutationSamplesMs.push(performance.now() - mutationStartedAt);
            expect(mutation).toMatchObject({
              outcome: { id: target.id, revision: 101 + sample },
            });
          }
          expect(ownerRequest).not.toHaveBeenCalled();
          const finalRecord = await store.lookup(target.id);
          expect(finalRecord).toMatchObject({ revision: 100 + OUTCOME_BENCHMARK_SAMPLES });
          const finalActualRecordBytes = outcomeRecordBytes(finalRecord);
          expect(finalActualRecordBytes).toBeLessThanOrEqual(scenario.recordBytes);
          const list = summarizeBenchmarkTimings(listSamplesMs);
          const mutation = summarizeBenchmarkTimings(mutationSamplesMs);
          const targetsMs = { listP95: 1_000, mutationP95: 100 };
          reports.push({
            recordCount: scenario.recordCount,
            requestedRecordBytes: scenario.recordBytes,
            reserveBytes,
            initialActualRecordBytes: actualRecordBytes[0] ?? 0,
            finalActualRecordBytes,
            listSamplesMs,
            mutationSamplesMs,
            list,
            mutation,
            targetsMs,
            withinTargets: {
              listP95: (list.p95 ?? Number.POSITIVE_INFINITY) <= targetsMs.listP95,
              mutationP95: (mutation.p95 ?? Number.POSITIVE_INFINITY) <= targetsMs.mutationP95,
            },
          });
        }

        const diagnosticStore = createPluginStateKeyedStoreForTests<BenchmarkOutcomeRecord>(
          "outcomes",
          {
            namespace: `outcomes-v1-gateway-owner-diagnostic-${randomUUID()}`,
            maxEntries: 2,
            overflowPolicy: "reject-new",
            env: state.env,
          },
        );
        const diagnosticRecord = activeBenchmarkRecord(randomUUID(), 4 * 1024, [
          { ...BENCHMARK_OWNER_CARD },
        ]);
        await expect(
          diagnosticStore.registerIfAbsent(diagnosticRecord.id, diagnosticRecord),
        ).resolves.toBe(true);
        let diagnosticRegisterCalls = 0;
        let diagnosticSuccessfulUpdates = 0;
        let diagnosticUpdateCalls = 0;
        let diagnosticDeleteCalls = 0;
        const instrumentedDiagnosticStore = {
          ...diagnosticStore,
          registerIfAbsent: async (
            ...args: Parameters<typeof diagnosticStore.registerIfAbsent>
          ) => {
            diagnosticRegisterCalls += 1;
            return diagnosticStore.registerIfAbsent(...args);
          },
          update: async (...args: Parameters<NonNullable<typeof diagnosticStore.update>>) => {
            diagnosticUpdateCalls += 1;
            const updated = await diagnosticStore.update!(...args);
            if (updated) {
              diagnosticSuccessfulUpdates += 1;
            }
            return updated;
          },
          deleteIf: async (...args: Parameters<NonNullable<typeof diagnosticStore.deleteIf>>) => {
            diagnosticDeleteCalls += 1;
            return diagnosticStore.deleteIf!(...args);
          },
        };
        const ownerRequest = vi.fn(async (method: string) => {
          if (method !== "workboard.cards.list") {
            throw new Error(`unexpected owner method ${method}`);
          }
          return ownerResponse;
        });
        const { context } = registerHarness({
          gatewayRequest: ownerRequest,
          store: instrumentedDiagnosticStore,
        });
        const client = createOperatorClient(BENCHMARK_OWNER_ID, ["operator.write"]);
        const getSamplesMs: number[] = [];
        const refreshSamplesMs: number[] = [];
        for (let sample = 0; sample < OUTCOME_BENCHMARK_SAMPLES; sample += 1) {
          const ownerCallsBeforeGet = ownerRequest.mock.calls.length;
          const mutationsBeforeGet = {
            deletes: diagnosticDeleteCalls,
            registers: diagnosticRegisterCalls,
            successfulUpdates: diagnosticSuccessfulUpdates,
            updates: diagnosticUpdateCalls,
          };
          const getStartedAt = performance.now();
          const get = await dispatch({
            client,
            context,
            method: "outcomes.get",
            request: { id: diagnosticRecord.id },
          });
          getSamplesMs.push(performance.now() - getStartedAt);
          expect(get).toMatchObject({ outcome: { id: diagnosticRecord.id } });
          expect(ownerRequest).toHaveBeenCalledTimes(ownerCallsBeforeGet + 1);
          expect({
            deletes: diagnosticDeleteCalls,
            registers: diagnosticRegisterCalls,
            successfulUpdates: diagnosticSuccessfulUpdates,
            updates: diagnosticUpdateCalls,
          }).toEqual(mutationsBeforeGet);

          const ownerCallsBeforeRefresh = ownerRequest.mock.calls.length;
          const mutationsBeforeRefresh = {
            deletes: diagnosticDeleteCalls,
            registers: diagnosticRegisterCalls,
            successfulUpdates: diagnosticSuccessfulUpdates,
            updates: diagnosticUpdateCalls,
          };
          const refreshStartedAt = performance.now();
          const refresh = await dispatch({
            client,
            context,
            method: "outcomes.refresh",
            request: { id: diagnosticRecord.id, expectedRevision: 100 + sample },
          });
          refreshSamplesMs.push(performance.now() - refreshStartedAt);
          expect(refresh).toMatchObject({
            outcome: { id: diagnosticRecord.id, revision: 101 + sample },
            refresh: { status: "available" },
          });
          expect(ownerRequest).toHaveBeenCalledTimes(ownerCallsBeforeRefresh + 1);
          expect(diagnosticRegisterCalls).toBe(mutationsBeforeRefresh.registers);
          expect(diagnosticDeleteCalls).toBe(mutationsBeforeRefresh.deletes);
          expect(diagnosticUpdateCalls).toBe(mutationsBeforeRefresh.updates + 1);
          expect(diagnosticSuccessfulUpdates).toBe(mutationsBeforeRefresh.successfulUpdates + 1);
          await expect(diagnosticStore.lookup(diagnosticRecord.id)).resolves.toMatchObject({
            revision: 101 + sample,
          });
        }
        expect(ownerRequest).toHaveBeenCalledTimes(OUTCOME_BENCHMARK_SAMPLES * 2);
        writeOutcomeGatewayBenchmarkArtifact({
          schemaVersion: 1,
          benchmark: "outcome-gateway-dispatch",
          job: {
            id: process.env.GITHUB_JOB ?? "local",
            name: process.env.OPENCLAW_OUTCOME_BENCHMARK_JOB_NAME ?? "local",
            runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
            runId: process.env.GITHUB_RUN_ID ?? "local",
            shard: process.env.OPENCLAW_OUTCOME_BENCHMARK_SHARD ?? "local",
          },
          measurementDefinition: {
            dispatcher: "registered public Outcome runtime-api through host in-process dispatcher",
            fixedRegistry: true,
            list: "one public outcomes.list page with limit 100 and no owner request",
            mutation: "one successful public title update with an equal-length title",
            ownerDiagnostics:
              "registered get/refresh with a synthetic frozen workboard.cards.list response; excludes network and remote Workboard execution",
            requestAuthoritySetup: "included in each measured host dispatcher invocation",
            samplesPerOperation: OUTCOME_BENCHMARK_SAMPLES,
            setupAndAssertionsExcludedFromTimings: true,
          },
          ownerDiagnostics: {
            actualRecordBytes: outcomeRecordBytes(
              await diagnosticStore.lookup(diagnosticRecord.id),
            ),
            get: { samplesMs: getSamplesMs, summary: summarizeBenchmarkTimings(getSamplesMs) },
            refresh: {
              samplesMs: refreshSamplesMs,
              summary: summarizeBenchmarkTimings(refreshSamplesMs),
            },
            ownerCalls: ownerRequest.mock.calls.length,
            responseShape: { artifactEntries: 0, cards: 1, linkedRefs: 1, proofEntries: 0 },
            mutationCalls: {
              deletes: diagnosticDeleteCalls,
              registers: diagnosticRegisterCalls,
              successfulUpdates: diagnosticSuccessfulUpdates,
              updates: diagnosticUpdateCalls,
            },
          },
          reports,
          runner: {
            arch: process.arch,
            image: process.env.ImageOS ?? process.env.RUNNER_IMAGE ?? null,
            node: process.version,
            platform: process.platform,
          },
          testedCheckoutSha:
            process.env.OPENCLAW_OUTCOME_BENCHMARK_CHECKOUT_SHA ??
            process.env.GITHUB_SHA ??
            "local",
          workflowSha: process.env.OPENCLAW_OUTCOME_BENCHMARK_WORKFLOW_SHA ?? "local",
        });
      },
    );
  });
});
