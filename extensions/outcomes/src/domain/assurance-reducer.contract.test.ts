import { describe, expect, it } from "vitest";
import { deriveOutcomeClosure } from "../assurance/closure.js";
import { reduceOutcomeAcceptance, reduceOutcomeDecision } from "./assurance-reducer.js";
import { planHash } from "./canonical-plan.js";
import { createRequestHash, evidenceSetHash, workboardProjectionFingerprint } from "./hash.js";
import { reduceOutcomeContract, reduceOutcomeTitle, reduceOutcomeUnlink } from "./reducer.js";
import { parseOutcomeRecord } from "./schema.js";
import type { OutcomeRecord } from "./types.js";

function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error("fixture item missing");
  }
  return item;
}

function assuredActiveRecord(id = "assured-1"): OutcomeRecord {
  const ref = {
    owner: "workboard" as const,
    cardId: "card-1",
    cardCreatedAt: 1,
    boardIdAtLink: "board-1",
  };
  const criteria = [{ id: "c-1", text: "criterion", required: true, workRefs: [ref] }];
  const record: OutcomeRecord = {
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
    phase: "active",
    revision: 1,
    contractRevision: 1,
    planGeneration: 1,
    planHash: planHash({
      outcomeId: id,
      objective: "objective",
      contractRevision: 1,
      planGeneration: 1,
      criteria,
    }),
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
        sourceFingerprint: workboardProjectionFingerprint({
          ref,
          proofs: [{ sourceId: "proof-1", digest: "proof-digest-1" }],
          artifacts: [],
          currentBoardId: "board-current",
          status: "done",
          sourceUpdatedAt: 10,
        }),
      },
    ],
    evidence: [
      {
        id: "evidence-1",
        criterionId: "c-1",
        planGeneration: 1,
        workRef: ref,
        kind: "workboard-proof",
        sourceId: "proof-1",
        sourceDigest: "proof-digest-1",
        observedAt: 10,
      },
    ],
    decisions: [],
    operations: [],
    acceptances: [],
    createdAt: 1,
    updatedAt: 1,
  };
  return record;
}

describe("Outcome assurance history contract", () => {
  it("appends an immutable verified decision before accepting its current closure", () => {
    const record = assuredActiveRecord();
    const evidenceHash = evidenceSetHash({
      criterionId: "c-1",
      planGeneration: record.planGeneration,
      sourceDigests: ["proof-digest-1"],
    });
    const verified = reduceOutcomeDecision(record, {
      expectedRevision: record.revision,
      id: "decision-1",
      requestHash: "d".repeat(64),
      criterionId: "c-1",
      status: "verified",
      planHash: record.planHash!,
      evidenceSetHash: evidenceHash,
      profileId: record.managerProfileId,
      serverTime: 42,
    });
    expect(verified).toMatchObject({ kind: "updated", replayed: false });
    if (verified.kind !== "updated") {
      return;
    }
    const decision = first(verified.record.decisions);
    expect(decision).toMatchObject({
      decidedRevision: 2,
      planGeneration: 1,
      planHash: verified.record.planHash,
    });
    const closureHash = deriveOutcomeClosure(verified.record, verified.record.projections, 42);
    expect(closureHash).toMatch(/^[0-9a-f]{64}$/);
    if (closureHash === null || verified.record.planHash === null) {
      return;
    }
    const accepted = reduceOutcomeAcceptance(verified.record, {
      expectedRevision: verified.record.revision,
      id: "acceptance-1",
      requestHash: "a".repeat(64),
      planHash: verified.record.planHash,
      closureHash,
      profileId: verified.record.managerProfileId,
      serverTime: 43,
    });
    expect(accepted).toMatchObject({ kind: "updated", replayed: false });
    if (accepted.kind !== "updated") {
      return;
    }
    expect(accepted.record).toMatchObject({ phase: "accepted", revision: 3 });
    expect(first(accepted.record.acceptances)).toMatchObject({
      acceptedRevision: 3,
      acceptedPlan: decision.decidedPlan,
      closureHash,
    });
  });

  it("replays the same decision ID without a write and conflicts on a changed payload", () => {
    const record = assuredActiveRecord();
    const mutation = {
      expectedRevision: record.revision,
      id: "decision-replay",
      requestHash: "d".repeat(64),
      criterionId: "c-1",
      status: "verified" as const,
      planHash: record.planHash!,
      evidenceSetHash: evidenceSetHash({
        criterionId: "c-1",
        planGeneration: record.planGeneration,
        sourceDigests: ["proof-digest-1"],
      }),
      profileId: record.managerProfileId,
      serverTime: 42,
    };
    const committed = reduceOutcomeDecision(record, mutation);
    if (committed.kind !== "updated") {
      throw new Error("fixture decision did not commit");
    }
    expect(reduceOutcomeDecision(committed.record, mutation)).toMatchObject({
      kind: "updated",
      replayed: true,
      record: committed.record,
    });
    expect(
      reduceOutcomeDecision(committed.record, { ...mutation, requestHash: "e".repeat(64) }),
    ).toMatchObject({
      kind: "conflict",
      reason: "operation-conflict",
      replayed: false,
      record: committed.record,
    });
  });

  it("orders opposite decisions from the same millisecond by revision", () => {
    const record = assuredActiveRecord();
    const evidenceHash = evidenceSetHash({
      criterionId: "c-1",
      planGeneration: record.planGeneration,
      sourceDigests: ["proof-digest-1"],
    });
    const verified = reduceOutcomeDecision(record, {
      expectedRevision: record.revision,
      id: "decision-verified",
      requestHash: "d".repeat(64),
      criterionId: "c-1",
      status: "verified",
      planHash: record.planHash!,
      evidenceSetHash: evidenceHash,
      profileId: record.managerProfileId,
      serverTime: 42,
    });
    if (verified.kind !== "updated") {
      throw new Error("fixture verification did not commit");
    }
    const rejected = reduceOutcomeDecision(verified.record, {
      expectedRevision: verified.record.revision,
      id: "decision-rejected",
      requestHash: "e".repeat(64),
      criterionId: "c-1",
      status: "rejected",
      planHash: verified.record.planHash!,
      evidenceSetHash: evidenceHash,
      note: "The current evidence is insufficient",
      profileId: verified.record.managerProfileId,
      serverTime: 42,
    });

    expect(rejected).toMatchObject({ kind: "updated", replayed: false, record: { revision: 3 } });
    if (rejected.kind !== "updated") {
      return;
    }
    expect(
      rejected.record.decisions.map(({ id, decidedAt, decidedRevision, status }) => ({
        id,
        decidedAt,
        decidedRevision,
        status,
      })),
    ).toEqual([
      { id: "decision-verified", decidedAt: 42, decidedRevision: 2, status: "verified" },
      { id: "decision-rejected", decidedAt: 42, decidedRevision: 3, status: "rejected" },
    ]);
    expect(deriveOutcomeClosure(rejected.record, rejected.record.projections, 42)).toBeNull();
  });

  it("preserves actual decision and acceptance snapshots across later contract changes and unlink", () => {
    const initial = assuredActiveRecord();
    const verified = reduceOutcomeDecision(initial, {
      expectedRevision: initial.revision,
      id: "decision-history",
      requestHash: "d".repeat(64),
      criterionId: "c-1",
      status: "verified",
      planHash: initial.planHash!,
      evidenceSetHash: evidenceSetHash({
        criterionId: "c-1",
        planGeneration: initial.planGeneration,
        sourceDigests: ["proof-digest-1"],
      }),
      profileId: initial.managerProfileId,
      serverTime: 42,
    });
    if (verified.kind !== "updated") {
      throw new Error("fixture decision did not commit");
    }
    const closureHash = deriveOutcomeClosure(verified.record, verified.record.projections, 42);
    if (closureHash === null || verified.record.planHash === null) {
      throw new Error("fixture closure was not complete");
    }
    const accepted = reduceOutcomeAcceptance(verified.record, {
      expectedRevision: verified.record.revision,
      id: "acceptance-history",
      requestHash: "a".repeat(64),
      planHash: verified.record.planHash,
      closureHash,
      profileId: verified.record.managerProfileId,
      serverTime: 43,
    });
    if (accepted.kind !== "updated") {
      throw new Error("fixture acceptance did not commit");
    }
    const decisionSnapshot = structuredClone(first(accepted.record.decisions).decidedPlan);
    const acceptanceSnapshot = structuredClone(first(accepted.record.acceptances).acceptedPlan);
    const renamed = reduceOutcomeTitle(accepted.record, {
      expectedRevision: accepted.record.revision,
      title: "Renamed after acceptance",
      serverTime: 44,
    });
    if (renamed.kind !== "updated") {
      throw new Error("fixture title update did not commit");
    }
    expect(renamed.record.phase).toBe("accepted");
    expect(deriveOutcomeClosure(renamed.record, renamed.record.projections, 44)).toBe(closureHash);
    expect(first(renamed.record.decisions).decidedPlan).toEqual(decisionSnapshot);
    expect(first(renamed.record.acceptances).acceptedPlan).toEqual(acceptanceSnapshot);
    const changed = reduceOutcomeContract(renamed.record, {
      expectedRevision: renamed.record.revision,
      objective: "Revised after acceptance",
      criteria: renamed.record.criteria,
      serverTime: 45,
    });
    if (changed.kind !== "updated") {
      throw new Error("fixture contract update did not commit");
    }
    const unlinked = reduceOutcomeUnlink(changed.record, {
      expectedRevision: changed.record.revision,
      criterionId: "c-1",
      cardId: "card-1",
      serverTime: 46,
    });
    if (unlinked.kind !== "updated") {
      throw new Error("fixture unlink did not commit");
    }

    expect(unlinked.record.phase).toBe("active");
    expect(first(unlinked.record.decisions).decidedPlan).toEqual(decisionSnapshot);
    expect(first(unlinked.record.acceptances).acceptedPlan).toEqual(acceptanceSnapshot);
    expect(parseOutcomeRecord(unlinked.record)).toEqual(unlinked.record);
  });

  it("rejects a decision whose client plan guard differs without changing the record", () => {
    const record = assuredActiveRecord();
    const result = reduceOutcomeDecision(record, {
      expectedRevision: record.revision,
      id: "decision-wrong-plan",
      requestHash: "d".repeat(64),
      criterionId: "c-1",
      status: "verified",
      planHash: "f".repeat(64),
      evidenceSetHash: evidenceSetHash({
        criterionId: "c-1",
        planGeneration: record.planGeneration,
        sourceDigests: ["proof-digest-1"],
      }),
      profileId: record.managerProfileId,
      serverTime: 42,
    });

    expect(result).toEqual({
      kind: "rejected",
      reason: "revision-conflict",
      replayed: false,
      record,
    });
  });
});
