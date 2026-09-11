import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it } from "vitest";
import { summarizeBenchmarkTimings } from "../../../../scripts/lib/benchmark-harness.mts";
import {
  OUTCOME_CAPACITY_WARNING_ENTRIES,
  OUTCOME_CAPACITY_WARNING_RECORD_BYTES,
  OUTCOME_CAPACITY_WARNING_WRITE_DURATION_MS,
  OUTCOME_MAX_ENTRIES,
} from "../domain/constants.js";
import {
  reduceOutcomeActivate,
  reduceOutcomeTitle,
  type OutcomeMutationResult,
} from "../domain/reducer.js";
import { createRequestHash, planHash } from "../domain/schema.js";
import type { OutcomeRecord } from "../domain/types.js";
import {
  OutcomeRepositoryConflictError,
  OutcomeRepositoryNotFoundError,
  createOutcomeRepository,
} from "./plugin-state-repository.js";

const OUTCOME_PERFORMANCE_SAMPLES = 20;
const OUTCOME_PERFORMANCE_SCENARIOS = [
  { recordCount: 50, recordBytes: 4 * 1024 },
  { recordCount: 50, recordBytes: 96 * 1024 },
  { recordCount: 50, recordBytes: 128 * 1024 },
  { recordCount: 500, recordBytes: 4 * 1024 },
  { recordCount: 500, recordBytes: 96 * 1024 },
  { recordCount: 500, recordBytes: 128 * 1024 },
] as const;

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
  const record: OutcomeRecord = {
    ...draft,
    phase: "active",
    revision: 100,
    planGeneration: 1,
    planHash: planHash(plan),
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
      planHash: record.planHash,
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

function writeOutcomeBenchmarkArtifact(report: object): void {
  const artifactPath = process.env.OPENCLAW_OUTCOME_BENCHMARK_ARTIFACT_PATH;
  if (!artifactPath) {
    return;
  }
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
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
          projections: [
            {
              ref: {
                owner: "workboard" as const,
                cardId: "c",
                cardCreatedAt: 1,
                boardIdAtLink: "b",
              },
              availability: "available" as const,
              observedAt: 1,
              proofs: [{ sourceId: "s", digest: "x".repeat(140_000) }],
              artifacts: [],
            },
          ],
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
              projections: [
                {
                  ref: { owner: "workboard", cardId: "c", cardCreatedAt: 1, boardIdAtLink: "b" },
                  availability: "available",
                  observedAt: 1,
                  proofs: [{ sourceId: "s", digest: "x".repeat(140_000) }],
                  artifacts: [],
                },
              ],
            },
          })),
        ).rejects.toMatchObject({ code: "outcome-capacity-exceeded" });
        await expect(repository.get(existing.id)).resolves.toEqual(existing);
      },
    );
  });

  it("measures bounded host-adapter list and mutation behavior across the P-01 matrix", async () => {
    const reports: Array<{
      actualRecordBytes: number;
      eventLoop: { baselineMaxMs: number; maxMs: number; deltaMs: number; resolutionMs: number };
      heap: { afterBytes: number; beforeBytes: number; deltaBytes: number };
      list: ReturnType<typeof summarizeBenchmarkTimings>;
      measurementScope: {
        eventLoop: "whole-scenario-including-validation";
        heap: "whole-scenario-including-validation";
      };
      mutation: ReturnType<typeof summarizeBenchmarkTimings>;
      recordCount: number;
      requestedRecordBytes: number;
      samples: number;
      targetsMs: { eventLoopLagDelta: number; listP95: number; mutationP95: number };
      withinTargets: { eventLoopLagDelta: boolean; listP95: boolean; mutationP95: boolean };
      warmupCounts: { list: number; mutation: number };
    }> = [];

    await withOpenClawTestState(
      { label: "outcome-repository-performance", applyEnv: false },
      async (state) => {
        for (const scenario of OUTCOME_PERFORMANCE_SCENARIOS) {
          const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
            namespace: `outcomes-v1-performance-${randomUUID()}`,
            maxEntries: OUTCOME_MAX_ENTRIES,
            overflowPolicy: "reject-new",
            env: state.env,
          });
          const repository = createOutcomeRepository(store);
          const records = Array.from({ length: scenario.recordCount }, (_, index) =>
            activeRecordAtSize(
              `performance-${scenario.recordCount}-${scenario.recordBytes}-${index}`,
              scenario.recordBytes,
            ),
          );
          const actualRecordBytes = records.map(serializedBytes);
          expect(new Set(actualRecordBytes).size).toBe(1);
          expect(actualRecordBytes[0]).toBeGreaterThanOrEqual(scenario.recordBytes * 0.9);
          expect(actualRecordBytes[0]).toBeLessThanOrEqual(scenario.recordBytes);
          for (const record of records) {
            await expect(repository.create(record)).resolves.toEqual({ created: true });
          }
          const expectedIds = new Set(records.map((record) => record.id));
          const seeded = await repository.list();
          expect(seeded).toHaveLength(scenario.recordCount);
          expect(new Set(seeded.map((record) => record.id))).toEqual(expectedIds);

          const delay = monitorEventLoopDelay({ resolution: 10 });
          delay.enable();
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          const baselineMaxMs = Number(delay.max) / 1_000_000;
          delay.reset();
          const heapBeforeBytes = process.memoryUsage().heapUsed;
          const listTimings: number[] = [];
          const mutationTimings: number[] = [];
          try {
            for (let sample = 0; sample < OUTCOME_PERFORMANCE_SAMPLES; sample += 1) {
              const startedAt = performance.now();
              const listed = await repository.list();
              listTimings.push(performance.now() - startedAt);
              expect(listed).toHaveLength(scenario.recordCount);
              expect(new Set(listed.map((record) => record.id))).toEqual(expectedIds);
            }
            const mutationId = records[0]?.id;
            if (!mutationId) {
              throw new Error("performance scenario must contain a record");
            }
            for (let sample = 0; sample < OUTCOME_PERFORMANCE_SAMPLES; sample += 1) {
              const startedAt = performance.now();
              const result = await repository.transact(mutationId, (current) => {
                if (!current) {
                  throw new Error("performance mutation record disappeared");
                }
                const next = {
                  ...current,
                  title: "perf",
                  revision: current.revision + 1,
                  updatedAt: 101 + sample,
                };
                return { result: next.revision, next };
              });
              mutationTimings.push(performance.now() - startedAt);
              expect(result).toBe(101 + sample);
            }
            const mutated = await repository.get(mutationId);
            if (!mutated) {
              throw new Error("performance mutation record could not be read back");
            }
            expect(mutated).toMatchObject({
              id: mutationId,
              revision: 100 + OUTCOME_PERFORMANCE_SAMPLES,
              title: "perf",
              updatedAt: 100 + OUTCOME_PERFORMANCE_SAMPLES,
            });
            expect(serializedBytes(mutated)).toBeLessThanOrEqual(scenario.recordBytes);
          } finally {
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
            delay.disable();
          }

          const list = summarizeBenchmarkTimings(listTimings);
          const mutation = summarizeBenchmarkTimings(mutationTimings);
          const maxMs = Number(delay.max) / 1_000_000;
          const heapAfterBytes = process.memoryUsage().heapUsed;
          expect(list.count).toBe(OUTCOME_PERFORMANCE_SAMPLES);
          expect(mutation.count).toBe(OUTCOME_PERFORMANCE_SAMPLES);
          for (const timing of [...listTimings, ...mutationTimings]) {
            expect(Number.isFinite(timing)).toBe(true);
            expect(timing).toBeGreaterThanOrEqual(0);
          }
          expect(list.p95).toBeTypeOf("number");
          expect(mutation.p95).toBeTypeOf("number");
          for (const timing of [list.p50, list.p95, mutation.p50, mutation.p95]) {
            expect(Number.isFinite(timing)).toBe(true);
            expect(timing).toBeGreaterThanOrEqual(0);
          }
          expect(Number.isFinite(maxMs)).toBe(true);
          expect(Number.isFinite(heapBeforeBytes)).toBe(true);
          expect(Number.isFinite(heapAfterBytes)).toBe(true);
          const targetsMs = { mutationP95: 100, listP95: 1_000, eventLoopLagDelta: 20 };
          const eventLoopDeltaMs = Math.max(0, maxMs - baselineMaxMs);
          reports.push({
            recordCount: scenario.recordCount,
            requestedRecordBytes: scenario.recordBytes,
            actualRecordBytes: actualRecordBytes[0] ?? 0,
            samples: OUTCOME_PERFORMANCE_SAMPLES,
            list,
            mutation,
            eventLoop: {
              resolutionMs: 10,
              baselineMaxMs,
              maxMs,
              deltaMs: eventLoopDeltaMs,
            },
            heap: {
              beforeBytes: heapBeforeBytes,
              afterBytes: heapAfterBytes,
              deltaBytes: heapAfterBytes - heapBeforeBytes,
            },
            measurementScope: {
              eventLoop: "whole-scenario-including-validation",
              heap: "whole-scenario-including-validation",
            },
            targetsMs,
            withinTargets: {
              mutationP95: (mutation.p95 ?? Number.POSITIVE_INFINITY) <= targetsMs.mutationP95,
              listP95: (list.p95 ?? Number.POSITIVE_INFINITY) <= targetsMs.listP95,
              eventLoopLagDelta: eventLoopDeltaMs <= targetsMs.eventLoopLagDelta,
            },
            warmupCounts: { list: 1, mutation: 0 },
          });
        }
      },
    );

    expect(reports).toHaveLength(OUTCOME_PERFORMANCE_SCENARIOS.length);
    const report = {
      schemaVersion: 1,
      job: {
        id: process.env.GITHUB_JOB ?? "local",
        name: process.env.OPENCLAW_OUTCOME_BENCHMARK_JOB_NAME ?? "local",
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
        runId: process.env.GITHUB_RUN_ID ?? "local",
        shard: process.env.OPENCLAW_OUTCOME_BENCHMARK_SHARD ?? "local",
      },
      measurementDefinition: {
        eventLoopAndHeap: "whole-scenario-including-validation",
        listWarmupSamples: 1,
        mutationWarmupSamples: 0,
        samplesPerOperation: OUTCOME_PERFORMANCE_SAMPLES,
        scenarios: OUTCOME_PERFORMANCE_SCENARIOS,
      },
      runner: {
        arch: process.arch,
        image: process.env.ImageOS ?? process.env.RUNNER_IMAGE ?? null,
        node: process.version,
        platform: process.platform,
      },
      testedCheckoutSha:
        process.env.OPENCLAW_OUTCOME_BENCHMARK_CHECKOUT_SHA ?? process.env.GITHUB_SHA ?? "local",
      workflowSha: process.env.OPENCLAW_OUTCOME_BENCHMARK_WORKFLOW_SHA ?? "local",
      reports,
    };
    writeOutcomeBenchmarkArtifact(report);
    console.info(`[outcome-plugin-state-benchmark] ${JSON.stringify(report)}`);
  });

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
        const warnings: Array<{ kind: string; observed: number; threshold: number }> = [];
        const repository = createOutcomeRepository(store, {
          onCapacityWarning: (warning) => warnings.push(warning),
        });
        for (let index = 0; index < OUTCOME_CAPACITY_WARNING_ENTRIES - 1; index += 1) {
          await expect(repository.create(draftRecord(`capacity-${index}`))).resolves.toEqual({
            created: true,
          });
        }
        expect(warnings).toEqual([]);
        await expect(
          repository.create(draftRecord(`capacity-${OUTCOME_CAPACITY_WARNING_ENTRIES - 1}`)),
        ).resolves.toEqual({ created: true });
        expect(warnings).toContainEqual({
          kind: "entry-count",
          observed: OUTCOME_CAPACITY_WARNING_ENTRIES,
          threshold: OUTCOME_CAPACITY_WARNING_ENTRIES,
        });
        for (let index = OUTCOME_CAPACITY_WARNING_ENTRIES; index < OUTCOME_MAX_ENTRIES; index += 1) {
          await expect(repository.create(draftRecord(`capacity-${index}`))).resolves.toEqual({
            created: true,
          });
        }
        const replay = await repository.createOwned("alice", draftRecord("capacity-0"));
        expect(replay).toMatchObject({ created: false, replayed: true });
        expect(replay.record).toEqual(draftRecord("capacity-0"));
        await expect(
          repository.createOwned("alice", {
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
        await expect(repository.get("capacity-0")).resolves.toBeDefined();
        await expect(repository.get("capacity-499")).resolves.toBeDefined();
        const retained = await repository.list();
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

  it("fails closed on corrupt persisted records without mutation or deletion", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-corrupt", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: 500,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        // Deliberately malformed persisted value: unknown version and missing fields.
        const corrupt = {
          id: "corrupt",
          managerProfileId: "alice",
          schemaVersion: 99,
        } as unknown as OutcomeRecord;
        await store.registerIfAbsent(corrupt.id, corrupt);
        const repository = createOutcomeRepository(store);
        await expect(repository.get(corrupt.id)).rejects.toThrow();
        let called = false;
        await expect(
          repository.transact(corrupt.id, () => {
            called = true;
            return { result: "unexpected" };
          }),
        ).rejects.toMatchObject({ code: "PLUGIN_STATE_WRITE_FAILED" });
        expect(called).toBe(false);
        await expect(
          repository.transactOwned("alice", corrupt.id, () => {
            called = true;
            return { result: "unexpected" };
          }),
        ).rejects.toMatchObject({ code: "PLUGIN_STATE_WRITE_FAILED" });
        expect(called).toBe(false);
        await expect(
          repository.deleteIf(corrupt.id, () => {
            called = true;
            return true;
          }),
        ).rejects.toThrow();
        expect(called).toBe(false);
        await expect(store.lookup(corrupt.id)).resolves.toEqual(corrupt);
      },
    );
  });

  it("preserves a complete record with an unknown schema version", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-future-schema", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: 500,
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
