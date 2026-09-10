import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it } from "vitest";
import { reduceOutcomeTitle, type OutcomeMutationResult } from "../domain/reducer.js";
import { createRequestHash, planHash } from "../domain/schema.js";
import type { OutcomeRecord } from "../domain/types.js";
import { createOutcomeRepository } from "./plugin-state-repository.js";

function draftRecord(id: string, managerProfileId = "alice"): OutcomeRecord {
  const request = { id, title: "same", objective: "objective", criteria: [{ id: "c-1", text: "criterion", required: true, workRefs: [] }] };
  return { schemaVersion: 1, id, createRequestHash: createRequestHash(request), managerProfileId, title: "same", objective: "objective", phase: "draft", revision: 1, contractRevision: 1, planGeneration: 0, planHash: null, criteria: request.criteria, projections: [], evidence: [], decisions: [], operations: [], acceptances: [], createdAt: 1, updatedAt: 1 };
}

afterEach(() => resetPluginStateStoreForTests());

describe("Outcome repository host adapter", () => {
  it("strictly validates persisted records at the storage boundary", async () => {
    await withOpenClawTestState({ label: "outcome-repository-strict", applyEnv: false }, async (state) => {
      const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        namespace: `outcomes-v1-${randomUUID()}`,
        maxEntries: 500,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      const repository = createOutcomeRepository(store);
      const record: OutcomeRecord = {
        schemaVersion: 1,
        id: "strict-1",
        createRequestHash: "a".repeat(64),
        managerProfileId: "alice",
        title: "Strict",
        objective: "Validate",
        phase: "draft",
        revision: 1,
        contractRevision: 1,
        planGeneration: 0,
        planHash: null,
        criteria: [{ id: "criterion-1", text: "done", required: true, workRefs: [] }],
        projections: [], evidence: [], decisions: [], operations: [], acceptances: [], createdAt: 1, updatedAt: 1,
      };
      await expect(repository.create(record)).resolves.toEqual({ created: true });
      await expect(repository.get(record.id)).resolves.toEqual(record);
      const sparse = { ...record, id: "strict-sparse", managerProfileId: undefined };
      // @ts-expect-error negative contract: persisted records require an owner identity.
      await expect(repository.create(sparse)).rejects.toThrow();
      await expect(store.lookup(sparse.id)).resolves.toBeUndefined();
      const foreign = { ...record, id: "strict-foreign" };
      const blank = { ...record, id: "strict-blank" };
      await expect(repository.createOwned("bob", foreign)).rejects.toThrow("authenticated owner");
      await expect(repository.createOwned("   ", blank)).rejects.toThrow("authenticated owner");
      await expect(store.lookup(foreign.id)).resolves.toBeUndefined();
      await expect(store.lookup(blank.id)).resolves.toBeUndefined();
    });
  });

  it("serializes concurrent CAS and persists only the winning title", async () => {
    await withOpenClawTestState({ label: "outcome-repository-cas", applyEnv: false }, async (state) => {
      const namespace = `outcomes-v1-${randomUUID()}`;
      const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        namespace,
        maxEntries: 500,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      const updates: unknown[] = [];
      const repository = createOutcomeRepository({
        ...store,
        update: async (id, callback) => store.update!(id, (current) => {
          const next = callback(current);
          updates.push(next);
          return next;
        }),
      });
      const initialBase = { ...draftRecord("o-1"), revision: 2, title: "old", phase: "active" as const, planGeneration: 1 };
      const initial = { ...initialBase, planHash: planHash({ outcomeId: initialBase.id, objective: initialBase.objective, contractRevision: initialBase.contractRevision, planGeneration: 1, criteria: initialBase.criteria }) };
      await expect(repository.create(initial)).resolves.toEqual({ created: true });
      const mutate = (title: string) => repository.transact<OutcomeMutationResult>(initial.id, (current) => {
        const decision = reduceOutcomeTitle(current!, { expectedRevision: 2, title });
        return decision.kind === "updated" ? { result: decision, next: decision.record } : { result: decision };
      });
      const results = await Promise.all([mutate("left"), mutate("right")]);
      expect(results.map((result) => result.kind).toSorted()).toEqual(["conflict", "updated"]);
      const winner = results.find((result) => result.kind === "updated");
      expect(winner?.kind).toBe("updated");
      await expect(repository.get(initial.id)).resolves.toEqual(winner?.record);
      await expect(repository.list()).resolves.toEqual([winner?.record]);
      expect(updates.filter((next) => next !== undefined)).toHaveLength(1);
      expect(winner?.record.phase).toBe("active");
      expect(winner?.record.planGeneration).toBe(1);
    });
  });

  it("keeps cancelled records unchanged for rejected and no-op decisions", async () => {
    await withOpenClawTestState({ label: "outcome-repository-zero-write", applyEnv: false }, async (state) => {
      const namespace = `outcomes-v1-${randomUUID()}`;
      const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        namespace,
        maxEntries: 500,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      const updates: unknown[] = [];
      const repository = createOutcomeRepository({
        ...store,
        update: async (id, callback) => store.update!(id, (current) => {
          const next = callback(current);
          updates.push(next);
          return next;
        }),
      });
      const draft = draftRecord("o-1");
      const record = { ...draft, revision: 2, phase: "cancelled" as const, planGeneration: 1, planHash: planHash({ outcomeId: draft.id, objective: draft.objective, contractRevision: draft.contractRevision, planGeneration: 1, criteria: draft.criteria }) };
      await repository.create(record);
      const result = await repository.transact<OutcomeMutationResult>(record.id, (current) => {
        const decision = reduceOutcomeTitle(current!, { expectedRevision: 2, title: "same" });
        return decision.kind === "updated" ? { result: decision, next: decision.record } : { result: decision };
      });
      expect(result.kind).toBe("rejected");
      await expect(repository.get(record.id)).resolves.toEqual(record);
      expect(updates).toEqual([undefined]);

      const activeBase = { ...draftRecord("o-2"), revision: 2, phase: "active" as const, planGeneration: 1 };
      const active = { ...activeBase, planHash: planHash({ outcomeId: activeBase.id, objective: activeBase.objective, contractRevision: activeBase.contractRevision, planGeneration: 1, criteria: activeBase.criteria }) };
      await repository.create(active);
      const noop = await repository.transact<OutcomeMutationResult>(active.id, (current) => {
        const decision = reduceOutcomeTitle(current!, { expectedRevision: 2, title: "same" });
        return decision.kind === "updated" ? { result: decision, next: decision.record } : { result: decision };
      });
      expect(noop.kind).toBe("noop");
      expect(updates).toEqual([undefined, undefined]);
      await expect(repository.get(active.id)).resolves.toEqual(active);

      resetPluginStateStoreForTests();
      const reopened = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        namespace,
        maxEntries: 500,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      await expect(reopened.lookup(record.id)).resolves.toEqual(record);
      await expect(reopened.lookup(active.id)).resolves.toEqual(active);
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", `
          import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
          const store = createPluginStateKeyedStoreForTests("outcomes", {
            namespace: ${JSON.stringify(namespace)},
            maxEntries: 500,
            overflowPolicy: "reject-new",
          });
          const value = await store.lookup(${JSON.stringify(record.id)});
          process.stdout.write(JSON.stringify(value));
        `],
        { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ...state.env } },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(record);
      const reopenedRepository = createOutcomeRepository(reopened);
      await expect(reopenedRepository.deleteIf(record.id, (current) => current.phase === "active")).resolves.toBe(
        false,
      );
      await expect(reopenedRepository.deleteIf(record.id, (current) => current.phase === "cancelled")).resolves.toBe(
        true,
      );
      await expect(reopenedRepository.get(record.id)).resolves.toBeUndefined();
    });
  });

  it("fails closed for an unauthorized owner transaction", async () => {
    await withOpenClawTestState({ label: "outcome-repository-owner", applyEnv: false }, async (state) => {
      const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        namespace: `outcomes-v1-${randomUUID()}`,
        maxEntries: 500,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      const repository = createOutcomeRepository(store);
      const record = draftRecord("owned");
      await repository.create(record);
      await expect(repository.getOwned("bob", record.id)).resolves.toBeUndefined();
      await expect(repository.listOwned("bob")).resolves.toEqual([]);
      await expect(repository.listOwned("alice")).resolves.toEqual([record]);
      await expect(
        repository.transactOwned("bob", record.id, () => ({ result: "must-not-run", next: record })),
      ).rejects.toThrow("Failed to update plugin state entry");
      await expect(repository.get(record.id)).resolves.toEqual(record);
      await expect(repository.deleteOwnedIf("bob", record.id, () => true)).resolves.toBe(false);
      await expect(repository.deleteOwnedIf("alice", record.id, () => true)).resolves.toBe(true);
      await expect(repository.get(record.id)).resolves.toBeUndefined();
      await expect(repository.listOwned("   ")).rejects.toThrow("non-empty");
    });
  });

  it("replays same-owner create and rejects hash conflicts", async () => {
    await withOpenClawTestState({ label: "outcome-repository-create-replay", applyEnv: false }, async (state) => {
      const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        namespace: `outcomes-v1-${randomUUID()}`,
        maxEntries: 500,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      const repository = createOutcomeRepository(store);
      const record = { ...draftRecord("replay"), createRequestHash: "a".repeat(64) };
      await expect(repository.createOwned("alice", record)).resolves.toMatchObject({
        created: true,
        replayed: false,
      });
      await expect(repository.createOwned("alice", record)).resolves.toMatchObject({
        created: false,
        replayed: true,
      });
      await expect(
        repository.createOwned("alice", { ...record, createRequestHash: "b".repeat(64) }),
      ).rejects.toThrow("conflicts");
    });
  });

  it("commits one record when identical owner creates race", async () => {
    await withOpenClawTestState({ label: "outcome-repository-create-race", applyEnv: false }, async (state) => {
      const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        namespace: `outcomes-v1-${randomUUID()}`,
        maxEntries: 500,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      const repository = createOutcomeRepository(store);
      const record = { ...draftRecord("race"), createRequestHash: "c".repeat(64) };
      const results = await Promise.all([
        repository.createOwned("alice", record),
        repository.createOwned("alice", record),
      ]);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results.filter((result) => result.replayed)).toHaveLength(1);
      await expect(repository.get(record.id)).resolves.toEqual(record);
    });
  });

  it("rejects oversized aggregates before create or update", async () => {
    await withOpenClawTestState({ label: "outcome-repository-size", applyEnv: false }, async (state) => {
      const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        namespace: `outcomes-v1-${randomUUID()}`,
        maxEntries: 500,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      const repository = createOutcomeRepository(store);
      const oversized = { ...draftRecord("large"), projections: [{ ref: { owner: "workboard" as const, cardId: "c", cardCreatedAt: 1, boardIdAtLink: "b" }, availability: "available" as const, observedAt: 1, proofs: [{ sourceId: "s", digest: "x".repeat(140_000) }], artifacts: [] }] };
      await expect(repository.create(oversized)).rejects.toThrow("131072-byte");
      await expect(repository.get(oversized.id)).resolves.toBeUndefined();

      const existing = draftRecord("small");
      await repository.create(existing);
      await expect(
        repository.transact(existing.id, (current) => ({
          result: "updated",
          next: { ...current!, projections: [{ ref: { owner: "workboard", cardId: "c", cardCreatedAt: 1, boardIdAtLink: "b" }, availability: "available", observedAt: 1, proofs: [{ sourceId: "s", digest: "x".repeat(140_000) }], artifacts: [] }] },
        })),
      ).rejects.toThrow("Failed to update plugin state entry");
      await expect(repository.get(existing.id)).resolves.toEqual(existing);
    });
  });

  it("enforces the 500-record reject-new capacity without evicting", async () => {
    await withOpenClawTestState({ label: "outcome-repository-capacity", applyEnv: false }, async (state) => {
      const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        namespace: `outcomes-v1-${randomUUID()}`,
        maxEntries: 500,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      const repository = createOutcomeRepository(store);
      for (let index = 0; index < 500; index += 1) {
        await expect(repository.create(draftRecord(`capacity-${index}`))).resolves.toEqual({
          created: true,
        });
      }
      await expect(repository.create(draftRecord("capacity-overflow"))).resolves.toEqual({
        created: false,
      });
      await expect(repository.get("capacity-0")).resolves.toBeDefined();
      await expect(repository.get("capacity-499")).resolves.toBeDefined();
      await expect(repository.list()).resolves.toHaveLength(500);
    });
  });
});
