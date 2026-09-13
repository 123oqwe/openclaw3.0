import { OUTCOME_PROJECTION_MAX_AGE_MS } from "@openclaw/outcomes-contract";
import type { OutcomeDetail, OutcomePlanSnapshotView, OutcomeSummary } from "@openclaw/outcomes-contract";
import { deriveOutcomeAttention } from "../assurance/attention.js";
import {
  currentOutcomeDecision,
  currentOutcomeEvidenceSourceDigests,
  currentOutcomeProjections,
  deriveOutcomeClosure,
  isStaleOutcomeProjection,
} from "../assurance/closure.js";
import { evidenceSetHash } from "./hash.js";
import type { OutcomeRecord } from "./types.js";

type CurrentProjection = OutcomeRecord["projections"][number];

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
  sourcesByRef: ReadonlyMap<string, AuthorizedOutcomeSource>,
): OutcomePlanSnapshotView {
  return {
    outcomeId: plan.outcomeId,
    objective: plan.objective,
    contractRevision: plan.contractRevision,
    planGeneration: plan.planGeneration,
    criteria: plan.criteria.map((criterion) => {
      const workRefs = criterion.workRefs.filter((ref) => sourcesByRef.has(workRefIdentity(ref)));
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
): OutcomeSummary {
  const closureHash = deriveOutcomeClosure(record, projections, observedAt);
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
  const hasUncertainOperation = record.operations.some((operation) =>
    ["prepared", "may-have-crossed", "unknown"].includes(operation.state),
  );
  const hasCurrentRejectedDecision = record.criteria.some(
    (criterion) =>
      currentOutcomeDecision(record, criterion, projections, observedAt)?.decision.status === "rejected",
  );
  const readiness = hasUnavailableSource
    ? "unavailable"
    : hasStaleSource
      ? "stale"
      : hasBlockedSource ||
          hasUncertainOperation ||
          hasCurrentRejectedDecision ||
          record.phase === "cancelled"
        ? "blocked"
        : closureHash === null
          ? "incomplete"
          : "ready";
  const latestAcceptance = record.acceptances.toSorted(
    (left, right) => right.acceptedRevision - left.acceptedRevision,
  )[0];
  const acceptanceValidity =
    latestAcceptance === undefined
      ? "none"
      : closureHash !== null &&
          latestAcceptance.planGeneration === record.planGeneration &&
          latestAcceptance.planHash === record.planHash &&
          latestAcceptance.closureHash === closureHash
        ? "current"
        : "needs-review";
  return {
    id: record.id,
    title: record.title,
    phase: record.phase,
    revision: record.revision,
    updatedAt: record.updatedAt,
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
): OutcomeDetail {
  const summary = toOutcomeSummary(record, observedAt, observedProjections);
  const sourcesByRef = new Map(
    authorizedSources.map((source) => [workRefIdentity(source.ref), source]),
  );
  const projectionsByRef = new Map(
    observedProjections.map((projection) => [workRefIdentity(projection.ref), projection]),
  );
  const criteria = record.criteria.map((criterion) => ({
    ...(() => {
      const visibleRefs = criterion.workRefs.filter((ref) =>
        sourcesByRef.has(workRefIdentity(ref)),
      );
      const sourcesComplete = visibleRefs.length === criterion.workRefs.length;
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
          sourcesComplete && criterion.workRefs.length > 0
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
      decidedPlan: toOutcomePlanSnapshotView(decision.decidedPlan, sourcesByRef),
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
      acceptedPlan: toOutcomePlanSnapshotView(acceptance.acceptedPlan, sourcesByRef),
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
  const closureHash = deriveOutcomeClosure(record, observedProjections, observedAt);
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
    ...deriveOutcomeAttention(record, observedProjections, observedAt, closureHash),
  };
}
