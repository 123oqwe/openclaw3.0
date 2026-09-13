import {
  currentOutcomeEvidenceSourceDigests,
  deriveOutcomeClosure,
} from "../assurance/closure.js";
import { evidenceSetHash } from "./hash.js";
import {
  assertOutcomeServerTime,
  currentOutcomePlanSnapshot,
  reduceOutcomeRefresh,
} from "./reducer.js";
import type { EvidenceRef, OutcomeRecord, WorkProjection } from "./types.js";

export type OutcomeDecisionMutation = {
  expectedRevision: number;
  id: string;
  requestHash: string;
  criterionId: string;
  status: "verified" | "rejected";
  planHash: string;
  evidenceSetHash: string;
  profileId: string;
  note?: string;
  projections?: WorkProjection[];
  evidence?: EvidenceRef[];
  serverTime: number;
};

export type OutcomeAcceptanceMutation = {
  expectedRevision: number;
  id: string;
  requestHash: string;
  planHash: string;
  closureHash: string;
  profileId: string;
  projections?: WorkProjection[];
  evidence?: EvidenceRef[];
  serverTime: number;
};

export type OutcomeAssuranceFailureReason =
  | "operation-conflict"
  | "revision-conflict"
  | "invalid-state"
  | "closure-incomplete"
  | "capacity-exceeded";

export type OutcomeDecisionResult =
  | { kind: "updated"; record: OutcomeRecord; replayed: boolean }
  | {
      kind: "conflict" | "rejected";
      reason: OutcomeAssuranceFailureReason;
      record: OutcomeRecord;
      replayed: boolean;
    };

export type OutcomeAcceptanceResult =
  | { kind: "updated"; record: OutcomeRecord; replayed: boolean }
  | {
      kind: "conflict" | "rejected";
      reason: OutcomeAssuranceFailureReason;
      record: OutcomeRecord;
      replayed: boolean;
    };

/** Append one immutable human decision without deriving it from a later record state. */
export function reduceOutcomeDecision(
  current: OutcomeRecord,
  mutation: OutcomeDecisionMutation,
): OutcomeDecisionResult {
  assertOutcomeServerTime(mutation.serverTime);
  const previous = current.decisions.find((decision) => decision.id === mutation.id);
  if (previous !== undefined) {
    if (previous.requestHash === mutation.requestHash) {
      return { kind: "updated", record: current, replayed: true };
    }
    return {
      kind: "conflict",
      reason: "operation-conflict",
      record: current,
      replayed: false,
    };
  }
  if (mutation.expectedRevision !== current.revision) {
    return { kind: "conflict", reason: "revision-conflict", record: current, replayed: false };
  }
  if ((mutation.projections === undefined) !== (mutation.evidence === undefined)) {
    return { kind: "rejected", reason: "closure-incomplete", record: current, replayed: false };
  }
  const refreshed =
    mutation.projections === undefined || mutation.evidence === undefined
      ? undefined
      : reduceOutcomeRefresh(current, {
          expectedRevision: current.revision,
          projections: mutation.projections,
          evidence: mutation.evidence,
          serverTime: mutation.serverTime,
        });
  if (refreshed !== undefined && refreshed.kind !== "updated") {
    return {
      kind: "rejected",
      reason:
        refreshed.kind === "rejected" && refreshed.reason === "capacity-exceeded"
          ? "capacity-exceeded"
          : "revision-conflict",
      record: current,
      replayed: false,
    };
  }
  const observed =
    refreshed === undefined
      ? current
      : { ...refreshed.record, revision: current.revision, updatedAt: current.updatedAt };
  if (observed.phase !== "active" && observed.phase !== "accepted") {
    return { kind: "rejected", reason: "invalid-state", record: current, replayed: false };
  }
  const criterion = observed.criteria.find((item) => item.id === mutation.criterionId);
  if (criterion === undefined || observed.planHash === null) {
    return { kind: "rejected", reason: "invalid-state", record: current, replayed: false };
  }
  const sourceDigests = currentOutcomeEvidenceSourceDigests(
    observed,
    criterion,
    observed.projections,
    mutation.serverTime,
  );
  if (sourceDigests === undefined) {
    return { kind: "rejected", reason: "closure-incomplete", record: current, replayed: false };
  }
  const currentEvidenceSetHash = evidenceSetHash({
    criterionId: criterion.id,
    planGeneration: observed.planGeneration,
    sourceDigests,
  });
  if (mutation.planHash !== observed.planHash || mutation.evidenceSetHash !== currentEvidenceSetHash) {
    return { kind: "rejected", reason: "revision-conflict", record: current, replayed: false };
  }
  if (
    (mutation.status === "verified" && sourceDigests.length === 0) ||
    (mutation.status === "rejected" && mutation.note === undefined)
  ) {
    return { kind: "rejected", reason: "closure-incomplete", record: current, replayed: false };
  }
  if (observed.decisions.length >= 100) {
    return { kind: "rejected", reason: "capacity-exceeded", record: current, replayed: false };
  }
  const decidedRevision = current.revision + 1;
  const decision = {
    id: mutation.id,
    requestHash: mutation.requestHash,
    criterionId: criterion.id,
    status: mutation.status,
    evidenceSetHash: mutation.evidenceSetHash,
    profileId: mutation.profileId,
    decidedAt: mutation.serverTime,
    decidedRevision,
    planGeneration: observed.planGeneration,
    planHash: observed.planHash,
    decidedPlan: currentOutcomePlanSnapshot(observed),
    ...(mutation.note === undefined ? {} : { note: mutation.note }),
  };
  return {
    kind: "updated",
    replayed: false,
    record: {
      ...observed,
      decisions: [...observed.decisions, decision],
      revision: decidedRevision,
      updatedAt: mutation.serverTime,
    },
  };
}

/** Append one accepted closure snapshot after a fresh server-side closure check. */
export function reduceOutcomeAcceptance(
  current: OutcomeRecord,
  mutation: OutcomeAcceptanceMutation,
): OutcomeAcceptanceResult {
  assertOutcomeServerTime(mutation.serverTime);
  const previous = current.acceptances.find((acceptance) => acceptance.id === mutation.id);
  if (previous !== undefined) {
    if (previous.requestHash === mutation.requestHash) {
      return { kind: "updated", record: current, replayed: true };
    }
    return {
      kind: "conflict",
      reason: "operation-conflict",
      record: current,
      replayed: false,
    };
  }
  if (mutation.expectedRevision !== current.revision) {
    return { kind: "conflict", reason: "revision-conflict", record: current, replayed: false };
  }
  if ((mutation.projections === undefined) !== (mutation.evidence === undefined)) {
    return { kind: "rejected", reason: "closure-incomplete", record: current, replayed: false };
  }
  const refreshed =
    mutation.projections === undefined || mutation.evidence === undefined
      ? undefined
      : reduceOutcomeRefresh(current, {
          expectedRevision: current.revision,
          projections: mutation.projections,
          evidence: mutation.evidence,
          serverTime: mutation.serverTime,
        });
  if (refreshed !== undefined && refreshed.kind !== "updated") {
    return {
      kind: "rejected",
      reason:
        refreshed.kind === "rejected" && refreshed.reason === "capacity-exceeded"
          ? "capacity-exceeded"
          : "revision-conflict",
      record: current,
      replayed: false,
    };
  }
  const observed =
    refreshed === undefined
      ? current
      : { ...refreshed.record, revision: current.revision, updatedAt: current.updatedAt };
  if ((observed.phase !== "active" && observed.phase !== "accepted") || observed.planHash === null) {
    return { kind: "rejected", reason: "invalid-state", record: current, replayed: false };
  }
  const closureHash = deriveOutcomeClosure(observed, observed.projections, mutation.serverTime);
  if (closureHash === null) {
    return { kind: "rejected", reason: "closure-incomplete", record: current, replayed: false };
  }
  if (mutation.planHash !== observed.planHash || mutation.closureHash !== closureHash) {
    return { kind: "rejected", reason: "revision-conflict", record: current, replayed: false };
  }
  if (
    observed.acceptances.some(
      (acceptance) =>
        acceptance.planGeneration === observed.planGeneration &&
        acceptance.planHash === observed.planHash &&
        acceptance.closureHash === closureHash,
    )
  ) {
    return { kind: "rejected", reason: "invalid-state", record: current, replayed: false };
  }
  if (observed.acceptances.length >= 20) {
    return { kind: "rejected", reason: "capacity-exceeded", record: current, replayed: false };
  }
  const acceptedRevision = current.revision + 1;
  const acceptance = {
    id: mutation.id,
    requestHash: mutation.requestHash,
    acceptedRevision,
    profileId: mutation.profileId,
    acceptedAt: mutation.serverTime,
    planGeneration: observed.planGeneration,
    planHash: observed.planHash,
    closureHash,
    acceptedPlan: currentOutcomePlanSnapshot(observed),
  };
  return {
    kind: "updated",
    replayed: false,
    record: {
      ...observed,
      phase: "accepted",
      acceptances: [...observed.acceptances, acceptance],
      revision: acceptedRevision,
      updatedAt: mutation.serverTime,
    },
  };
}
