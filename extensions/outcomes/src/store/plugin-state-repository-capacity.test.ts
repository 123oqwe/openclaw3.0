import { randomUUID } from "node:crypto";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it } from "vitest";
import { deriveOutcomeClosure } from "../assurance/closure.js";
import {
  reduceOutcomeAcceptance,
  reduceOutcomeDecision,
  type OutcomeAcceptanceResult,
  type OutcomeDecisionResult,
} from "../domain/assurance-reducer.js";
import { OUTCOME_MAX_ENTRIES } from "../domain/constants.js";
import {
  createRequestHash,
  evidenceSetHash,
  planHash,
  workboardProjectionFingerprint,
} from "../domain/schema.js";
import type { OutcomeRecord } from "../domain/types.js";
import { createOutcomeRepository } from "./plugin-state-repository.js";

function draftRecord(id: string): OutcomeRecord {
  const criteria = [{ id: "c-1", text: "criterion", required: true, workRefs: [] }];
  return {
    schemaVersion: 1,
    id,
    createRequestHash: createRequestHash({ id, title: "same", objective: "objective", criteria }),
    managerProfileId: "alice",
    title: "same",
    objective: "objective",
    phase: "draft",
    revision: 1,
    contractRevision: 1,
    planGeneration: 0,
    planHash: null,
    criteria,
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

function assuredActiveRecord(id: string): OutcomeRecord {
  const draft = draftRecord(id);
  const ref = {
    owner: "workboard" as const,
    cardId: "card-1",
    cardCreatedAt: 1,
    boardIdAtLink: "board-1",
  };
  const criteria = [{ ...draft.criteria[0]!, workRefs: [ref] }];
  const planGeneration = 1;
  const activePlanHash = planHash({
    outcomeId: draft.id,
    objective: draft.objective,
    contractRevision: draft.contractRevision,
    planGeneration,
    criteria,
  });
  return {
    ...draft,
    phase: "active",
    revision: 2,
    planGeneration,
    planHash: activePlanHash,
    criteria,
    projections: [
      {
        ref,
        availability: "available",
        currentBoardId: "board-current",
        status: "done",
        observedAt: 10,
        lastSuccessfulAt: 10,
        sourceUpdatedAt: 10,
        proofs: [{ sourceId: "proof-1", digest: "proof-digest-1" }],
        artifacts: [],
      },
    ],
    evidence: [
      {
        id: "evidence-1",
        criterionId: "c-1",
        planGeneration,
        workRef: ref,
        kind: "workboard-proof",
        sourceId: "proof-1",
        sourceDigest: "proof-digest-1",
        observedAt: 10,
      },
    ],
  };
}

afterEach(() => resetPluginStateStoreForTests());

describe("Outcome repository capacity and create races", () => {
  it("commits one record when identical owner creates race", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-create-race", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: OUTCOME_MAX_ENTRIES,
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
          maxEntries: OUTCOME_MAX_ENTRIES,
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

  it("performs zero host writes when decision or acceptance history is full", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-assurance-capacity", applyEnv: false },
      async (state) => {
        const createObservedRepository = (namespace: string) => {
          const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
            namespace,
            maxEntries: OUTCOME_MAX_ENTRIES,
            overflowPolicy: "reject-new",
            env: state.env,
          });
          const updates: Array<OutcomeRecord | undefined> = [];
          return {
            repository: createOutcomeRepository({
              ...store,
              update: async (id, callback) =>
                store.update!(id, (current) => {
                  const next = callback(current);
                  updates.push(next);
                  return next;
                }),
            }),
            updates,
          };
        };
        const decisionNamespace = `outcomes-v1-${randomUUID()}`;
        const { repository: decisionRepository, updates: decisionUpdates } =
          createObservedRepository(decisionNamespace);
        const decisionRecord = assuredActiveRecord("decision-capacity");
        const decisionPlan = {
          outcomeId: decisionRecord.id,
          objective: decisionRecord.objective,
          contractRevision: decisionRecord.contractRevision,
          planGeneration: decisionRecord.planGeneration,
          criteria: decisionRecord.criteria,
        };
        const decisionEvidenceHash = evidenceSetHash({
          criterionId: "c-1",
          planGeneration: decisionRecord.planGeneration,
          sourceDigests: ["proof-digest-1"],
        });
        const fullDecisionHistory: OutcomeRecord["decisions"] = Array.from(
          { length: 100 },
          (_, index) => ({
            id: `decision-${index + 1}`,
            criterionId: "c-1",
            planGeneration: decisionRecord.planGeneration,
            decidedRevision: index + 1,
            status: "verified",
            requestHash: `${(index + 1).toString(16).padStart(2, "0")}${"a".repeat(62)}`,
            profileId: "alice",
            planHash: planHash(decisionPlan),
            decidedPlan: decisionPlan,
            evidenceSetHash: decisionEvidenceHash,
            decidedAt: index + 1,
          }),
        );
        const fullDecisions = {
          ...decisionRecord,
          revision: 101,
          updatedAt: 101,
          decisions: fullDecisionHistory,
        };
        await decisionRepository.create(fullDecisions);
        const decisionResult = await decisionRepository.transact<OutcomeDecisionResult>(
          fullDecisions.id,
          (current) => {
            const decision = reduceOutcomeDecision(current!, {
              expectedRevision: current!.revision,
              id: "decision-101",
              requestHash: "b".repeat(64),
              criterionId: "c-1",
              status: "verified",
              planHash: current!.planHash!,
              evidenceSetHash: decisionEvidenceHash,
              profileId: "alice",
              serverTime: 102,
            });
            return decision.kind === "updated"
              ? { result: decision, next: decision.record }
              : { result: decision };
          },
        );
        expect(decisionResult).toMatchObject({ kind: "rejected", reason: "capacity-exceeded" });
        expect(decisionUpdates).toEqual([undefined]);
        await expect(decisionRepository.get(fullDecisions.id)).resolves.toEqual(fullDecisions);

        const acceptanceNamespace = `outcomes-v1-${randomUUID()}`;
        const { repository: acceptanceRepository, updates: acceptanceUpdates } =
          createObservedRepository(acceptanceNamespace);
        const acceptanceRecord = assuredActiveRecord("acceptance-capacity");
        const activePlanGeneration = 21;
        const activeContractRevision = 21;
        const activePlan = {
          outcomeId: acceptanceRecord.id,
          objective: acceptanceRecord.objective,
          contractRevision: activeContractRevision,
          planGeneration: activePlanGeneration,
          criteria: acceptanceRecord.criteria,
        };
        const fullAcceptanceHistory: OutcomeRecord["acceptances"] = Array.from(
          { length: 20 },
          (_, index) => {
            const planGeneration = index + 1;
            const acceptedPlan = {
              outcomeId: acceptanceRecord.id,
              objective: acceptanceRecord.objective,
              contractRevision: planGeneration,
              planGeneration,
              criteria: acceptanceRecord.criteria,
            };
            return {
              id: `acceptance-${planGeneration}`,
              requestHash: `${planGeneration.toString(16).padStart(2, "0")}${"c".repeat(62)}`,
              acceptedRevision: planGeneration,
              profileId: "alice",
              acceptedAt: planGeneration,
              planGeneration,
              planHash: planHash(acceptedPlan),
              closureHash: "d".repeat(64),
              acceptedPlan,
            };
          },
        );
        const fullAcceptances: OutcomeRecord = {
          ...acceptanceRecord,
          contractRevision: activeContractRevision,
          planGeneration: activePlanGeneration,
          planHash: planHash(activePlan),
          revision: 100,
          updatedAt: 100,
          projections: acceptanceRecord.projections.map((projection) => ({
            ref: projection.ref,
            availability: projection.availability,
            observedAt: projection.observedAt,
            proofs: projection.proofs,
            artifacts: projection.artifacts,
            ...(projection.currentBoardId === undefined
              ? {}
              : { currentBoardId: projection.currentBoardId }),
            ...(projection.status === undefined ? {} : { status: projection.status }),
            ...(projection.lastSuccessfulAt === undefined
              ? {}
              : { lastSuccessfulAt: projection.lastSuccessfulAt }),
            ...(projection.sourceUpdatedAt === undefined
              ? {}
              : { sourceUpdatedAt: projection.sourceUpdatedAt }),
            ...(projection.upstreamStale === undefined
              ? {}
              : { upstreamStale: projection.upstreamStale }),
            ...(projection.sourceFingerprint === undefined
              ? {}
              : { sourceFingerprint: projection.sourceFingerprint }),
            ...(projection.errorCode === undefined ? {} : { errorCode: projection.errorCode }),
          })),
          evidence: acceptanceRecord.evidence.map((evidence) => ({
            id: evidence.id,
            criterionId: evidence.criterionId,
            planGeneration: activePlanGeneration,
            workRef: evidence.workRef,
            kind: evidence.kind,
            sourceId: evidence.sourceId,
            sourceDigest: evidence.sourceDigest,
            observedAt: evidence.observedAt,
          })),
          acceptances: fullAcceptanceHistory,
        };
        await acceptanceRepository.create(fullAcceptances);
        const currentEvidenceHash = evidenceSetHash({
          criterionId: "c-1",
          planGeneration: activePlanGeneration,
          sourceDigests: ["proof-digest-1"],
        });
        const verified = await acceptanceRepository.transact<OutcomeDecisionResult>(
          fullAcceptances.id,
          (current) => {
            const decision = reduceOutcomeDecision(current!, {
              expectedRevision: current!.revision,
              id: "decision-current",
              requestHash: "e".repeat(64),
              criterionId: "c-1",
              status: "verified",
              planHash: current!.planHash!,
              evidenceSetHash: currentEvidenceHash,
              profileId: "alice",
              serverTime: 101,
            });
            return decision.kind === "updated"
              ? { result: decision, next: decision.record }
              : { result: decision };
          },
        );
        expect(verified).toMatchObject({ kind: "updated", replayed: false });
        if (verified.kind !== "updated" || verified.record.planHash === null) {
          throw new Error("fixture must create a current verified decision");
        }
        const closureHash = deriveOutcomeClosure(verified.record, verified.record.projections, 101);
        if (closureHash === null) {
          throw new Error("fixture closure must be complete");
        }
        const acceptanceResult = await acceptanceRepository.transact<OutcomeAcceptanceResult>(
          fullAcceptances.id,
          (current) => {
            const decision = reduceOutcomeAcceptance(current!, {
              expectedRevision: current!.revision,
              id: "acceptance-21",
              requestHash: "f".repeat(64),
              planHash: current!.planHash!,
              closureHash,
              profileId: "alice",
              serverTime: 102,
            });
            return decision.kind === "updated"
              ? { result: decision, next: decision.record }
              : { result: decision };
          },
        );
        expect(acceptanceResult).toMatchObject({ kind: "rejected", reason: "capacity-exceeded" });
        expect(acceptanceUpdates).toEqual([verified.record, undefined]);
        await expect(acceptanceRepository.get(fullAcceptances.id)).resolves.toEqual(
          verified.record,
        );
      },
    );
  });
});
