import { randomUUID } from "node:crypto";
import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it } from "vitest";
import {
  OUTCOME_CAPACITY_WARNING_ENTRIES,
  OUTCOME_CAPACITY_WARNING_RECORD_BYTES,
  OUTCOME_CAPACITY_WARNING_WRITE_DURATION_MS,
  OUTCOME_MAX_ENTRIES,
} from "../domain/constants.js";
import { createRequestHash, planHash } from "../domain/schema.js";
import type { OutcomeRecord } from "../domain/types.js";
import { createOutcomeRepository } from "./plugin-state-repository.js";

function draftRecord(id: string, managerProfileId = "alice"): OutcomeRecord {
  const request = {
    id,
    title: "same",
    objective: "objective",
    criteria: [{ id: "c-1", text: "criterion", required: true, workRefs: [] }],
  };
  return {
    schemaVersion: 1,
    id,
    createRequestHash: createRequestHash(request),
    managerProfileId,
    title: "same",
    objective: "objective",
    phase: "draft",
    revision: 1,
    contractRevision: 1,
    planGeneration: 0,
    planHash: null,
    criteria: request.criteria,
    projections: [],
    evidence: [],
    decisions: [],
    operations: [],
    acceptances: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function serializedBytes(record: OutcomeRecord): number {
  return Buffer.byteLength(stableStringify(record), "utf8");
}

function activeRecordAtSize(id: string, targetBytes: number): OutcomeRecord {
  const draft = draftRecord(id);
  const plan = {
    outcomeId: draft.id,
    objective: draft.objective,
    contractRevision: draft.contractRevision,
    planGeneration: 1,
    criteria: draft.criteria,
  };
  const activePlanHash = planHash(plan);
  const record: OutcomeRecord = {
    ...draft,
    phase: "active",
    revision: 100,
    planGeneration: 1,
    planHash: activePlanHash,
    createdAt: 100,
    updatedAt: 100,
  };
  for (let index = 1; index <= 100 && serializedBytes(record) < targetBytes; index += 1) {
    const decision = {
      id: `decision-${index}`,
      criterionId: "c-1",
      planGeneration: 1,
      decidedRevision: index,
      status: "verified" as const,
      requestHash: `${index.toString(16).padStart(2, "0")}${"a".repeat(62)}`,
      profileId: record.managerProfileId,
      planHash: activePlanHash,
      decidedPlan: plan,
      evidenceSetHash: "b".repeat(64),
      note: "x".repeat(2_000),
      decidedAt: index,
    };
    record.decisions.push(decision);
    const overshoot = serializedBytes(record) - targetBytes;
    if (overshoot > 0) {
      decision.note = decision.note.slice(0, Math.max(0, decision.note.length - overshoot));
      if (serializedBytes(record) > targetBytes) {
        record.decisions.pop();
        break;
      }
    }
  }
  const actualBytes = serializedBytes(record);
  if (actualBytes > targetBytes || actualBytes < targetBytes * 0.9) {
    throw new Error(`unable to construct ${targetBytes}-byte Outcome record; got ${actualBytes}`);
  }
  return record;
}

afterEach(() => resetPluginStateStoreForTests());

describe("Outcome repository capacity diagnostics", () => {
  it("enforces the 500-record reject-new capacity without evicting", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-capacity", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: 500,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        const repository = createOutcomeRepository(store);
        for (let index = 0; index < OUTCOME_CAPACITY_WARNING_ENTRIES - 1; index += 1) {
          await expect(repository.create(draftRecord(`capacity-${index}`))).resolves.toEqual({
            created: true,
          });
        }
        await expect(repository.inspectCapacity()).resolves.toEqual({ entryCount: 399, warnings: [] });
        const reopenedRepository = createOutcomeRepository(store);
        await expect(
          reopenedRepository.create(draftRecord(`capacity-${OUTCOME_CAPACITY_WARNING_ENTRIES - 1}`)),
        ).resolves.toEqual({ created: true });
        await expect(repository.inspectCapacity()).resolves.toEqual({
          entryCount: OUTCOME_CAPACITY_WARNING_ENTRIES,
          warnings: [
            {
              kind: "entry-count",
              observed: OUTCOME_CAPACITY_WARNING_ENTRIES,
              threshold: OUTCOME_CAPACITY_WARNING_ENTRIES,
            },
          ],
        });
        for (let index = OUTCOME_CAPACITY_WARNING_ENTRIES; index < OUTCOME_MAX_ENTRIES; index += 1) {
          await expect(reopenedRepository.create(draftRecord(`capacity-${index}`))).resolves.toEqual({
            created: true,
          });
        }
        const replay = await reopenedRepository.createOwned("alice", draftRecord("capacity-0"));
        expect(replay).toMatchObject({ created: false, replayed: true });
        expect(replay.record).toEqual(draftRecord("capacity-0"));
        await expect(
          reopenedRepository.createOwned("alice", {
            ...draftRecord("capacity-0"),
            createRequestHash: "f".repeat(64),
          }),
        ).rejects.toMatchObject({ code: "outcome-create-conflict" });
        await expect(repository.create(draftRecord("capacity-overflow"))).rejects.toMatchObject({
          code: "outcome-capacity-exceeded",
        });
        await expect(
          repository.createOwned("alice", draftRecord("capacity-owned-overflow")),
        ).rejects.toMatchObject({ code: "outcome-capacity-exceeded" });
        await expect(store.lookup("capacity-owned-overflow")).resolves.toBeUndefined();
        await expect(reopenedRepository.get("capacity-0")).resolves.toBeDefined();
        await expect(reopenedRepository.get("capacity-499")).resolves.toBeDefined();
        const retained = await reopenedRepository.list();
        expect(retained).toHaveLength(500);
        expect(new Set(retained.map((entry) => entry.id))).toEqual(
          new Set(Array.from({ length: 500 }, (_, index) => `capacity-${index}`)),
        );
      },
    );
  });

  it("emits post-commit record-size and write-duration warnings without changing writes", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-capacity-warnings", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: OUTCOME_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        const warnings: Array<{ kind: string; observed: number; threshold: number }> = [];
        let now = 0;
        const repository = createOutcomeRepository(store, {
          now: () => {
            now += OUTCOME_CAPACITY_WARNING_WRITE_DURATION_MS;
            return now;
          },
          onCapacityWarning: (warning) => warnings.push(warning),
        });
        const nearLimit = activeRecordAtSize(
          "capacity-warning-record",
          OUTCOME_CAPACITY_WARNING_RECORD_BYTES,
        );
        expect(serializedBytes(nearLimit)).toBe(OUTCOME_CAPACITY_WARNING_RECORD_BYTES);
        await expect(repository.create(nearLimit)).resolves.toEqual({ created: true });
        await expect(repository.get(nearLimit.id)).resolves.toEqual(nearLimit);
        expect(warnings).toContainEqual({
          kind: "record-bytes",
          observed: OUTCOME_CAPACITY_WARNING_RECORD_BYTES,
          threshold: OUTCOME_CAPACITY_WARNING_RECORD_BYTES,
        });
        expect(warnings).toContainEqual({
          kind: "write-duration",
          observed: OUTCOME_CAPACITY_WARNING_WRITE_DURATION_MS,
          threshold: OUTCOME_CAPACITY_WARNING_WRITE_DURATION_MS,
        });
      },
    );
  });

  it("does not let a capacity observer change an acknowledged write", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-capacity-observer-failure", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: OUTCOME_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        const record = activeRecordAtSize(
          "capacity-warning-observer-failure",
          OUTCOME_CAPACITY_WARNING_RECORD_BYTES,
        );
        const repository = createOutcomeRepository(store, {
          onCapacityWarning: () => {
            throw new Error("observer unavailable");
          },
        });
        await expect(repository.create(record)).resolves.toEqual({ created: true });
        await expect(repository.get(record.id)).resolves.toEqual(record);
      },
    );
  });

  it("does not observe replay or no-op decisions as capacity writes", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-capacity-zero-write", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: OUTCOME_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        const warnings: Array<{ kind: string; observed: number; threshold: number }> = [];
        let now = 0;
        const repository = createOutcomeRepository(store, {
          now: () => {
            now += OUTCOME_CAPACITY_WARNING_WRITE_DURATION_MS;
            return now;
          },
          onCapacityWarning: (warning) => warnings.push(warning),
        });
        const record = draftRecord("capacity-zero-write");
        await repository.create(record);
        warnings.splice(0);
        await expect(repository.createOwned("alice", record)).resolves.toMatchObject({
          created: false,
          replayed: true,
        });
        await expect(
          repository.transact(record.id, (current) => ({ result: current?.revision })),
        ).resolves.toBe(1);
        expect(warnings).toEqual([]);
      },
    );
  });

  it("preserves a complete record with an unknown schema version", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-future-schema", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: OUTCOME_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        const future = { ...draftRecord("future"), schemaVersion: 2 } as unknown as OutcomeRecord;
        await store.registerIfAbsent(future.id, future);
        const repository = createOutcomeRepository(store);
        await expect(repository.get(future.id)).rejects.toThrow();
        await expect(store.lookup(future.id)).resolves.toEqual(future);
      },
    );
  });
});
