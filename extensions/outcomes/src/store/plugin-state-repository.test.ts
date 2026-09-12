import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it } from "vitest";
import { OUTCOME_MAX_ENTRIES } from "../domain/constants.js";
import {
  reduceOutcomeActivate,
  reduceOutcomeTitle,
  type OutcomeMutationResult,
} from "../domain/reducer.js";
import { createRequestHash, planHash, workboardProjectionFingerprint } from "../domain/schema.js";
import type { OutcomeRecord } from "../domain/types.js";
import {
  OutcomeRepositoryConflictError,
  OutcomeRepositoryNotFoundError,
  createOutcomeRepository,
} from "./plugin-state-repository.js";

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

function oversizedAvailableProjection(digest: string): OutcomeRecord["projections"][number] {
  const ref = {
    owner: "workboard" as const,
    cardId: "c",
    cardCreatedAt: 1,
    boardIdAtLink: "b",
  };
  const proofs = [{ sourceId: "s", digest }];
  const artifacts: Array<{ sourceId: string; digest: string }> = [];
  return {
    ref,
    availability: "available",
    currentBoardId: "board-current",
    status: "done",
    observedAt: 1,
    sourceUpdatedAt: 1,
    proofs,
    artifacts,
    sourceFingerprint: workboardProjectionFingerprint({
      ref,
      proofs,
      artifacts,
      currentBoardId: "board-current",
      status: "done",
      sourceUpdatedAt: 1,
    }),
  };
}

afterEach(() => resetPluginStateStoreForTests());

describe("Outcome repository host adapter", () => {
  it("strictly validates persisted records at the storage boundary", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-strict", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: OUTCOME_MAX_ENTRIES,
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
          projections: [],
          evidence: [],
          decisions: [],
          operations: [],
          acceptances: [],
          createdAt: 1,
          updatedAt: 1,
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
      },
    );
  });

  it("serializes concurrent CAS and persists only the winning title", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-cas", applyEnv: false },
      async (state) => {
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
          update: async (id, callback) =>
            store.update!(id, (current) => {
              const next = callback(current);
              updates.push(next);
              return next;
            }),
        });
        const initialBase = {
          ...draftRecord("o-1"),
          revision: 2,
          title: "old",
          phase: "active" as const,
          planGeneration: 1,
        };
        const initial = {
          ...initialBase,
          planHash: planHash({
            outcomeId: initialBase.id,
            objective: initialBase.objective,
            contractRevision: initialBase.contractRevision,
            planGeneration: 1,
            criteria: initialBase.criteria,
          }),
        };
        await expect(repository.create(initial)).resolves.toEqual({ created: true });
        const mutate = (title: string) =>
          repository.transact<OutcomeMutationResult>(initial.id, (current) => {
            const decision = reduceOutcomeTitle(current!, {
              expectedRevision: 2,
              title,
              serverTime: 42,
            });
            return decision.kind === "updated"
              ? { result: decision, next: decision.record }
              : { result: decision };
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
      },
    );
  });

  it("persists activation atomically and performs no write for rejected activation", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-activate", applyEnv: false },
      async (state) => {
        const namespace = `outcomes-v1-${randomUUID()}`;
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace,
          maxEntries: 500,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        const repository = createOutcomeRepository(store);
        const draft = draftRecord("activate-host");
        const linked = {
          ...draft,
          criteria: [
            {
              ...draft.criteria[0]!,
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
        await repository.create(linked);
        const activated = await repository.transact<ReturnType<typeof reduceOutcomeActivate>>(
          linked.id,
          (current) => {
            const decision = reduceOutcomeActivate(current!, current!.revision, 42);
            return decision.kind === "updated"
              ? { result: decision, next: decision.record }
              : { result: decision };
          },
        );
        expect(activated.kind).toBe("updated");
        await expect(repository.get(linked.id)).resolves.toMatchObject({
          phase: "active",
          planGeneration: 1,
          updatedAt: 42,
          revision: 2,
        });
        const rejected = await repository.transact<ReturnType<typeof reduceOutcomeActivate>>(
          linked.id,
          (current) => {
            const decision = reduceOutcomeActivate(current!, current!.revision, 99);
            return decision.kind === "updated"
              ? { result: decision, next: decision.record }
              : { result: decision };
          },
        );
        expect(rejected.kind).toBe("rejected");
        await expect(repository.get(linked.id)).resolves.toMatchObject({
          phase: "active",
          updatedAt: 42,
          revision: 2,
        });
      },
    );
  });

  it("keeps cancelled records unchanged for rejected and no-op decisions", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-zero-write", applyEnv: false },
      async (state) => {
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
          update: async (id, callback) =>
            store.update!(id, (current) => {
              const next = callback(current);
              updates.push(next);
              return next;
            }),
        });
        const draft = draftRecord("o-1");
        const record = {
          ...draft,
          revision: 2,
          phase: "cancelled" as const,
          planGeneration: 1,
          planHash: planHash({
            outcomeId: draft.id,
            objective: draft.objective,
            contractRevision: draft.contractRevision,
            planGeneration: 1,
            criteria: draft.criteria,
          }),
        };
        await repository.create(record);
        const result = await repository.transact<OutcomeMutationResult>(record.id, (current) => {
          const decision = reduceOutcomeTitle(current!, {
            expectedRevision: 2,
            title: "same",
            serverTime: 42,
          });
          return decision.kind === "updated"
            ? { result: decision, next: decision.record }
            : { result: decision };
        });
        expect(result.kind).toBe("rejected");
        await expect(repository.get(record.id)).resolves.toEqual(record);
        expect(updates).toEqual([undefined]);

        const activeBase = {
          ...draftRecord("o-2"),
          revision: 2,
          phase: "active" as const,
          planGeneration: 1,
        };
        const active = {
          ...activeBase,
          planHash: planHash({
            outcomeId: activeBase.id,
            objective: activeBase.objective,
            contractRevision: activeBase.contractRevision,
            planGeneration: 1,
            criteria: activeBase.criteria,
          }),
        };
        await repository.create(active);
        const noop = await repository.transact<OutcomeMutationResult>(active.id, (current) => {
          const decision = reduceOutcomeTitle(current!, {
            expectedRevision: 2,
            title: "same",
            serverTime: 42,
          });
          return decision.kind === "updated"
            ? { result: decision, next: decision.record }
            : { result: decision };
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
          [
            "--import",
            "tsx",
            "--input-type=module",
            "--eval",
            `
          import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
          const store = createPluginStateKeyedStoreForTests("outcomes", {
            namespace: ${JSON.stringify(namespace)},
            maxEntries: 500,
            overflowPolicy: "reject-new",
          });
          const value = await store.lookup(${JSON.stringify(record.id)});
          process.stdout.write(JSON.stringify(value));
        `,
          ],
          { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ...state.env } },
        );
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual(record);
        const reopenedRepository = createOutcomeRepository(reopened);
        await expect(
          reopenedRepository.deleteIf(record.id, (current) => current.phase === "active"),
        ).resolves.toBe(false);
        await expect(
          reopenedRepository.deleteIf(record.id, (current) => current.phase === "cancelled"),
        ).resolves.toBe(true);
        await expect(reopenedRepository.get(record.id)).resolves.toBeUndefined();
      },
    );
  });

  it("lists owned records in deterministic updatedAt/id order", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-list-order", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: 500,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        const repository = createOutcomeRepository(store);
        const records = [
          { ...draftRecord("b"), managerProfileId: "alice", updatedAt: 3 },
          { ...draftRecord("a"), managerProfileId: "alice", updatedAt: 3 },
          { ...draftRecord("z"), managerProfileId: "bob", updatedAt: 4 },
        ];
        for (const record of records) {
          await repository.create(record);
        }
        await expect(repository.listOwned("alice")).resolves.toMatchObject([
          { id: "a" },
          { id: "b" },
        ]);
      },
    );
  });

  it("fails closed for an unauthorized owner transaction", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-owner", applyEnv: false },
      async (state) => {
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
          repository.transactOwned("bob", record.id, () => ({
            result: "must-not-run",
            next: record,
          })),
        ).rejects.toMatchObject({ code: "outcome-not-found" });
        await expect(
          repository.transactOwned("alice", "missing", () => ({
            result: "must-not-run",
            next: record,
          })),
        ).rejects.toBeInstanceOf(OutcomeRepositoryNotFoundError);
        await expect(repository.get(record.id)).resolves.toEqual(record);
        await expect(repository.deleteOwnedIf("   ", record.id, () => true)).rejects.toThrow(
          "non-empty",
        );
        await expect(repository.get(record.id)).resolves.toEqual(record);
        await expect(repository.deleteOwnedIf("bob", record.id, () => true)).resolves.toBe(false);
        await expect(repository.deleteOwnedIf("alice", record.id, () => true)).resolves.toBe(true);
        await expect(repository.get(record.id)).resolves.toBeUndefined();
        await expect(repository.listOwned("   ")).rejects.toThrow("non-empty");
      },
    );
  });

  it("replays same-owner create and rejects hash conflicts", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-create-replay", applyEnv: false },
      async (state) => {
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
        ).rejects.toBeInstanceOf(OutcomeRepositoryConflictError);
      },
    );
  });

  it("commits one record when identical owner creates race", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-create-race", applyEnv: false },
      async (state) => {
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
      },
    );
  });

  it("rejects oversized aggregates before create or update", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-size", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: 500,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        const repository = createOutcomeRepository(store);
        const oversized = {
          ...draftRecord("large"),
          projections: [oversizedAvailableProjection("x".repeat(140_000))],
        };
        await expect(repository.create(oversized)).rejects.toMatchObject({
          code: "outcome-capacity-exceeded",
        });
        await expect(repository.get(oversized.id)).resolves.toBeUndefined();

        const existing = draftRecord("small");
        await repository.create(existing);
        await expect(
          repository.transact(existing.id, (current) => ({
            result: "updated",
            next: {
              ...current!,
              projections: [oversizedAvailableProjection("x".repeat(140_000))],
            },
          })),
        ).rejects.toMatchObject({ code: "outcome-capacity-exceeded" });
        await expect(repository.get(existing.id)).resolves.toEqual(existing);
      },
    );
  });
});
