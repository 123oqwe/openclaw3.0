import { describe, expect, it } from "vitest";
import { createOutcomeRepository } from "../store/plugin-state-repository.js";
import type { OutcomeRecord } from "./types.js";
import {
  reduceOutcomeCancel,
  reduceOutcomeTitle,
  type OutcomeMutationResult,
} from "./reducer.js";

// P-01 contract cases are intentionally staged before the domain repository
// exists. They name the required observable behavior without treating a
// missing production module as a RED result.
describe("Outcome repository atomic contract", () => {
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
    const record = { id: "o-1", revision: 1 };
    await expect(repository.create(record)).resolves.toEqual({ created: true });
    await expect(repository.get(record.id)).resolves.toEqual(record);
    expect(writes()).toBe(1);
  });

  it("rejects a duplicate create without a second write", async () => {
    const { repository, writes } = fixture();
    const record = { id: "o-1", revision: 1 };
    await repository.create(record);
    await expect(repository.create(record)).resolves.toEqual({ created: false });
    expect(writes()).toBe(1);
  });

  it("rejects an obsolete revision before applying a title change", () => {
    const record = { id: "o-1", revision: 2, title: "old" };
    expect(reduceOutcomeTitle(record, { expectedRevision: 1, title: "new" })).toEqual({ kind: "conflict", record });
  });

  it("returns no-op without incrementing revision for unchanged title", () => {
    const record = { id: "o-1", revision: 2, title: "same" };
    expect(reduceOutcomeTitle(record, { expectedRevision: 2, title: "same" })).toEqual({
      kind: "noop",
      record,
    });
  });

  it("increments only revision when title changes", () => {
    const record = {
      id: "o-1",
      revision: 2,
      title: "old",
      phase: "active" as const,
      planGeneration: 3,
    };
    expect(reduceOutcomeTitle(record, { expectedRevision: 2, title: "new" })).toEqual({
      kind: "updated",
      record: { ...record, title: "new", revision: 3 },
    });
  });

  it("does not write when the reducer rejects or is a no-op", async () => {
    const { repository, writes } = fixture();
    const record = { id: "o-1", revision: 2, title: "same", phase: "active" as const };
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
    const record = { id: "o-1", revision: 2, title: "old", phase: "active" as const };
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
    const record = { id: "o-1", revision: 2, title: "same", phase: "cancelled" as const };
    expect(reduceOutcomeTitle(record, { expectedRevision: 2, title: "new" })).toEqual({ kind: "rejected", record });
  });

  it("cancels only with the current revision and no in-flight operation", () => {
    const record = {
      id: "o-1",
      revision: 2,
      phase: "active" as const,
      planGeneration: 3,
      planHash: "plan-hash",
    };
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
            requestHash: "hash",
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
            requestHash: "hash",
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
      expect(reduceOutcomeCancel(settled, 2).kind).toBe("updated");
    }
    const accepted = { ...record, phase: "accepted" as const };
    expect(reduceOutcomeCancel(accepted, 2)).toEqual({ kind: "rejected", record: accepted });
    const cancelled = { ...record, phase: "cancelled" as const };
    expect(reduceOutcomeCancel(cancelled, 2)).toEqual({ kind: "rejected", record: cancelled });
  });

  it.todo("replays an idempotent mutation before checking expected revision");
  it.todo("commits the same mutation once when concurrent callers race");
  it.todo("returns a typed rejection without writing the record");
  it.todo("returns unchanged state without incrementing revision or writing");
});
