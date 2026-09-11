import type { OpenClawPluginApi } from "../../api.js";
import { describe, expect, it, vi } from "vitest";
import type { OutcomeRecord } from "../domain/types.js";
import { registerOutcomeFirstPackageMethods } from "./methods.js";

type GatewayCall = {
  client: { authenticatedUserProfile?: { profileId: string } };
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
};
type RegisteredHandler = (call: GatewayCall) => Promise<void>;

const owner = { authenticatedUserProfile: { profileId: "manager-a" } };
const criterionId = "123e4567-e89b-42d3-a456-426614174001";
const outcomeIds = [
  "123e4567-e89b-42d3-a456-426614174010",
  "123e4567-e89b-42d3-a456-426614174011",
  "123e4567-e89b-42d3-a456-426614174012",
];

function createHarness(options: { registerError?: unknown } = {}) {
  const records = new Map<string, OutcomeRecord>();
  let writes = 0;
  const handlers = new Map<string, RegisteredHandler>();
  const store = {
    registerIfAbsent: async (id: string, record: OutcomeRecord) => {
      if (options.registerError !== undefined) throw options.registerError;
      if (records.has(id)) return false;
      records.set(id, record);
      writes += 1;
      return true;
    },
    lookup: async (id: string) => records.get(id),
    entries: async () => [...records].map(([key, value]) => ({ key, value, createdAt: 0 })),
    update: async (id: string, decide: (current: OutcomeRecord | undefined) => OutcomeRecord | undefined) => {
      const next = decide(records.get(id));
      if (!next) return false;
      records.set(id, next);
      writes += 1;
      return true;
    },
    deleteIf: async () => false,
  };
  const api = {
    runtime: { state: { openKeyedStore: () => store } },
    registerGatewayMethod: (method: string, handler: unknown) => {
      handlers.set(method, handler as RegisteredHandler);
    },
  } as unknown as OpenClawPluginApi;
  registerOutcomeFirstPackageMethods(api);
  async function call(method: string, params: Record<string, unknown>, client = owner) {
    const respond = vi.fn();
    const handler = handlers.get(method);
    if (!handler) throw new Error(`missing handler: ${method}`);
    await handler({ client, params, respond });
    return respond.mock.calls[0];
  }
  return { call, records, writes: () => writes };
}

function createParams(id: string, title = "Outcome title") {
  return {
    id,
    title,
    objective: "Outcome objective",
    criteria: [{ id: criterionId, text: "Required criterion", required: true }],
  };
}

describe("P-02 Outcome handlers", () => {
  it("maps a bounded host capacity failure without exposing its exception", async () => {
    const harness = createHarness({
      registerError: Object.assign(new Error("private store path"), {
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      }),
    });
    expect(await harness.call("outcomes.create", createParams(outcomeIds[0]!))).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_CAPACITY_EXCEEDED", message: "Outcome request could not be completed" },
    ]);
    expect(harness.writes()).toBe(0);
  });

  it("maps an unknown storage failure to the non-leaking internal code", async () => {
    const harness = createHarness({ registerError: new Error("/private/sqlite/outcomes.db") });
    expect(await harness.call("outcomes.create", createParams(outcomeIds[0]!))).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_INTERNAL", message: "Outcome request could not be completed" },
    ]);
    expect(harness.writes()).toBe(0);
  });

  it("replays an identical owner create but makes a foreign record unavailable", async () => {
    const harness = createHarness();
    const params = createParams(outcomeIds[0]!);
    expect(await harness.call("outcomes.create", params)).toMatchObject([true, { replayed: false }]);
    expect(await harness.call("outcomes.create", params)).toMatchObject([true, { replayed: true }]);
    expect(harness.writes()).toBe(1);
    expect(
      await harness.call("outcomes.get", { id: params.id }, {
        authenticatedUserProfile: { profileId: "manager-b" },
      }),
    ).toMatchObject([false, undefined, { code: "OUTCOME_NOT_FOUND" }]);
  });

  it("constructs the only allowed initial draft and rejects client-owned record fields before writing", async () => {
    const harness = createHarness();
    const invalid = {
      ...createParams(outcomeIds[0]!),
      phase: "accepted",
      revision: 99,
      managerProfileId: "forged-manager",
      createdAt: 0,
    };
    expect(await harness.call("outcomes.create", invalid)).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_INVALID_REQUEST" },
    ]);
    expect(harness.writes()).toBe(0);

    await harness.call("outcomes.create", createParams(outcomeIds[0]!));
    expect(harness.records.get(outcomeIds[0]!)).toMatchObject({
      managerProfileId: "manager-a",
      phase: "draft",
      revision: 1,
      contractRevision: 1,
      planGeneration: 0,
      planHash: null,
      projections: [],
      evidence: [],
      decisions: [],
      operations: [],
      acceptances: [],
    });
  });

  it("maps a same-owner different create request to the non-disclosing unavailable code", async () => {
    const harness = createHarness();
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    expect(await harness.call("outcomes.create", createParams(id, "Changed title"))).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_ID_UNAVAILABLE" },
    ]);
    expect(harness.writes()).toBe(1);
  });

  it("rejects malformed DTOs, client timestamps, and duplicate criteria before repository access", async () => {
    const harness = createHarness();
    const params = createParams(outcomeIds[0]!);
    const invalidRequests = [
      { ...params, serverTime: 0 },
      { ...params, id: "not-a-uuid" },
      { ...params, criteria: [...params.criteria, { ...params.criteria[0]! }] },
      { ...params, criteria: [{ ...params.criteria[0]!, required: false }] },
    ];
    for (const request of invalidRequests) {
      expect(await harness.call("outcomes.create", request)).toMatchObject([
        false,
        undefined,
        { code: "OUTCOME_INVALID_REQUEST" },
      ]);
    }
    expect(harness.writes()).toBe(0);
  });

  it("applies a combined patch once and rejects stale or terminal mutations without a write", async () => {
    const harness = createHarness();
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    const patched = await harness.call("outcomes.update", {
      id,
      expectedRevision: 1,
      patch: { title: "Renamed", objective: "Revised objective" },
    });
    expect(patched).toMatchObject([true, { outcome: { title: "Renamed", revision: 2, contractRevision: 2 } }]);
    const writesAfterPatch = harness.writes();
    expect(await harness.call("outcomes.cancel", { id, expectedRevision: 1 })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_REVISION_CONFLICT" },
    ]);
    expect(harness.writes()).toBe(writesAfterPatch);
  });

  it("preserves linked refs for an unchanged criterion identity during a definition patch", async () => {
    const harness = createHarness();
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    const created = harness.records.get(id)!;
    const ref = {
      owner: "workboard" as const,
      cardId: "card-a",
      cardCreatedAt: 1,
      boardIdAtLink: "board-a",
    };
    harness.records.set(id, {
      ...created,
      criteria: [{ ...created.criteria[0]!, workRefs: [ref] }],
    });
    expect(
      await harness.call("outcomes.update", {
        id,
        expectedRevision: 1,
        patch: {
          criteria: [{ id: criterionId, text: "Reworded criterion", required: true }],
        },
      }),
    ).toMatchObject([true, { outcome: { revision: 2 } }]);
    expect(harness.records.get(id)?.criteria[0]?.workRefs).toEqual([ref]);
  });

  it("does not write when cancellation is terminal or an operation is in flight", async () => {
    const harness = createHarness();
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    const created = harness.records.get(id)!;
    harness.records.set(id, { ...created, phase: "cancelled" });
    const writes = harness.writes();
    expect(await harness.call("outcomes.cancel", { id, expectedRevision: 1 })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_INVALID_STATE" },
    ]);
    expect(harness.writes()).toBe(writes);

    harness.records.set(id, {
      ...created,
      operations: [
        {
          id: "123e4567-e89b-42d3-a456-426614174099",
          kind: "workboard-card-start",
          criterionId,
          planGeneration: 0,
          createdRevision: 1,
          requestHash: "a".repeat(64),
          state: "may-have-crossed",
          target: {
            owner: "workboard",
            cardId: "card-a",
            cardCreatedAt: 1,
            boardIdAtLink: "board-a",
          },
        },
      ],
    });
    expect(await harness.call("outcomes.cancel", { id, expectedRevision: 1 })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_INVALID_STATE" },
    ]);
    expect(harness.writes()).toBe(writes);
  });

  it("paginates the authenticated stable list without a write or repeated row", async () => {
    const harness = createHarness();
    for (const id of outcomeIds) await harness.call("outcomes.create", createParams(id, id));
    const writes = harness.writes();
    const first = await harness.call("outcomes.list", { limit: 2 });
    const firstPayload = first?.[1] as { outcomes: Array<{ id: string }>; nextCursor?: string };
    expect(firstPayload.outcomes).toHaveLength(2);
    expect(firstPayload.nextCursor).toEqual(expect.any(String));
    const second = await harness.call("outcomes.list", { limit: 2, cursor: firstPayload.nextCursor });
    const secondPayload = second?.[1] as { outcomes: Array<{ id: string }> };
    expect(secondPayload.outcomes).toHaveLength(1);
    expect(new Set([...firstPayload.outcomes, ...secondPayload.outcomes].map((outcome) => outcome.id))).toHaveSize(3);
    expect(harness.writes()).toBe(writes);
  });

  it("rejects a cursor bound to a different profile without a repository write", async () => {
    const harness = createHarness();
    for (const id of outcomeIds) await harness.call("outcomes.create", createParams(id, id));
    const first = await harness.call("outcomes.list", { limit: 1 });
    const payload = first?.[1] as { nextCursor: string };
    const writes = harness.writes();
    expect(
      await harness.call(
        "outcomes.list",
        { limit: 1, cursor: payload.nextCursor },
        { authenticatedUserProfile: { profileId: "manager-b" } },
      ),
    ).toMatchObject([false, undefined, { code: "OUTCOME_INVALID_CURSOR" }]);
    expect(harness.writes()).toBe(writes);
  });
});
