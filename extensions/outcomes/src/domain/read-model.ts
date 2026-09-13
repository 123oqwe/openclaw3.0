import { OUTCOME_PROJECTION_MAX_AGE_MS } from "@openclaw/outcomes-contract";
import type { OutcomeDetail, OutcomePlanSnapshotView, OutcomeSummary } from "@openclaw/outcomes-contract";
import { deriveOutcomeAttention } from "../assurance/attention.js";
import {
  currentOutcomeDecision,
  currentOutcomeProjections,
  deriveOutcomeClosure,
  isStaleOutcomeProjection,
} from "../assurance/closure.js";
import { evidenceSetHash } from "./hash.js";
import type { OutcomeRecord } from "./types.js";

type CurrentProjection = OutcomeRecord["projections"][number];

function workRefIdentity(ref: OutcomeRecord["criteria"][number]["workRefs"][number]): string {
  return `${ref.cardId}\0${ref.cardCreatedAt}`;
}

function withObservedEvidence(
  record: OutcomeRecord,
  evidence: OutcomeRecord["evidence"],
): OutcomeRecord {
  return evidence === record.evidence ? record : { ...record, evidence };
}

/**
 * Ephemeral data from one authorized Workboard read. It is deliberately not a
 * persisted DTO: callers that have no current owner read pass no material and
 * receive the restricted view below.
 */
export type AuthorizedOutcomeSource = {
  ref: OutcomeRecord["criteria"][number]["workRefs"][number];
  currentBoardId: string;
  status: string;
  sourceUpdatedAt: number;
  upstreamStale: boolean;
  evidence: OutcomeDetail["evidence"];
};

function toOutcomePlanSnapshotView(
  plan: OutcomeRecord["decisions"][number]["decidedPlan"],
  visibleRefIdentities: ReadonlySet<string>,
): OutcomePlanSnapshotView {
  return {
    outcomeId: plan.outcomeId,
    objective: plan.objective,
    contractRevision: plan.contractRevision,
    planGeneration: plan.planGeneration,
    criteria: plan.criteria.map((criterion) => {
      const workRefs = criterion.workRefs.filter((ref) =>
        visibleRefIdentities.has(workRefIdentity(ref)),
      );
      return {
        id: criterion.id,
        text: criterion.text,
        required: criterion.required,
        workRefs,
        sourcesVisibility: workRefs.length === criterion.workRefs.length ? "complete" : "restricted",
      };
    }),
  };
}

/** Build the redacted P-01 summary without exposing the persisted aggregate. */
export function toOutcomeSummary(
  record: OutcomeRecord,
  observedAt: number,
  projections: CurrentProjection[] = currentOutcomeProjections(record),
  observedEvidence: OutcomeRecord["evidence"] = record.evidence,
): OutcomeSummary {
  const observedRecord = withObservedEvidence(record, observedEvidence);
  const closureHash = deriveOutcomeClosure(observedRecord, projections, observedAt);
  const hasUnavailableSource = projections.some(
    (projection) =>
      projection.availability !== "available" ||
      ["workboard-disabled", "not-found", "forbidden", "timeout", "invalid-response"].includes(
        projection.errorCode ?? "",
      ),
  );
  const hasStaleSource = projections.some((projection) =>
    isStaleOutcomeProjection(projection, observedAt),
  );
  const hasBlockedSource = projections.some((projection) => projection.status === "blocked");
  const hasUncertainOperation = observedRecord.operations.some((operation) =>
    ["prepared", "may-have-crossed", "unknown"].includes(operation.state),
  );
  const hasCurrentRejectedDecision = observedRecord.criteria.some(
    (criterion) =>
      currentOutcomeDecision(observedRecord, criterion, projections, observedAt)?.decision.status === "rejected",
  );
  const readiness = hasUnavailableSource
    ? "unavailable"
    : hasStaleSource
      ? "stale"
      : hasBlockedSource ||
          hasUncertainOperation ||
          hasCurrentRejectedDecision ||
          observedRecord.phase === "cancelled"
        ? "blocked"
        : closureHash === null
          ? "incomplete"
          : "ready";
  const latestAcceptance = observedRecord.acceptances.toSorted(
    (left, right) => right.acceptedRevision - left.acceptedRevision,
  )[0];
  const acceptanceValidity =
    latestAcceptance === undefined
      ? "none"
      : closureHash !== null &&
          latestAcceptance.planGeneration === observedRecord.planGeneration &&
          latestAcceptance.planHash === observedRecord.planHash &&
          latestAcceptance.closureHash === closureHash
        ? "current"
        : "needs-review";
  return {
    id: observedRecord.id,
    title: observedRecord.title,
    phase: observedRecord.phase,
    revision: observedRecord.revision,
    updatedAt: observedRecord.updatedAt,
    readiness,
    acceptanceValidity,
  };
}

/** Build the public detail view; persistence identity and internal history stay private. */
export function toOutcomeDetail(
  record: OutcomeRecord,
  observedAt: number,
  authorizedSources: AuthorizedOutcomeSource[] = [],
  observedProjections: CurrentProjection[] = currentOutcomeProjections(record),
  observedEvidence: OutcomeRecord["evidence"] = record.evidence,
  visibleHistoricalRefs: OutcomeRecord["criteria"][number]["workRefs"] = [],
): OutcomeDetail {
  const observedRecord = withObservedEvidence(record, observedEvidence);
  const summary = toOutcomeSummary(record, observedAt, observedProjections, observedEvidence);
  const sourcesByRef = new Map(
    authorizedSources.map((source) => [workRefIdentity(source.ref), source]),
  );
  const visibleSnapshotRefIdentities = new Set([
    ...sourcesByRef.keys(),
    ...visibleHistoricalRefs.map(workRefIdentity),
  ]);
  const projectionsByRef = new Map(
    observedProjections.map((projection) => [workRefIdentity(projection.ref), projection]),
  );
  const criteria = record.criteria.map((criterion) => ({
    ...(() => {
      const visibleRefs = criterion.workRefs.filter((ref) =>
        sourcesByRef.has(workRefIdentity(ref)),
      );
      const sourcesComplete = visibleRefs.length === criterion.workRefs.length;
      const sourcesCurrent = sourcesComplete && visibleRefs.every((ref) => {
        const projection = projectionsByRef.get(workRefIdentity(ref));
        return (
          projection !== undefined &&
          projection.availability === "available" &&
          !isStaleOutcomeProjection(projection, observedAt)
        );
      });
      const sourceDigests = sourcesComplete
        ? visibleRefs.flatMap((ref) =>
            (sourcesByRef.get(workRefIdentity(ref))?.evidence ?? [])
              .filter(
                (evidence) =>
                  evidence.criterionId === criterion.id &&
                  evidence.planGeneration === record.planGeneration,
              )
              .map((evidence) => evidence.sourceDigest),
          )
        : [];
      return {
        id: criterion.id,
        text: criterion.text,
        required: criterion.required,
        workRefs: sourcesComplete ? visibleRefs : [],
        sourcesVisibility: sourcesComplete ? ("complete" as const) : ("restricted" as const),
        evidenceSetHash:
          record.phase !== "draft" &&
          record.phase !== "cancelled" &&
          sourcesCurrent &&
          criterion.workRefs.length > 0
            ? evidenceSetHash({
                criterionId: criterion.id,
                planGeneration: record.planGeneration,
                sourceDigests,
              })
            : null,
      };
    })(),
  }));
  const work: OutcomeDetail["work"] = authorizedSources
    .map((source) => ({
      ref: source.ref,
      currentBoardId: source.currentBoardId,
      status: source.status,
      observedAt,
      sourceUpdatedAt: source.sourceUpdatedAt,
      lastSuccessfulAt: projectionsByRef.get(workRefIdentity(source.ref))?.lastSuccessfulAt,
      upstreamStale: source.upstreamStale,
    }))
    .toSorted((left, right) => {
      const leftIdentity = workRefIdentity(left.ref);
      const rightIdentity = workRefIdentity(right.ref);
      return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
    });
  const evidence: OutcomeDetail["evidence"] = authorizedSources
    .flatMap((source) => source.evidence)
    .filter((item) => item.planGeneration === record.planGeneration)
    .toSorted(
      (left, right) =>
        (left.criterionId < right.criterionId
          ? -1
          : left.criterionId > right.criterionId
            ? 1
            : 0) ||
        (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0) ||
        (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0),
    );
  const decisions: OutcomeDetail["decisions"] = record.decisions
    .toSorted((left, right) => right.decidedRevision - left.decidedRevision)
    .map((decision) => ({
      id: decision.id,
      criterionId: decision.criterionId,
      status: decision.status,
      evidenceSetHash: decision.evidenceSetHash,
      decidedAt: decision.decidedAt,
      decidedRevision: decision.decidedRevision,
      planGeneration: decision.planGeneration,
      planHash: decision.planHash,
      decidedPlan: toOutcomePlanSnapshotView(decision.decidedPlan, visibleSnapshotRefIdentities),
      ...(decision.note === undefined ? {} : { note: decision.note }),
    }));
  const acceptances: OutcomeDetail["acceptances"] = record.acceptances
    .toSorted((left, right) => right.acceptedRevision - left.acceptedRevision)
    .map((acceptance) => ({
      id: acceptance.id,
      acceptedAt: acceptance.acceptedAt,
      acceptedRevision: acceptance.acceptedRevision,
      planGeneration: acceptance.planGeneration,
      planHash: acceptance.planHash,
      closureHash: acceptance.closureHash,
      acceptedPlan: toOutcomePlanSnapshotView(acceptance.acceptedPlan, visibleSnapshotRefIdentities),
    }));
  const sourceIssues = observedProjections
    .flatMap((projection) => {
      const linkedCriteria = record.criteria.filter((item) =>
        item.workRefs.some((ref) => workRefIdentity(ref) === workRefIdentity(projection.ref)),
      );
      const reason = projection.errorCode;
      return reason
        ? linkedCriteria.map((criterion) => ({ criterionId: criterion.id, reason }))
        : [];
    })
    .filter(
      (issue, index, issues) =>
        issues.findIndex(
          (candidate) =>
            candidate.criterionId === issue.criterionId && candidate.reason === issue.reason,
        ) === index,
    );
  const recheckAfter = observedProjections
    .filter(
      (projection) =>
        projection.availability === "available" &&
        projection.upstreamStale !== true &&
        projection.lastSuccessfulAt !== undefined,
    )
    .map((projection) => projection.lastSuccessfulAt! + OUTCOME_PROJECTION_MAX_AGE_MS)
    .reduce<number | null>(
      (earliest, candidate) => (earliest === null || candidate < earliest ? candidate : earliest),
      null,
    );
  const closureHash = deriveOutcomeClosure(observedRecord, observedProjections, observedAt);
  return {
    ...summary,
    objective: record.objective,
    contractRevision: record.contractRevision,
    planGeneration: record.planGeneration,
    planHash: record.planHash,
    createdAt: record.createdAt,
    criteria,
    work,
    evidence,
    decisions,
    acceptances,
    sourceIssues,
    acceptance: {
      acceptanceValidity: summary.acceptanceValidity,
      ...(summary.acceptanceValidity === "needs-review"
        ? {
            reason: summary.readiness === "stale" ? ("stale" as const) : ("not-rechecked" as const),
          }
        : {}),
    },
    observedAt,
    recheckAfter,
    closureHash,
    ...deriveOutcomeAttention(observedRecord, observedProjections, observedAt, closureHash),
  };
}
