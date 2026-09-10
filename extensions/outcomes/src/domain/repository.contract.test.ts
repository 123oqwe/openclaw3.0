import { describe, expect, it } from "vitest";
import { createOutcomeRepository } from "../store/plugin-state-repository.js";
import type { OutcomeRecord } from "./types.js";
import { createRequestHash, parseOutcomeRecord, planHash } from "./schema.js";
import {
  reduceOutcomeActivate,
  reduceOutcomeCancel,
  reduceOutcomeContract,
  reduceOutcomeTitle,
  type OutcomeMutationResult,
} from "./reducer.js";

// P-01 contract cases exercise the repository boundary through the formal
// strict adapter and keep reducer behavior independently observable.
describe("Outcome repository atomic contract", () => {
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
      entries: async () =>
        Array.from(records, ([key, value]) => ({ key, value, createdAt: 0 })),
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
      criteria: [{ ...draft.criteria[0]!, workRefs: [{ owner: "workboard" as const, cardId: "card-1", cardCreatedAt: 1, boardIdAtLink: "board-1" }] }],
    };
    const activated = reduceOutcomeActivate(linked, linked.revision, 42);
    expect(activated.kind).toBe("updated");
    if (activated.kind !== "updated") return;
    expect(activated.record.phase).toBe("active");
    expect(activated.record.planGeneration).toBe(1);
    expect(activated.record.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(activated.record.contractRevision).toBe(linked.contractRevision);
    expect(activated.record.revision).toBe(linked.revision + 1);
    expect(activated.record.updatedAt).toBe(42);
    expect(reduceOutcomeActivate(draft, draft.revision).kind).toBe("rejected");
    expect(reduceOutcomeActivate(linked, linked.revision - 1).kind).toBe("conflict");
    const optionalOnly = {
      ...draft,
      criteria: [{ ...draft.criteria[0]!, required: false, workRefs: [] }, { id: "c-2", text: "optional", required: true, workRefs: linked.criteria[0]!.workRefs }],
    };
    expect(reduceOutcomeActivate(optionalOnly, optionalOnly.revision).kind).toBe("updated");
    expect(reduceOutcomeActivate(activeRecord("active-1"), 1).kind).toBe("rejected");

    for (const state of ["prepared", "unknown", "may-have-crossed"] as const) {
      const withOperation = { ...activeRecord(`active-${state}`), criteria: linked.criteria, operations: [{ id: state, kind: "workboard-card-start" as const, criterionId: "c-1", planGeneration: 1, createdRevision: 1, requestHash: "a".repeat(64), state, target: linked.criteria[0]!.workRefs[0]! }] };
      expect(reduceOutcomeContract(withOperation, { expectedRevision: 1, objective: "changed", criteria: withOperation.criteria }).kind).toBe("rejected");
      const titleUpdate = reduceOutcomeTitle(withOperation, { expectedRevision: 1, title: "new", serverTime: 42 });
      expect(titleUpdate.kind).toBe("updated");
      if (titleUpdate.kind === "updated") expect(titleUpdate.record.updatedAt).toBe(42);
    }
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
    expect(reduceOutcomeTitle(record, { expectedRevision: 1, title: "new" })).toEqual({ kind: "conflict", record });
  });

  it("returns no-op without incrementing revision for unchanged title", () => {
    const record = { ...validRecord(), revision: 2, title: "same" };
    expect(reduceOutcomeTitle(record, { expectedRevision: 2, title: "same" })).toEqual({
      kind: "noop",
      record,
    });
  });

  it("treats canonical criteria/ref reordering as a contract no-op", () => {
    const record = activeRecord();
    const reordered = [...record.criteria].reverse();
    const result = reduceOutcomeContract(record, {
      expectedRevision: record.revision,
      objective: record.objective,
      criteria: reordered,
    });
    expect(result).toEqual({ kind: "noop", record });
  });

  it("increments only revision when title changes", () => {
    const record = { ...activeRecord(), revision: 2, title: "old" };
    expect(reduceOutcomeTitle(record, { expectedRevision: 2, title: "new" })).toEqual({
      kind: "updated",
      record: { ...record, title: "new", revision: 3 },
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
      objective: "New objective",
      criteria: nextCriteria,
    });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") return;
    expect(result.record.revision).toBe(record.revision + 1);
    expect(result.record.contractRevision).toBe(record.contractRevision + 1);
    expect(result.record.planGeneration).toBe(record.planGeneration + 1);
    expect(result.record.planHash).not.toBe(record.planHash);
    expect(result.record.criteria).not.toBe(nextCriteria);
    nextCriteria[0].workRefs[0].cardId = "mutated";
    expect(result.record.criteria[0].workRefs[0].cardId).toBe("card");
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
    const acceptedPlanBefore = structuredClone(record.acceptances[0].acceptedPlan);
    const result = reduceOutcomeContract(record, {
      expectedRevision: record.revision,
      objective: "Revised objective",
      criteria: record.criteria,
    });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") return;
    expect(result.record.phase).toBe("active");
    expect(result.record.planGeneration).toBe(record.planGeneration + 1);
    expect(result.record.acceptances).toEqual(record.acceptances);
    expect(record.acceptances[0].acceptedPlan).toEqual(acceptedPlanBefore);
    expect(result.record.acceptances[0].acceptedPlan).toEqual(acceptedPlanBefore);
  });

  it("keeps draft contracts unplanned while applying a revision CAS", () => {
    const record = validRecord();
    const result = reduceOutcomeContract(record, {
      expectedRevision: 1,
      objective: "Draft objective",
      criteria: [{ id: "c-2", text: "Draft criterion", required: true, workRefs: [] }],
    });
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") return;
    expect(result.record.phase).toBe("draft");
    expect(result.record.planGeneration).toBe(0);
    expect(result.record.planHash).toBeNull();
    expect(result.record.revision).toBe(2);
    expect(result.record.contractRevision).toBe(2);
  });

  it("never reuses a generation when a contract cycles A to B to A", () => {
    const initial = activeRecord();
    const criteriaA = initial.criteria;
    const first = reduceOutcomeContract(initial, {
      expectedRevision: initial.revision,
      objective: "B",
      criteria: [{ id: "c-b", text: "B", required: true, workRefs: [] }],
    });
    expect(first.kind).toBe("updated");
    if (first.kind !== "updated") return;
    const second = reduceOutcomeContract(first.record, {
      expectedRevision: first.record.revision,
      objective: initial.objective,
      criteria: criteriaA,
    });
    expect(second.kind).toBe("updated");
    if (second.kind !== "updated") return;
    expect(second.record.planGeneration).toBe(initial.planGeneration + 2);
    expect(second.record.planHash).not.toBe(initial.planHash);
  });

  it("fails closed for terminal phases and stale CAS revisions", () => {
    const mutation = {
      expectedRevision: 1,
      objective: "changed",
      criteria: [
        { id: "c", text: "criterion", required: true, workRefs: [] },
      ],
    };
    for (const phase of ["accepted", "cancelled"] as const) {
      const record = { ...activeRecord(), phase };
      expect(reduceOutcomeContract(record, mutation)).toEqual({ kind: "rejected", record });
    }
    const stale = activeRecord();
    expect(
      reduceOutcomeContract({ ...stale, revision: stale.revision + 1 }, mutation),
    ).toEqual({ kind: "conflict", record: { ...stale, revision: stale.revision + 1 } });
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
      const next = reduceOutcomeTitle(current!, { expectedRevision: 2, title: "same" });
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
      const next = reduceOutcomeTitle(current!, { expectedRevision: 2, title: "new" });
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
    expect(reduceOutcomeTitle(record, { expectedRevision: 2, title: "new" })).toEqual({ kind: "rejected", record });
  });

  it("cancels only with the current revision and no in-flight operation", () => {
    const record = { ...activeRecord(), revision: 2 };
    expect(reduceOutcomeCancel(record, 1)).toEqual({ kind: "conflict", record });
    expect(reduceOutcomeCancel(record, 2)).toEqual({
      kind: "updated",
      record: { ...record, phase: "cancelled", revision: 3 },
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
      expect(reduceOutcomeCancel(busy, 2)).toEqual({ kind: "rejected", record: busy });
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
    if (cancelled.kind === "updated") expect(cancelled.record.updatedAt).toBe(42);
    }
    const accepted = { ...record, phase: "accepted" as const };
    expect(reduceOutcomeCancel(accepted, 2)).toEqual({
      kind: "rejected",
      record: accepted,
    });
    const cancelled = { ...record, phase: "cancelled" as const };
    expect(reduceOutcomeCancel(cancelled, 2)).toEqual({
      kind: "rejected",
      record: cancelled,
    });
  });

});
