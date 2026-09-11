import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
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

function createHarness(
  options: { registerError?: unknown; workboardCards?: unknown[]; workboardError?: unknown } = {},
) {
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
    update: async (
      id: string,
      decide: (current: OutcomeRecord | undefined) => OutcomeRecord | undefined,
    ) => {
      const next = decide(records.get(id));
      if (!next) return false;
      records.set(id, next);
      writes += 1;
      return true;
    },
    deleteIf: async () => false,
  };
  const gatewayRequest = vi.fn(async () => {
    if (options.workboardError !== undefined) throw options.workboardError;
    return {
      cards: options.workboardCards ?? [
        {
          id: "card-a",
          status: "done",
          createdAt: 1,
          updatedAt: 2,
          metadata: { automation: { boardId: "board-a" }, proof: [], artifacts: [] },
        },
      ],
    };
  });
  const api = {
    runtime: { state: { openKeyedStore: () => store }, gateway: { request: gatewayRequest } },
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
  return { call, gatewayRequest, records, writes: () => writes };
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
    expect(await harness.call("outcomes.create", params)).toMatchObject([
      true,
      { replayed: false },
    ]);
    expect(await harness.call("outcomes.create", params)).toMatchObject([true, { replayed: true }]);
    expect(harness.writes()).toBe(1);
    expect(
      await harness.call(
        "outcomes.get",
        { id: params.id },
        {
          authenticatedUserProfile: { profileId: "manager-b" },
        },
      ),
    ).toMatchObject([false, undefined, { code: "OUTCOME_NOT_FOUND" }]);
  });

  it("keeps the original create receipt after a later revision", async () => {
    const harness = createHarness();
    const params = createParams(outcomeIds[0]!);
    await harness.call("outcomes.create", params);
    await harness.call("outcomes.update", {
      id: params.id,
      expectedRevision: 1,
      patch: { title: "Revised" },
    });
    expect(await harness.call("outcomes.create", params)).toMatchObject([
      true,
      { replayed: true, outcome: { revision: 2 }, receipt: { committedRevision: 1 } },
    ]);
    expect(harness.writes()).toBe(2);
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

  it("counts public text limits by Unicode code point rather than UTF-16 code unit", async () => {
    const harness = createHarness();
    const validTitle = "🙂".repeat(160);
    expect(
      await harness.call("outcomes.create", createParams(outcomeIds[0]!, validTitle)),
    ).toMatchObject([true, { outcome: { title: validTitle } }]);
    expect(
      await harness.call("outcomes.create", createParams(outcomeIds[1]!, "🙂".repeat(161))),
    ).toMatchObject([false, undefined, { code: "OUTCOME_INVALID_REQUEST" }]);
    expect(harness.writes()).toBe(1);
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
    expect(patched).toMatchObject([
      true,
      { outcome: { title: "Renamed", revision: 2, contractRevision: 2 } },
    ]);
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

  it("links and unlinks only the authorized owner card identity with one Workboard read", async () => {
    const harness = createHarness();
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    expect(
      await harness.call("outcomes.linkWorkboard", {
        id,
        expectedRevision: 1,
        criterionId,
        cardId: "card-a",
      }),
    ).toMatchObject([true, { outcome: { revision: 2, contractRevision: 2 } }]);
    expect(harness.records.get(id)?.criteria[0]?.workRefs).toEqual([
      { owner: "workboard", cardId: "card-a", cardCreatedAt: 1, boardIdAtLink: "board-a" },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "workboard.cards.list",
      {},
      { scopes: ["operator.read"], requireAuthenticatedRequest: true, timeoutMs: 10_000 },
    );
    expect(
      await harness.call("outcomes.unlinkWorkboard", {
        id,
        expectedRevision: 2,
        criterionId,
        cardId: "card-a",
      }),
    ).toMatchObject([true, { outcome: { revision: 3, contractRevision: 3 } }]);
  });

  it("refreshes all linked Workboard source material with one authorized owner read", async () => {
    const harness = createHarness({
      workboardCards: [
        {
          id: "card-a",
          status: "done",
          createdAt: 1,
          updatedAt: 8,
          metadata: {
            automation: { boardId: "board-b" },
            proof: [{ id: "proof-a", status: "passed", createdAt: 3, label: "Hosted proof" }],
            artifacts: [{ id: "artifact-a", createdAt: 4, label: "Hosted artifact" }],
          },
        },
      ],
    });
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    await harness.call("outcomes.linkWorkboard", {
      id,
      expectedRevision: 1,
      criterionId,
      cardId: "card-a",
    });
    harness.gatewayRequest.mockClear();
    expect(await harness.call("outcomes.refresh", { id, expectedRevision: 2 })).toMatchObject([
      true,
      {
        outcome: {
          revision: 3,
          criteria: [{ sourcesVisibility: "complete", workRefs: [{ cardId: "card-a" }] }],
          work: [{ ref: { cardId: "card-a" }, currentBoardId: "board-b", status: "done" }],
          evidence: [
            { sourceId: "proof-a", label: "Hosted proof", proofStatus: "passed" },
            { sourceId: "artifact-a", label: "Hosted artifact" },
          ],
        },
        refresh: { status: "available" },
      },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledOnce();
    expect(harness.records.get(id)).toMatchObject({
      revision: 3,
      projections: [
        {
          availability: "available",
          currentBoardId: "board-b",
          status: "done",
          sourceUpdatedAt: 8,
          sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ],
      evidence: [
        expect.objectContaining({ criterionId, sourceId: "proof-a", kind: "workboard-proof" }),
        expect.objectContaining({
          criterionId,
          sourceId: "artifact-a",
          kind: "workboard-artifact",
        }),
      ],
    });
  });

  it("reads current authorized source material once without persisting a get", async () => {
    const harness = createHarness({
      workboardCards: [
        {
          id: "card-a",
          status: "done",
          createdAt: 1,
          updatedAt: 8,
          metadata: {
            automation: { boardId: "board-b" },
            proof: [{ id: "proof-a", status: "passed", createdAt: 3, label: "Hosted proof" }],
            artifacts: [],
          },
        },
      ],
    });
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    await harness.call("outcomes.linkWorkboard", {
      id,
      expectedRevision: 1,
      criterionId,
      cardId: "card-a",
    });
    const writes = harness.writes();
    harness.gatewayRequest.mockClear();
    expect(await harness.call("outcomes.get", { id })).toMatchObject([
      true,
      {
        outcome: {
          criteria: [{ sourcesVisibility: "complete", workRefs: [{ cardId: "card-a" }] }],
          work: [{ ref: { cardId: "card-a" }, currentBoardId: "board-b", status: "done" }],
          evidence: [{ sourceId: "proof-a", label: "Hosted proof", proofStatus: "passed" }],
        },
      },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledOnce();
    expect(harness.writes()).toBe(writes);
  });

  it("only returns HTTP(S) source links and never returns private source fields", async () => {
    const cards = [
      {
        id: "card-a",
        status: "done",
        createdAt: 1,
        updatedAt: 8,
        metadata: {
          automation: { boardId: "board-b" },
          proof: [
            {
              id: "proof-a",
              status: "passed",
              createdAt: 3,
              label: "Hosted proof",
              url: "javascript:alert(1)",
              command: "cat /private/proof",
              note: "private note",
            },
          ],
          artifacts: [
            {
              id: "artifact-a",
              createdAt: 4,
              label: "Hosted artifact",
              url: "https://example.test/artifact",
              path: "/private/artifact",
            },
          ],
        },
      },
    ];
    const harness = createHarness({ workboardCards: cards });
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    await harness.call("outcomes.linkWorkboard", {
      id,
      expectedRevision: 1,
      criterionId,
      cardId: "card-a",
    });
    const response = await harness.call("outcomes.get", { id });
    expect(response).toMatchObject([
      true,
      {
        outcome: {
          evidence: expect.arrayContaining([
            expect.objectContaining({ sourceId: "proof-a", label: "Hosted proof" }),
            expect.objectContaining({
              sourceId: "artifact-a",
              url: "https://example.test/artifact",
            }),
          ]),
        },
      },
    ]);
    const evidence = (response[1] as { outcome: { evidence: Array<Record<string, unknown>> } })
      .outcome.evidence;
    const proof = evidence.find((item) => item.sourceId === "proof-a")!;
    expect(proof).not.toHaveProperty("url");
    expect(proof).not.toHaveProperty("command");
    expect(proof).not.toHaveProperty("note");
    expect(evidence.find((item) => item.sourceId === "artifact-a")).not.toHaveProperty("path");

    cards[0]!.metadata.proof[0]!.url = "data:text/plain,changed";
    const changedResponse = await harness.call("outcomes.get", { id });
    const changedEvidence = (
      changedResponse[1] as { outcome: { evidence: Array<Record<string, unknown>> } }
    ).outcome.evidence;
    const changedProof = changedEvidence.find((item) => item.sourceId === "proof-a")!;
    expect(changedProof).not.toHaveProperty("url");
    expect(changedProof.sourceDigest).not.toBe(proof.sourceDigest);
  });

  it("treats changed authorized source content as current evidence without rewriting on get", async () => {
    const cards = [
      {
        id: "card-a",
        status: "done",
        createdAt: 1,
        updatedAt: 8,
        metadata: {
          automation: { boardId: "board-b" },
          proof: [{ id: "proof-a", status: "passed", createdAt: 3, label: "Initial proof" }],
          artifacts: [],
        },
      },
    ];
    const harness = createHarness({ workboardCards: cards });
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    await harness.call("outcomes.linkWorkboard", {
      id,
      expectedRevision: 1,
      criterionId,
      cardId: "card-a",
    });
    await harness.call("outcomes.refresh", { id, expectedRevision: 2 });
    const persistedDigest = harness.records.get(id)!.evidence[0]!.sourceDigest;
    cards[0] = {
      ...cards[0]!,
      updatedAt: 9,
      metadata: {
        ...cards[0]!.metadata,
        proof: [{ id: "proof-a", status: "passed", createdAt: 3, label: "Replacement proof" }],
      },
    };
    const writes = harness.writes();
    harness.gatewayRequest.mockClear();
    const response = await harness.call("outcomes.get", { id });
    expect(response).toMatchObject([true, { outcome: { evidence: [{ sourceId: "proof-a" }] } }]);
    const outcome = (
      response[1] as {
        outcome: {
          criteria: Array<{ evidenceSetHash: string | null }>;
          evidence: Array<{ sourceDigest: string }>;
        };
      }
    ).outcome;
    expect(outcome.evidence[0]!.sourceDigest).not.toBe(persistedDigest);
    expect(outcome.criteria[0]!.evidenceSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.gatewayRequest).toHaveBeenCalledOnce();
    expect(harness.writes()).toBe(writes);
    expect(harness.records.get(id)!.evidence).toHaveLength(1);
    expect(harness.records.get(id)!.evidence[0]!.sourceDigest).toBe(persistedDigest);

    await harness.call("outcomes.refresh", { id, expectedRevision: 3 });
    expect(harness.records.get(id)!.evidence.map((evidence) => evidence.sourceDigest)).toEqual(
      expect.arrayContaining([persistedDigest, outcome.evidence[0]!.sourceDigest]),
    );
  });

  it("keeps Outcome content but never leaks cached source material after an owner-read failure", async () => {
    const harness = createHarness({
      workboardError: { code: "GATEWAY_TIMEOUT", message: "/private/path" },
    });
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
      projections: [
        {
          ref,
          availability: "available",
          observedAt: 1,
          proofs: [{ sourceId: "proof-a", digest: "a".repeat(64) }],
          artifacts: [],
          currentBoardId: "board-a",
          status: "done",
          sourceUpdatedAt: 1,
          lastSuccessfulAt: 1,
          sourceFingerprint: "b".repeat(64),
        },
      ],
    });
    const writes = harness.writes();
    expect(await harness.call("outcomes.get", { id })).toMatchObject([
      true,
      {
        outcome: {
          objective: "Outcome objective",
          readiness: "unavailable",
          criteria: [{ sourcesVisibility: "restricted", workRefs: [] }],
          work: [],
          evidence: [],
          sourceIssues: [{ criterionId, reason: "timeout" }],
        },
      },
    ]);
    expect(harness.writes()).toBe(writes);
  });

  it("records a failed refresh as unavailable while retaining its display cache", async () => {
    const harness = createHarness({
      workboardError: { code: "GATEWAY_TIMEOUT", message: "/private/path" },
    });
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
      projections: [
        {
          ref,
          availability: "available",
          observedAt: 1,
          proofs: [{ sourceId: "proof-a", digest: "a".repeat(64) }],
          artifacts: [],
          currentBoardId: "board-a",
          status: "done",
          sourceUpdatedAt: 1,
          lastSuccessfulAt: 1,
          sourceFingerprint: "b".repeat(64),
        },
      ],
    });
    expect(await harness.call("outcomes.refresh", { id, expectedRevision: 1 })).toMatchObject([
      true,
      { outcome: { revision: 2 }, refresh: { status: "unavailable", reason: "timeout" } },
    ]);
    expect(harness.records.get(id)?.projections[0]).toMatchObject({
      availability: "unavailable",
      errorCode: "timeout",
      currentBoardId: "board-a",
      proofs: [{ sourceId: "proof-a", digest: "a".repeat(64) }],
    });
    expect(harness.records.get(id)?.projections[0]?.sourceFingerprint).toBeUndefined();
  });

  it("persists a card-identity collision as a non-leaking refresh result", async () => {
    const card = {
      id: "card-a",
      status: "done",
      createdAt: 1,
      updatedAt: 2,
      metadata: { automation: { boardId: "board-a" }, proof: [], artifacts: [] },
    };
    const harness = createHarness({ workboardCards: [card, { ...card, createdAt: 2 }] });
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
    expect(await harness.call("outcomes.refresh", { id, expectedRevision: 1 })).toMatchObject([
      true,
      {
        outcome: { revision: 2 },
        refresh: { status: "identity-conflict", reason: "identity-conflict" },
      },
    ]);
    expect(harness.records.get(id)?.projections).toMatchObject([
      { availability: "identity-conflict", errorCode: "identity-conflict" },
    ]);
  });

  it("rejects terminal and stale refresh requests without owner reads or writes", async () => {
    const harness = createHarness();
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    const created = harness.records.get(id)!;
    harness.gatewayRequest.mockClear();
    const writes = harness.writes();
    expect(await harness.call("outcomes.refresh", { id, expectedRevision: 2 })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_REVISION_CONFLICT" },
    ]);
    harness.records.set(id, { ...created, phase: "cancelled" });
    expect(await harness.call("outcomes.refresh", { id, expectedRevision: 1 })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_INVALID_STATE" },
    ]);
    expect(harness.gatewayRequest).not.toHaveBeenCalled();
    expect(harness.writes()).toBe(writes);
  });

  it("returns available for an unlinked draft without consulting Workboard", async () => {
    const harness = createHarness();
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    expect(await harness.call("outcomes.refresh", { id, expectedRevision: 1 })).toMatchObject([
      true,
      { outcome: { revision: 2 }, refresh: { status: "available" } },
    ]);
    expect(harness.gatewayRequest).not.toHaveBeenCalled();
  });

  it("does not consult Workboard or write before owner membership is established", async () => {
    const harness = createHarness();
    const response = await harness.call("outcomes.linkWorkboard", {
      id: outcomeIds[0],
      expectedRevision: 1,
      criterionId,
      cardId: "card-a",
    });
    expect(response).toMatchObject([false, undefined, { code: "OUTCOME_NOT_FOUND" }]);
    expect(harness.gatewayRequest).not.toHaveBeenCalled();
    expect(harness.writes()).toBe(0);
  });

  it("rejects an oversized opaque card ID before the owner read", async () => {
    const harness = createHarness();
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    harness.gatewayRequest.mockClear();
    const writes = harness.writes();
    expect(
      await harness.call("outcomes.linkWorkboard", {
        id,
        expectedRevision: 1,
        criterionId,
        cardId: "x".repeat(64 * 1024),
      }),
    ).toMatchObject([false, undefined, { code: "OUTCOME_INVALID_REQUEST" }]);
    expect(harness.gatewayRequest).not.toHaveBeenCalled();
    expect(harness.writes()).toBe(writes);
  });

  it("rejects stale and cancelled link mutations before reading Workboard", async () => {
    const harness = createHarness();
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    const created = harness.records.get(id)!;
    harness.gatewayRequest.mockClear();
    const writes = harness.writes();
    const stale = {
      id,
      expectedRevision: 2,
      criterionId,
      cardId: "card-a",
    };
    expect(await harness.call("outcomes.linkWorkboard", stale)).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_REVISION_CONFLICT" },
    ]);
    expect(await harness.call("outcomes.unlinkWorkboard", stale)).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_REVISION_CONFLICT" },
    ]);
    harness.records.set(id, { ...created, phase: "cancelled" });
    const cancelled = { ...stale, expectedRevision: 1 };
    expect(await harness.call("outcomes.linkWorkboard", cancelled)).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_INVALID_STATE" },
    ]);
    expect(await harness.call("outcomes.unlinkWorkboard", cancelled)).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_INVALID_STATE" },
    ]);
    expect(harness.gatewayRequest).not.toHaveBeenCalled();
    expect(harness.writes()).toBe(writes);
  });

  it("rejects a duplicate owner card ID with different creation identities without writing", async () => {
    const card = {
      id: "card-a",
      status: "done",
      createdAt: 1,
      updatedAt: 2,
      metadata: { automation: { boardId: "board-a" }, proof: [], artifacts: [] },
    };
    const harness = createHarness({ workboardCards: [card, { ...card, createdAt: 2 }] });
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    const writes = harness.writes();
    for (const cards of [
      [card, { ...card, createdAt: 2 }],
      [{ ...card, createdAt: 2 }, card],
    ]) {
      harness.gatewayRequest.mockResolvedValueOnce({ cards });
      expect(
        await harness.call("outcomes.linkWorkboard", {
          id,
          expectedRevision: 1,
          criterionId,
          cardId: "card-a",
        }),
      ).toMatchObject([false, undefined, { code: "OUTCOME_IDENTITY_CONFLICT" }]);
    }
    expect(harness.writes()).toBe(writes);
    expect(harness.gatewayRequest).toHaveBeenCalledTimes(2);
  });

  it("maps missing and failed owner reads without leaking owner errors", async () => {
    const id = outcomeIds[0]!;
    const unavailable = createHarness({ workboardCards: [] });
    await unavailable.call("outcomes.create", createParams(id));
    expect(
      await unavailable.call("outcomes.linkWorkboard", {
        id,
        expectedRevision: 1,
        criterionId,
        cardId: "card-a",
      }),
    ).toMatchObject([false, undefined, { code: "OUTCOME_OWNER_UNAVAILABLE" }]);

    const timeout = createHarness({
      workboardError: { code: "GATEWAY_TIMEOUT", message: "/private/path" },
    });
    await timeout.call("outcomes.create", createParams(id));
    expect(
      await timeout.call("outcomes.linkWorkboard", {
        id,
        expectedRevision: 1,
        criterionId,
        cardId: "card-a",
      }),
    ).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_OWNER_TIMEOUT", message: "Outcome request could not be completed" },
    ]);
  });

  it("activates only a linked draft and freezes its first generation hash", async () => {
    const harness = createHarness();
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", createParams(id));
    await harness.call("outcomes.linkWorkboard", {
      id,
      expectedRevision: 1,
      criterionId,
      cardId: "card-a",
    });
    expect(await harness.call("outcomes.activate", { id, expectedRevision: 2 })).toMatchObject([
      true,
      {
        outcome: { phase: "active", revision: 3, planGeneration: 1, planHash: expect.any(String) },
      },
    ]);
    const writes = harness.writes();
    expect(await harness.call("outcomes.activate", { id, expectedRevision: 3 })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_INVALID_STATE" },
    ]);
    expect(harness.writes()).toBe(writes);
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
    const second = await harness.call("outcomes.list", {
      limit: 2,
      cursor: firstPayload.nextCursor,
    });
    const secondPayload = second?.[1] as { outcomes: Array<{ id: string }> };
    expect(secondPayload.outcomes).toHaveLength(1);
    expect(
      new Set([...firstPayload.outcomes, ...secondPayload.outcomes].map((outcome) => outcome.id)),
    ).toHaveSize(3);
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
