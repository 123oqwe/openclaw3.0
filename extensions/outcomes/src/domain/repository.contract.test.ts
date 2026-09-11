import { describe, expect, it } from "vitest";
import { createOutcomeRepository } from "../store/plugin-state-repository.js";
import { planHash } from "./canonical-plan.js";
import { createRequestHash } from "./hash.js";
import {
  reduceOutcomeActivate,
  reduceOutcomeCancel,
  reduceOutcomeContract,
  reduceOutcomeLink,
  reduceOutcomeUnlink,
  reduceOutcomePatch,
  reduceOutcomeRefresh,
  reduceOutcomeTitle,
  type OutcomeMutationResult,
} from "./reducer.js";
import { parseOutcomeRecord } from "./schema.js";
import type { OutcomeRecord } from "./types.js";

// P-01 contract cases exercise the repository boundary through the formal
// strict adapter and keep reducer behavior independently observable.
describe("Outcome repository atomic contract", () => {
  function first<T>(items: T[]): T {
    const item = items[0];
    if (item === undefined) {
      throw new Error("fixture item missing");
    }
    return item;
  }
  const validRecord = (id = "o-1"): OutcomeRecord => ({
    schemaVersion: 1,
    id,
    createRequestHash: createRequestHash({
      id,
      title: "title",
      objective: "objective",
      criteria: [{ id: "c-1", text: "criterion", required: true, workRefs: [] }],
    }),
    managerProfileId: "manager-1",
    title: "title",
    objective: "objective",
    phase: "draft",
    revision: 1,
    contractRevision: 1,
    planGeneration: 0,
    planHash: null,
    criteria: [{ id: "c-1", text: "criterion", required: true, workRefs: [] }],
    projections: [],
    evidence: [],
    decisions: [],
    operations: [],
    acceptances: [],
    createdAt: 1,
    updatedAt: 1,
  });
  const activeRecord = (id = "o-1") => {
    const draft = validRecord(id);
    return {
      ...draft,
      phase: "active" as const,
      planGeneration: 1,
      planHash: planHash({
        outcomeId: id,
        objective: draft.objective,
        contractRevision: draft.contractRevision,
        planGeneration: 1,
        criteria: draft.criteria,
      }),
    };
  };

  const linkedActiveRecord = (id = "refresh-1") => {
    const active = activeRecord(id);
    return {
      ...active,
      criteria: [
        {
          ...first(active.criteria),
          workRefs: [
            {
              owner: "workboard" as const,
              cardId: "card-1",
              cardCreatedAt: 1,
              boardIdAtLink: "board-1",
            },
          ],
        },
      ],
    };
  };

  function fixture() {
    const records = new Map<string, OutcomeRecord>();
    let writes = 0;
    const repository = createOutcomeRepository({
      registerIfAbsent: async (id, value) => {
        if (records.has(id)) {
          return false;
        }
        records.set(id, value);
        writes += 1;
        return true;
      },
      lookup: async (id) => records.get(id),
      entries: async () => Array.from(records, ([key, value]) => ({ key, value, createdAt: 0 })),
      update: async (id, decide) => {
        const next = decide(records.get(id));
        if (next === undefined) {
          return false;
        }
        records.set(id, next);
        writes += 1;
        return true;
      },
      deleteIf: async (id, predicate) => {
        const current = records.get(id);
        if (!current || !predicate(current)) {
          return false;
        }
        records.delete(id);
        writes += 1;
        return true;
      },
    });
    return { repository, records, writes: () => writes };
  }

  it("creates once and reads the persisted record", async () => {
    const { repository, writes } = fixture();
    const record = validRecord();
    await expect(repository.create(record)).resolves.toEqual({ created: true });
    await expect(repository.get(record.id)).resolves.toEqual(record);
    expect(writes()).toBe(1);
  });

  it("activates linked drafts and blocks contract changes with in-flight operations", async () => {
    const draft = validRecord("activate-1");
    const linked = {
      ...draft,
      criteria: [
        {
          ...first(draft.criteria),
          workRefs: [
            {
              owner: "workboard" as const,
              cardId: "card-1",
              cardCreatedAt: 1,
              boardIdAtLink: "board-1",
            },
          ],
        },
      ],
    };
    const activated = reduceOutcomeActivate(linked, linked.revision, 42);
    expect(activated.kind).toBe("updated");
    if (activated.kind !== "updated") {
      return;
    }
    expect(activated.record.phase).toBe("active");
    expect(activated.record.planGeneration).toBe(1);
    expect(activated.record.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(activated.record.contractRevision).toBe(linked.contractRevision);
    expect(activated.record.revision).toBe(linked.revision + 1);
    expect(activated.record.updatedAt).toBe(42);
    expect(reduceOutcomeActivate(draft, draft.revision, 42).kind).toBe("rejected");
    expect(reduceOutcomeActivate(linked, linked.revision - 1, 42).kind).toBe("conflict");
    const optionalOnly = {
      ...draft,
      criteria: [
        { ...first(draft.criteria), required: false, workRefs: [] },
        { id: "c-2", text: "optional", required: true, workRefs: first(linked.criteria).workRefs },
      ],
    };
    expect(reduceOutcomeActivate(optionalOnly, optionalOnly.revision, 42).kind).toBe("updated");
    expect(reduceOutcomeActivate(activeRecord("active-1"), 1, 42).kind).toBe("rejected");

    for (const state of ["prepared", "unknown", "may-have-crossed"] as const) {
      const withOperation = {
        ...activeRecord(`active-${state}`),
        criteria: linked.criteria,
        operations: [
          {
            id: state,
            kind: "workboard-card-start" as const,
            criterionId: "c-1",
            planGeneration: 1,
            createdRevision: 1,
            requestHash: "a".repeat(64),
            state,
            target: first(first(linked.criteria).workRefs),
          },
        ],
      };
      expect(
        reduceOutcomeContract(withOperation, {
          expectedRevision: 1,
          serverTime: 42,
          objective: "changed",
          criteria: withOperation.criteria,
        }).kind,
      ).toBe("rejected");
      const titleUpdate = reduceOutcomeTitle(withOperation, {
        expectedRevision: 1,
        title: "new",
        serverTime: 42,
      });
      expect(titleUpdate.kind).toBe("updated");
      if (titleUpdate.kind === "updated") {
        expect(titleUpdate.record.updatedAt).toBe(42);
      }
    }
  });

  it("links an owner-derived card identity with one CAS revision", () => {
    const record = validRecord();
    const result = reduceOutcomeLink(record, {
      expectedRevision: 1,
      criterionId: "c-1",
      ref: { owner: "workboard", cardId: "card-1", cardCreatedAt: 1, boardIdAtLink: "board-1" },
      serverTime: 42,
    });
    expect(result).toMatchObject({ kind: "updated", record: { revision: 2, updatedAt: 42 } });
  });

  it("unlinks a current identity once and leaves an absent identity unchanged", () => {
    const linked = reduceOutcomeLink(validRecord(), {
      expectedRevision: 1,
      criterionId: "c-1",
      ref: { owner: "workboard", cardId: "card-1", cardCreatedAt: 1, boardIdAtLink: "board-1" },
      serverTime: 42,
    }).record;
    const mutation = {
      expectedRevision: 2,
      criterionId: "c-1",
      ref: {
        owner: "workboard" as const,
        cardId: "card-1",
        cardCreatedAt: 1,
        boardIdAtLink: "board-1",
      },
      serverTime: 43,
    };
    expect(reduceOutcomeUnlink(linked, mutation)).toMatchObject({
      kind: "updated",
      record: { revision: 3 },
    });
    expect(
      reduceOutcomeUnlink(
        { ...linked, revision: 2, criteria: [{ ...first(linked.criteria), workRefs: [] }] },
        mutation,
      ).kind,
    ).toBe("noop");
  });

  it("refreshes every linked projection atomically while retaining evidence history", () => {
    const record = linkedActiveRecord();
    const ref = first(first(record.criteria).workRefs);
    const historicalEvidence = {
      id: "old-evidence",
      criterionId: "c-1",
      planGeneration: 1,
      workRef: ref,
      kind: "workboard-proof" as const,
      sourceId: "proof-1",
      sourceDigest: "a".repeat(64),
      observedAt: 1,
    };
    const refreshedEvidence = {
      ...historicalEvidence,
      id: "new-evidence",
      sourceDigest: "b".repeat(64),
      observedAt: 42,
    };
    const result = reduceOutcomeRefresh(
      { ...record, evidence: [historicalEvidence] },
      {
        expectedRevision: record.revision,
        serverTime: 42,
        projections: [
          {
            ref,
            availability: "available",
            observedAt: 42,
            proofs: [{ sourceId: "proof-1", digest: refreshedEvidence.sourceDigest }],
            artifacts: [],
            currentBoardId: "board-2",
            status: "done",
            sourceUpdatedAt: 41,
            lastSuccessfulAt: 42,
            upstreamStale: false,
            sourceFingerprint: "c".repeat(64),
          },
        ],
        evidence: [refreshedEvidence],
      },
    );
    expect(result).toMatchObject({ kind: "updated", record: { revision: 2, updatedAt: 42 } });
    if (result.kind !== "updated") return;
    expect(result.record.evidence).toEqual([refreshedEvidence, historicalEvidence]);
    expect(first(result.record.projections).ref).toEqual(ref);
  });

  it("rejects partial, terminal, stale, and over-capacity refreshes without changing the record", () => {
    const record = linkedActiveRecord();
    const ref = first(first(record.criteria).workRefs);
    const validProjection = {
      ref,
      availability: "unavailable" as const,
      observedAt: 42,
      proofs: [],
      artifacts: [],
      errorCode: "timeout" as const,
    };
    const mutation = {
      expectedRevision: record.revision,
      serverTime: 42,
      projections: [validProjection],
      evidence: [],
    };
    expect(reduceOutcomeRefresh(record, { ...mutation, projections: [] })).toEqual({
      kind: "rejected",
      record,
    });
    expect(
      reduceOutcomeRefresh({ ...record, phase: "cancelled" as const }, mutation),
    ).toMatchObject({ kind: "rejected" });
    expect(reduceOutcomeRefresh({ ...record, revision: 2 }, mutation)).toMatchObject({
      kind: "conflict",
    });
    const evidence = Array.from({ length: 101 }, (_, index) => ({
      id: `evidence-${index}`,
      criterionId: "c-1",
      planGeneration: 1,
      workRef: ref,
      kind: "workboard-proof" as const,
      sourceId: `proof-${index}`,
      sourceDigest: `${index}`.padStart(64, "0"),
      observedAt: 42,
    }));
    expect(reduceOutcomeRefresh(record, { ...mutation, evidence })).toEqual({
      kind: "rejected",
      record,
    });
  });

  it("retains a failed refresh's display cache but makes it unavailable to current closure", () => {
    const record = linkedActiveRecord();
    const ref = first(first(record.criteria).workRefs);
    const cached = {
      ref,
      availability: "available" as const,
      observedAt: 1,
      proofs: [{ sourceId: "proof-1", digest: "a".repeat(64) }],
      artifacts: [],
      currentBoardId: "board-1",
      status: "done",
      sourceUpdatedAt: 1,
      lastSuccessfulAt: 1,
      sourceFingerprint: "b".repeat(64),
    };
    const result = reduceOutcomeRefresh(
      { ...record, projections: [cached] },
      {
        expectedRevision: 1,
        serverTime: 42,
        projections: [
          {
            ref,
            availability: "unavailable",
            observedAt: 42,
            proofs: [],
            artifacts: [],
            errorCode: "timeout",
          },
        ],
        evidence: [],
      },
    );
    expect(result).toMatchObject({
      kind: "updated",
      record: {
        projections: [
          {
            availability: "unavailable",
            observedAt: 42,
            errorCode: "timeout",
            currentBoardId: "board-1",
            status: "done",
            lastSuccessfulAt: 1,
            proofs: [{ sourceId: "proof-1", digest: "a".repeat(64) }],
          },
        ],
      },
    });
    if (result.kind === "updated")
      expect(first(result.record.projections).sourceFingerprint).toBeUndefined();
  });

  it("treats link and unlink as generation-changing contract mutations outside draft", () => {
    const ref = {
      owner: "workboard" as const,
      cardId: "card-1",
      cardCreatedAt: 1,
      boardIdAtLink: "board-1",
    };
    const linked = reduceOutcomeLink(activeRecord("active-link"), {
      expectedRevision: 1,
      criterionId: "c-1",
      ref,
      serverTime: 42,
    });
    expect(linked).toMatchObject({
      kind: "updated",
      record: {
        phase: "active",
        revision: 2,
        contractRevision: 2,
        planGeneration: 2,
        updatedAt: 42,
      },
    });
    if (linked.kind !== "updated") return;
    expect(linked.record.planHash).toMatch(/^[0-9a-f]{64}$/);

    const accepted = { ...activeRecord("accepted-unlink"), phase: "accepted" as const };
    const acceptedLinked = {
      ...accepted,
      criteria: [{ ...first(accepted.criteria), workRefs: [ref] }],
    };
    const unlinked = reduceOutcomeUnlink(acceptedLinked, {
      expectedRevision: 1,
      criterionId: "c-1",
      ref,
      serverTime: 43,
    });
    expect(unlinked).toMatchObject({
      kind: "updated",
      record: {
        phase: "active",
        revision: 2,
        contractRevision: 2,
        planGeneration: 2,
        updatedAt: 43,
      },
    });
  });

  it("rejects link mutations that exceed either current-reference bound without changing the record", () => {
    const makeRef = (id: number) => ({
      owner: "workboard" as const,
      cardId: `card-${id}`,
      cardCreatedAt: id,
      boardIdAtLink: "board-1",
    });
    const perCriterion = {
      ...validRecord("per-criterion"),
      criteria: [
        {
          ...first(validRecord("per-criterion").criteria),
          workRefs: Array.from({ length: 10 }, (_, index) => makeRef(index)),
        },
      ],
    };
    expect(
      reduceOutcomeLink(perCriterion, {
        expectedRevision: 1,
        criterionId: "c-1",
        ref: makeRef(10),
        serverTime: 42,
      }),
    ).toEqual({ kind: "rejected", record: perCriterion });

    const total = {
      ...validRecord("total-refs"),
      criteria: [
        {
          ...first(validRecord("total-refs").criteria),
          workRefs: Array.from({ length: 10 }, (_, index) => makeRef(index)),
        },
        {
          id: "c-2",
          text: "second",
          required: false,
          workRefs: Array.from({ length: 10 }, (_, index) => makeRef(index + 10)),
        },
        { id: "c-3", text: "third", required: false, workRefs: [] },
      ],
    };
    expect(
      reduceOutcomeLink(total, {
        expectedRevision: 1,
        criterionId: "c-3",
        ref: makeRef(20),
        serverTime: 42,
      }),
    ).toEqual({ kind: "rejected", record: total });
  });

  it("rejects a duplicate create without a second write", async () => {
    const { repository, writes } = fixture();
    const record = validRecord();
    await repository.create(record);
    await expect(repository.create(record)).resolves.toEqual({ created: false });
    expect(writes()).toBe(1);
  });

  it("rejects an obsolete revision before applying a title change", () => {
    const record = { ...validRecord(), revision: 2, title: "old" };
    expect(
      reduceOutcomeTitle(record, { expectedRevision: 1, title: "new", serverTime: 42 }),
    ).toEqual({ kind: "conflict", record });
  });

  it("returns no-op without incrementing revision for unchanged title", () => {
    const record = { ...validRecord(), revision: 2, title: "same" };
    expect(
      reduceOutcomeTitle(record, { expectedRevision: 2, title: "same", serverTime: 42 }),
    ).toEqual({
      kind: "noop",
      record,
    });
  });

  it("treats canonical criteria/ref reordering as a contract no-op", () => {
    const record = activeRecord();
    const reordered = record.criteria.toReversed();
    const result = reduceOutcomeContract(record, {
      expectedRevision: record.revision,
      serverTime: 42,
      objective: record.objective,
      criteria: reordered,
    });
    expect(result).toEqual({ kind: "noop", record });
  });

  it("increments only revision when title changes", () => {
    const record = { ...activeRecord(), revision: 2, title: "old" };
    expect(
      reduceOutcomeTitle(record, { expectedRevision: 2, title: "new", serverTime: 42 }),
    ).toEqual({
      kind: "updated",
      record: { ...record, title: "new", revision: 3, updatedAt: 42 },
    });
  });

  it("applies title and contract fields in one revision", () => {
    const record = { ...activeRecord(), revision: 2, title: "old" };
    const result = reduceOutcomePatch(record, {
      expectedRevision: 2,
      title: "new",
      objective: "new objective",
      criteria: record.criteria,
      serverTime: 42,
    });
    expect(result).toMatchObject({
      kind: "updated",
      record: {
        title: "new",
        objective: "new objective",
        revision: 3,
        contractRevision: record.contractRevision + 1,
        planGeneration: record.planGeneration + 1,
        updatedAt: 42,
      },
    });
  });

  it("moves contract changes to a new generation with a new canonical plan hash", () => {
    const record = activeRecord();
    const nextCriteria = [
      {
        id: "c-2",
        text: "New criterion",
        required: true,
        workRefs: [
          {
            owner: "workboard" as const,
            cardId: "card",
            cardCreatedAt: 1,
            boardIdAtLink: "board",
          },
        ],
      },
    ];
    const result = reduceOutcomeContract(record, {
      expectedRevision: record.revision,
      serverTime: 42,
      objective: "New objective",
      criteria: nextCriteria,
    });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") {
      return;
    }
    expect(result.record.revision).toBe(record.revision + 1);
    expect(result.record.contractRevision).toBe(record.contractRevision + 1);
    expect(result.record.planGeneration).toBe(record.planGeneration + 1);
    expect(result.record.planHash).not.toBe(record.planHash);
    expect(result.record.criteria).not.toBe(nextCriteria);
    first(first(nextCriteria).workRefs).cardId = "mutated";
    expect(first(first(result.record.criteria).workRefs).cardId).toBe("card");
    expect(() => parseOutcomeRecord(result.record)).not.toThrow();
  });

  it("reopens accepted contracts while preserving acceptance history", () => {
    const base = activeRecord();
    const record = {
      ...base,
      phase: "accepted" as const,
      acceptances: [
        {
          id: "a-1",
          requestHash: "a".repeat(64),
          acceptedRevision: base.revision,
          profileId: "manager-1",
          acceptedAt: 2,
          planGeneration: base.planGeneration,
          planHash: base.planHash!,
          closureHash: "b".repeat(64),
          acceptedPlan: {
            outcomeId: base.id,
            objective: base.objective,
            contractRevision: base.contractRevision,
            planGeneration: base.planGeneration,
            criteria: base.criteria,
          },
        },
      ],
    };
    const acceptedPlanBefore = structuredClone(first(record.acceptances).acceptedPlan);
    const result = reduceOutcomeContract(record, {
      expectedRevision: record.revision,
      serverTime: 42,
      objective: "Revised objective",
      criteria: record.criteria,
    });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") {
      return;
    }
    expect(result.record.phase).toBe("active");
    expect(result.record.planGeneration).toBe(record.planGeneration + 1);
    expect(result.record.acceptances).toEqual(record.acceptances);
    expect(first(record.acceptances).acceptedPlan).toEqual(acceptedPlanBefore);
    expect(first(result.record.acceptances).acceptedPlan).toEqual(acceptedPlanBefore);
  });

  it("keeps draft contracts unplanned while applying a revision CAS", () => {
    const record = validRecord();
    const result = reduceOutcomeContract(record, {
      expectedRevision: 1,
      serverTime: 42,
      objective: "Draft objective",
      criteria: [{ id: "c-2", text: "Draft criterion", required: true, workRefs: [] }],
    });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") {
      return;
    }
    expect(result.record.phase).toBe("draft");
    expect(result.record.planGeneration).toBe(0);
    expect(result.record.planHash).toBeNull();
    expect(result.record.revision).toBe(2);
    expect(result.record.contractRevision).toBe(2);
  });

  it("never reuses a generation when a contract cycles A to B to A", () => {
    const initial = activeRecord();
    const criteriaA = initial.criteria;
    const firstMutation = reduceOutcomeContract(initial, {
      expectedRevision: initial.revision,
      serverTime: 42,
      objective: "B",
      criteria: [{ id: "c-b", text: "B", required: true, workRefs: [] }],
    });
    expect(firstMutation.kind).toBe("updated");
    if (firstMutation.kind !== "updated") {
      return;
    }
    const secondMutation = reduceOutcomeContract(firstMutation.record, {
      expectedRevision: firstMutation.record.revision,
      serverTime: 42,
      objective: initial.objective,
      criteria: criteriaA,
    });
    expect(secondMutation.kind).toBe("updated");
    if (secondMutation.kind !== "updated") {
      return;
    }
    expect(secondMutation.record.planGeneration).toBe(initial.planGeneration + 2);
    expect(secondMutation.record.planHash).not.toBe(initial.planHash);
  });

  it("fails closed for terminal phases and stale CAS revisions", () => {
    const mutation = {
      expectedRevision: 1,
      serverTime: 42,
      objective: "changed",
      criteria: [{ id: "c", text: "criterion", required: true, workRefs: [] }],
    };
    const accepted = { ...activeRecord(), phase: "accepted" as const };
    expect(reduceOutcomeContract(accepted, mutation)).toMatchObject({
      kind: "updated",
      record: { phase: "active", planGeneration: accepted.planGeneration + 1 },
    });
    const cancelled = { ...activeRecord(), phase: "cancelled" as const };
    expect(reduceOutcomeContract(cancelled, mutation)).toEqual({
      kind: "rejected",
      record: cancelled,
    });
    const stale = activeRecord();
    expect(reduceOutcomeContract({ ...stale, revision: stale.revision + 1 }, mutation)).toEqual({
      kind: "conflict",
      record: { ...stale, revision: stale.revision + 1 },
    });
  });

  it("rejects non-finite trusted mutation time", () => {
    const record = validRecord();
    expect(() =>
      reduceOutcomeTitle(record, { expectedRevision: 1, title: "new", serverTime: Number.NaN }),
    ).toThrow("serverTime must be finite");
    expect(() => reduceOutcomeActivate(record, 1, Number.POSITIVE_INFINITY)).toThrow(
      "serverTime must be finite",
    );
  });

  // P-01 host tests cover create replay, revision CAS, typed rejection, no-op,
  // and identical create races. Replay-before-CAS for verify/accept/start is a
  // later-phase contract and intentionally has no P-01 placeholder here.

  it("does not write when the reducer rejects or is a no-op", async () => {
    const { repository, writes } = fixture();
    const record = { ...activeRecord(), revision: 2, title: "same" };
    await repository.create(record);
    const before = writes();
    const decision = await repository.transact<OutcomeMutationResult>(record.id, (current) => {
      const next = reduceOutcomeTitle(current!, {
        expectedRevision: 2,
        title: "same",
        serverTime: 42,
      });
      return next.kind === "updated" ? { result: next, next: next.record } : { result: next };
    });
    expect(decision.kind).toBe("noop");
    expect(writes()).toBe(before);
    await expect(repository.get(record.id)).resolves.toEqual(record);
  });

  it("persists only an updated reducer decision", async () => {
    const { repository, writes } = fixture();
    const record = { ...activeRecord(), revision: 2, title: "old" };
    await repository.create(record);
    const decision = await repository.transact<OutcomeMutationResult>(record.id, (current) => {
      const next = reduceOutcomeTitle(current!, {
        expectedRevision: 2,
        title: "new",
        serverTime: 42,
      });
      return next.kind === "updated" ? { result: next, next: next.record } : { result: next };
    });
    expect(decision.kind).toBe("updated");
    expect(writes()).toBe(2);
    await expect(repository.get(record.id)).resolves.toMatchObject({ title: "new", revision: 3 });
  });

  it("rejects title updates for cancelled outcomes", () => {
    const record = {
      ...validRecord(),
      revision: 2,
      title: "same",
      phase: "cancelled" as const,
    };
    expect(
      reduceOutcomeTitle(record, { expectedRevision: 2, title: "new", serverTime: 42 }),
    ).toEqual({ kind: "rejected", record });
  });

  it("cancels only with the current revision and no in-flight operation", () => {
    const record = { ...activeRecord(), revision: 2 };
    expect(reduceOutcomeCancel(record, 1, 42)).toEqual({ kind: "conflict", record });
    expect(reduceOutcomeCancel(record, 2, 42)).toEqual({
      kind: "updated",
      record: { ...record, phase: "cancelled", revision: 3, updatedAt: 42 },
    });
    for (const state of ["prepared", "unknown", "may-have-crossed"] as const) {
      const busy = {
        ...record,
        operations: [
          {
            id: "op-1",
            kind: "workboard-card-start" as const,
            criterionId: "c-1",
            planGeneration: 1,
            createdRevision: 2,
            requestHash: "a".repeat(64),
            state,
            target: {
              owner: "workboard" as const,
              cardId: "c",
              cardCreatedAt: 1,
              boardIdAtLink: "b",
            },
          },
        ],
      };
      expect(reduceOutcomeCancel(busy, 2, 42)).toEqual({ kind: "rejected", record: busy });
    }
    for (const state of ["succeeded", "failed"] as const) {
      const settled = {
        ...record,
        operations: [
          {
            id: "op-1",
            kind: "workboard-card-start" as const,
            criterionId: "c-1",
            planGeneration: 1,
            createdRevision: 2,
            requestHash: "b".repeat(64),
            state,
            target: {
              owner: "workboard" as const,
              cardId: "c",
              cardCreatedAt: 1,
              boardIdAtLink: "b",
            },
          },
        ],
      };
      const cancelled = reduceOutcomeCancel(settled, 2, 42);
      expect(cancelled.kind).toBe("updated");
      if (cancelled.kind === "updated") {
        expect(cancelled.record.updatedAt).toBe(42);
      }
    }
    const accepted = { ...record, phase: "accepted" as const };
    expect(reduceOutcomeCancel(accepted, 2, 42)).toEqual({
      kind: "rejected",
      record: accepted,
    });
    const cancelled = { ...record, phase: "cancelled" as const };
    expect(reduceOutcomeCancel(cancelled, 2, 42)).toEqual({
      kind: "rejected",
      record: cancelled,
    });
  });
});
