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
import { createRequestHash, parseOutcomeRecord, planHash } from "../domain/schema.js";
import type { OutcomeRecord } from "../domain/types.js";
import { createOutcomeRepository } from "./plugin-state-repository.js";

const OUTCOME_PERFORMANCE_SAMPLES = 20;
const OUTCOME_PERFORMANCE_TARGETS_MS = {
  eventLoopLagDelta: 20,
  listP95: 1_000,
  mutationP95: 100,
} as const;
const OUTCOME_ISOLATED_BENCHMARK_TEST_NAME =
  "^Outcome repository host adapter measures bounded host-adapter list and mutation behavior across the P-01 matrix$";
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
  if (actualBytes !== targetBytes) {
    throw new Error(`unable to construct ${targetBytes}-byte Outcome record; got ${actualBytes}`);
  }
  return record;
}

type OutcomePerformanceScenarioReport = {
  actualRecordBytes: number;
  eventLoop: { deltaMs: number };
  list: { count: number; p95?: number | null };
  mutation: { count: number; p95?: number | null };
  recordCount: number;
  requestedRecordBytes: number;
  samples: number;
  withinTargets: { eventLoopLagDelta: boolean; listP95: boolean; mutationP95: boolean };
};

type OutcomeIsolatedBenchmarkReport = {
  complete: boolean;
  completedScenarios: number;
  execution: {
    fileParallelism: string | null;
    maxWorkers: string | null;
    mode: string;
    testNamePattern: string | null;
  };
  expectedScenarios: number;
  reports: readonly OutcomePerformanceScenarioReport[];
};

function assertFiniteNonNegativeBenchmarkNumber(
  value: unknown,
  label: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

function assertIsolatedOutcomeBenchmarkBaseline(report: OutcomeIsolatedBenchmarkReport): void {
  if (!report.complete) {
    throw new Error("isolated Outcome benchmark report must be complete");
  }
  if (
    report.expectedScenarios !== OUTCOME_PERFORMANCE_SCENARIOS.length ||
    report.completedScenarios !== OUTCOME_PERFORMANCE_SCENARIOS.length ||
    report.reports.length !== OUTCOME_PERFORMANCE_SCENARIOS.length
  ) {
    throw new Error("isolated Outcome benchmark must contain every P-01 scenario");
  }
  if (
    report.execution.mode !== "isolated-control" ||
    report.execution.maxWorkers !== "1" ||
    report.execution.fileParallelism !== "false" ||
    report.execution.testNamePattern !== OUTCOME_ISOLATED_BENCHMARK_TEST_NAME
  ) {
    throw new Error("isolated Outcome benchmark did not run under the required serial control");
  }
  const reportsByScenario = new Map<string, OutcomePerformanceScenarioReport>();
  for (const scenario of report.reports) {
    const key = `${scenario.recordCount}:${scenario.requestedRecordBytes}`;
    if (reportsByScenario.has(key)) {
      throw new Error(`isolated Outcome benchmark contains duplicate scenario ${key}`);
    }
    reportsByScenario.set(key, scenario);
  }
  for (const expected of OUTCOME_PERFORMANCE_SCENARIOS) {
    const key = `${expected.recordCount}:${expected.recordBytes}`;
    const scenario = reportsByScenario.get(key);
    if (!scenario) {
      throw new Error(`isolated Outcome benchmark is missing scenario ${key}`);
    }
    if (scenario.actualRecordBytes !== expected.recordBytes) {
      throw new Error(`isolated Outcome benchmark scenario ${key} has an unexpected record size`);
    }
    if (
      scenario.samples !== OUTCOME_PERFORMANCE_SAMPLES ||
      scenario.list.count !== OUTCOME_PERFORMANCE_SAMPLES ||
      scenario.mutation.count !== OUTCOME_PERFORMANCE_SAMPLES
    ) {
      throw new Error(`isolated Outcome benchmark scenario ${key} has an unexpected sample count`);
    }
    assertFiniteNonNegativeBenchmarkNumber(scenario.list.p95, `${key} list p95`);
    assertFiniteNonNegativeBenchmarkNumber(scenario.mutation.p95, `${key} mutation p95`);
    assertFiniteNonNegativeBenchmarkNumber(scenario.eventLoop.deltaMs, `${key} event-loop delta`);
    const withinTargets = {
      eventLoopLagDelta:
        scenario.eventLoop.deltaMs <= OUTCOME_PERFORMANCE_TARGETS_MS.eventLoopLagDelta,
      listP95: scenario.list.p95 <= OUTCOME_PERFORMANCE_TARGETS_MS.listP95,
      mutationP95: scenario.mutation.p95 <= OUTCOME_PERFORMANCE_TARGETS_MS.mutationP95,
    };
    if (
      !withinTargets.eventLoopLagDelta ||
      !withinTargets.listP95 ||
      !withinTargets.mutationP95 ||
      scenario.withinTargets.eventLoopLagDelta !== withinTargets.eventLoopLagDelta ||
      scenario.withinTargets.listP95 !== withinTargets.listP95 ||
      scenario.withinTargets.mutationP95 !== withinTargets.mutationP95
    ) {
      throw new Error(
        `isolated Outcome benchmark scenario ${key} exceeds or misreports its target`,
      );
    }
  }
}

function assertOutcomeBenchmarkForConfiguredExecution(
  report: OutcomeIsolatedBenchmarkReport,
): void {
  if (report.execution.mode === "isolated-control") {
    assertIsolatedOutcomeBenchmarkBaseline(report);
  }
}

function writeOutcomeBenchmarkArtifact(report: object): void {
  const artifactPath = process.env.OPENCLAW_OUTCOME_BENCHMARK_ARTIFACT_PATH;
  if (!artifactPath) {
    return;
  }
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function completeIsolatedOutcomeBenchmarkReport(): OutcomeIsolatedBenchmarkReport {
  return {
    complete: true,
    completedScenarios: OUTCOME_PERFORMANCE_SCENARIOS.length,
    execution: {
      fileParallelism: "false",
      maxWorkers: "1",
      mode: "isolated-control",
      testNamePattern: OUTCOME_ISOLATED_BENCHMARK_TEST_NAME,
    },
    expectedScenarios: OUTCOME_PERFORMANCE_SCENARIOS.length,
    reports: OUTCOME_PERFORMANCE_SCENARIOS.map((scenario) => ({
      actualRecordBytes: scenario.recordBytes,
      eventLoop: { deltaMs: 1 },
      list: { count: OUTCOME_PERFORMANCE_SAMPLES, p95: 10 },
      mutation: { count: OUTCOME_PERFORMANCE_SAMPLES, p95: 10 },
      recordCount: scenario.recordCount,
      requestedRecordBytes: scenario.recordBytes,
      samples: OUTCOME_PERFORMANCE_SAMPLES,
      withinTargets: { eventLoopLagDelta: true, listP95: true, mutationP95: true },
    })),
  };
}

function withFirstOutcomeBenchmarkScenario(
  report: OutcomeIsolatedBenchmarkReport,
  update: (scenario: OutcomePerformanceScenarioReport) => OutcomePerformanceScenarioReport,
): OutcomeIsolatedBenchmarkReport {
  return {
    ...report,
    reports: report.reports.map((scenario, index) => (index === 0 ? update(scenario) : scenario)),
  };
}

afterEach(() => resetPluginStateStoreForTests());

describe("Outcome repository host adapter", () => {
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
        await expect(repository.inspectCapacity()).resolves.toEqual({
          entryCount: 399,
          warnings: [],
        });
        const reopenedRepository = createOutcomeRepository(store);
        await expect(
          reopenedRepository.create(
            draftRecord(`capacity-${OUTCOME_CAPACITY_WARNING_ENTRIES - 1}`),
          ),
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
        for (
          let index = OUTCOME_CAPACITY_WARNING_ENTRIES;
          index < OUTCOME_MAX_ENTRIES;
          index += 1
        ) {
          await expect(
            reopenedRepository.create(draftRecord(`capacity-${index}`)),
          ).resolves.toEqual({
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
        await expect(
          reopenedRepository.create(draftRecord("capacity-overflow")),
        ).rejects.toMatchObject({
          code: "outcome-capacity-exceeded",
        });
        await expect(
          reopenedRepository.createOwned("alice", draftRecord("capacity-owned-overflow")),
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

  it("keeps normal performance reports diagnostic", () => {
    const report = completeIsolatedOutcomeBenchmarkReport();
    expect(() =>
      assertOutcomeBenchmarkForConfiguredExecution({
        ...report,
        execution: { ...report.execution, mode: "normal-shard" },
        reports: report.reports.slice(1),
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "an incomplete report",
      (report: OutcomeIsolatedBenchmarkReport) => ({ ...report, complete: false }),
      "must be complete",
    ],
    [
      "a missing scenario",
      (report: OutcomeIsolatedBenchmarkReport) => ({ ...report, reports: report.reports.slice(1) }),
      "must contain every P-01 scenario",
    ],
    [
      "an invalid execution",
      (report: OutcomeIsolatedBenchmarkReport) => ({
        ...report,
        execution: { ...report.execution, maxWorkers: "2" },
      }),
      "required serial control",
    ],
    [
      "a duplicate scenario",
      (report: OutcomeIsolatedBenchmarkReport) =>
        withFirstOutcomeBenchmarkScenario(report, (scenario) => ({
          ...scenario,
          actualRecordBytes: 96 * 1024,
          requestedRecordBytes: 96 * 1024,
        })),
      "contains duplicate scenario",
    ],
    [
      "an unexpected record size",
      (report: OutcomeIsolatedBenchmarkReport) =>
        withFirstOutcomeBenchmarkScenario(report, (scenario) => ({
          ...scenario,
          actualRecordBytes: scenario.actualRecordBytes - 1,
        })),
      "unexpected record size",
    ],
    [
      "an unexpected sample count",
      (report: OutcomeIsolatedBenchmarkReport) =>
        withFirstOutcomeBenchmarkScenario(report, (scenario) => ({
          ...scenario,
          samples: OUTCOME_PERFORMANCE_SAMPLES - 1,
        })),
      "unexpected sample count",
    ],
    [
      "an over-target p95",
      (report: OutcomeIsolatedBenchmarkReport) =>
        withFirstOutcomeBenchmarkScenario(report, (scenario) => ({
          ...scenario,
          list: { ...scenario.list, p95: OUTCOME_PERFORMANCE_TARGETS_MS.listP95 + 1 },
        })),
      "exceeds or misreports its target",
    ],
    [
      "an absent p95",
      (report: OutcomeIsolatedBenchmarkReport) =>
        withFirstOutcomeBenchmarkScenario(report, (scenario) => ({
          ...scenario,
          mutation: { ...scenario.mutation, p95: undefined },
        })),
      "must be a finite non-negative number",
    ],
    [
      "a non-finite timing",
      (report: OutcomeIsolatedBenchmarkReport) =>
        withFirstOutcomeBenchmarkScenario(report, (scenario) => ({
          ...scenario,
          mutation: { ...scenario.mutation, p95: Number.NaN },
        })),
      "must be a finite non-negative number",
    ],
  ])("fails closed for %s", (_label, mutate, error) => {
    expect(() =>
      assertIsolatedOutcomeBenchmarkBaseline(completeIsolatedOutcomeBenchmarkReport()),
    ).not.toThrow();
    expect(() =>
      assertIsolatedOutcomeBenchmarkBaseline(mutate(completeIsolatedOutcomeBenchmarkReport())),
    ).toThrow(error);
  });

  it("measures bounded host-adapter list and mutation behavior across the P-01 matrix", async () => {
    const reports: Array<{
      actualRecordBytes: number;
      eventLoop: { baselineMaxMs: number; maxMs: number; deltaMs: number; resolutionMs: number };
      heap: { afterBytes: number; beforeBytes: number; deltaBytes: number };
      list: ReturnType<typeof summarizeBenchmarkTimings>;
      listDiagnostics: {
        componentProbeScope: string;
        hostEntries: ReturnType<typeof summarizeBenchmarkTimings>;
        hostEntriesSamplesMs: number[];
        schemaAndHash: ReturnType<typeof summarizeBenchmarkTimings>;
        schemaAndHashSamplesMs: number[];
        sort: ReturnType<typeof summarizeBenchmarkTimings>;
        sortSamplesMs: number[];
      };
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
    const buildReport = (complete: boolean) => ({
      schemaVersion: 1,
      complete,
      expectedScenarios: OUTCOME_PERFORMANCE_SCENARIOS.length,
      completedScenarios: reports.length,
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
      execution: {
        fileParallelism: process.env.OPENCLAW_OUTCOME_BENCHMARK_FILE_PARALLELISM ?? null,
        maxWorkers: process.env.OPENCLAW_VITEST_MAX_WORKERS ?? null,
        mode: process.env.OPENCLAW_OUTCOME_BENCHMARK_MODE ?? "normal-shard",
        testNamePattern: process.env.OPENCLAW_OUTCOME_BENCHMARK_TEST_NAME_PATTERN ?? null,
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
    });

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
          expect(new Set(actualRecordBytes)).toEqual(new Set([scenario.recordBytes]));
          for (const record of records) {
            await expect(repository.create(record)).resolves.toEqual({ created: true });
          }
          const expectedIds = new Set(records.map((record) => record.id));
          const seeded = await repository.list();
          expect(seeded).toHaveLength(scenario.recordCount);
          expect(new Set(seeded.map((record) => record.id))).toEqual(expectedIds);

          const delay = monitorEventLoopDelay({ resolution: 10 });
          delay.enable();
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 20);
          });
          const baselineMaxMs = delay.max / 1_000_000;
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
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 20);
            });
            delay.disable();
          }

          const list = summarizeBenchmarkTimings(listTimings);
          const mutation = summarizeBenchmarkTimings(mutationTimings);
          const maxMs = delay.max / 1_000_000;
          const heapAfterBytes = process.memoryUsage().heapUsed;
          const hostEntriesSamplesMs: number[] = [];
          const schemaAndHashSamplesMs: number[] = [];
          const sortSamplesMs: number[] = [];
          for (let sample = 0; sample < OUTCOME_PERFORMANCE_SAMPLES; sample += 1) {
            const entriesStartedAt = performance.now();
            const entries = await store.entries();
            hostEntriesSamplesMs.push(performance.now() - entriesStartedAt);

            const schemaAndHashStartedAt = performance.now();
            const parsed = entries.map((entry) => parseOutcomeRecord(entry.value));
            schemaAndHashSamplesMs.push(performance.now() - schemaAndHashStartedAt);

            const sortStartedAt = performance.now();
            const sorted = parsed.toSorted(
              (left, right) =>
                right.updatedAt - left.updatedAt ||
                (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
            );
            sortSamplesMs.push(performance.now() - sortStartedAt);
            expect(sorted).toHaveLength(scenario.recordCount);
            expect(new Set(sorted.map((record) => record.id))).toEqual(expectedIds);
          }
          const hostEntries = summarizeBenchmarkTimings(hostEntriesSamplesMs);
          const schemaAndHash = summarizeBenchmarkTimings(schemaAndHashSamplesMs);
          const sort = summarizeBenchmarkTimings(sortSamplesMs);
          expect(list.count).toBe(OUTCOME_PERFORMANCE_SAMPLES);
          expect(mutation.count).toBe(OUTCOME_PERFORMANCE_SAMPLES);
          for (const timing of [
            ...listTimings,
            ...mutationTimings,
            ...hostEntriesSamplesMs,
            ...schemaAndHashSamplesMs,
            ...sortSamplesMs,
          ]) {
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
          const targetsMs = OUTCOME_PERFORMANCE_TARGETS_MS;
          const eventLoopDeltaMs = Math.max(0, maxMs - baselineMaxMs);
          reports.push({
            recordCount: scenario.recordCount,
            requestedRecordBytes: scenario.recordBytes,
            actualRecordBytes: actualRecordBytes[0] ?? 0,
            samples: OUTCOME_PERFORMANCE_SAMPLES,
            list,
            listDiagnostics: {
              componentProbeScope:
                "separate exact store read, strict parse/hash, and canonical sort probes; not additive to list timing",
              hostEntries,
              hostEntriesSamplesMs,
              schemaAndHash,
              schemaAndHashSamplesMs,
              sort,
              sortSamplesMs,
            },
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
          writeOutcomeBenchmarkArtifact(buildReport(false));
        }
      },
    );

    expect(reports).toHaveLength(OUTCOME_PERFORMANCE_SCENARIOS.length);
    const report = buildReport(true);
    writeOutcomeBenchmarkArtifact(report);
    assertOutcomeBenchmarkForConfiguredExecution(report);
    console.info(`[outcome-plugin-state-benchmark] ${JSON.stringify(report)}`);
  }, 300_000);
});
