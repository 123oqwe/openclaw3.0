import { OUTCOME_PROJECTION_MAX_AGE_MS } from "@openclaw/outcomes-contract";
import type { OutcomeDetail, OutcomeSummary } from "@openclaw/outcomes-contract";
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

function workRefIdentity(ref: OutcomeRecord["criteria"][number]["workRefs"][number]): string {
  return `${ref.cardId}\0${ref.cardCreatedAt}`;
}

function isStaleProjection(projection: CurrentProjection, observedAt: number): boolean {
  return (
    projection.upstreamStale === true ||
    projection.lastSuccessfulAt === undefined ||
    observedAt - projection.lastSuccessfulAt >= OUTCOME_PROJECTION_MAX_AGE_MS
  );
}

/** Keep only the newest projection for every linked Workboard card identity. */
function currentProjections(record: OutcomeRecord): CurrentProjection[] {
  const linked = new Set(
    record.criteria.flatMap((criterion) => criterion.workRefs.map(workRefIdentity)),
  );
  const newest = new Map<string, CurrentProjection>();
  for (const projection of record.projections) {
    const identity = workRefIdentity(projection.ref);
    if (!linked.has(identity)) {
      continue;
    }
    const previous = newest.get(identity);
    if (previous === undefined || projection.observedAt > previous.observedAt) {
      newest.set(identity, projection);
    }
  }
  return Array.from(newest.values());
}

function currentEvidenceSourceDigests(
  record: OutcomeRecord,
  criterion: OutcomeRecord["criteria"][number],
  projections: CurrentProjection[],
  observedAt: number,
): string[] | undefined {
  const linked = new Map<string, OutcomeRecord["criteria"][number]["workRefs"][number]>();
  for (const ref of criterion.workRefs) {
    linked.set(workRefIdentity(ref), ref);
  }
  if (linked.size === 0) {
    return undefined;
  }
  const linkedProjections = new Map<string, CurrentProjection>();
  for (const projection of projections) {
    const identity = workRefIdentity(projection.ref);
    if (linked.has(identity)) {
      linkedProjections.set(identity, projection);
    }
  }
  if (
    linkedProjections.size !== linked.size ||
    Array.from(linkedProjections.values()).some(
      (projection) =>
        projection.availability !== "available" || isStaleProjection(projection, observedAt),
    )
  ) {
    return undefined;
  }
  const sources = new Set<string>();
  for (const projection of linkedProjections.values()) {
    const identity = workRefIdentity(projection.ref);
    for (const source of projection.proofs) {
      sources.add(`${identity}\0workboard-proof\0${source.sourceId}\0${source.digest}`);
    }
    for (const source of projection.artifacts) {
      sources.add(`${identity}\0workboard-artifact\0${source.sourceId}\0${source.digest}`);
    }
  }
  return record.evidence
    .filter(
      (evidence) =>
        evidence.planGeneration === record.planGeneration &&
        evidence.criterionId === criterion.id &&
        linked.has(workRefIdentity(evidence.workRef)) &&
        sources.has(
          `${workRefIdentity(evidence.workRef)}\0${evidence.kind}\0${evidence.sourceId}\0${evidence.sourceDigest}`,
        ),
    )
    .map((evidence) => evidence.sourceDigest);
}

function currentDecision(
  record: OutcomeRecord,
  criterion: OutcomeRecord["criteria"][number],
  projections: CurrentProjection[],
  observedAt: number,
): { decision: OutcomeRecord["decisions"][number]; sourceDigests: string[] } | undefined {
  const sourceDigests = currentEvidenceSourceDigests(record, criterion, projections, observedAt);
  if (sourceDigests === undefined) {
    return undefined;
  }
  const expectedEvidenceSetHash = evidenceSetHash({
    criterionId: criterion.id,
    planGeneration: record.planGeneration,
    sourceDigests,
  });
  const selectedDecision = record.decisions
    .filter(
      (candidate) =>
        candidate.criterionId === criterion.id &&
        candidate.planGeneration === record.planGeneration &&
        candidate.planHash === record.planHash &&
        candidate.evidenceSetHash === expectedEvidenceSetHash,
    )
    .toSorted((a, b) => b.decidedRevision - a.decidedRevision)[0];
  return selectedDecision === undefined ? undefined : { decision: selectedDecision, sourceDigests };
}

/** Build the redacted P-01 summary without exposing the persisted aggregate. */
export function toOutcomeSummary(
  record: OutcomeRecord,
  observedAt: number,
  projections: CurrentProjection[] = currentProjections(record),
): OutcomeSummary {
  const hasUnavailableSource = projections.some(
    (projection) =>
      projection.availability !== "available" ||
      ["workboard-disabled", "not-found", "forbidden", "timeout", "invalid-response"].includes(
        projection.errorCode ?? "",
      ),
  );
  const hasStaleSource = projections.some((projection) =>
    isStaleProjection(projection, observedAt),
  );
  const hasBlockedSource = projections.some((projection) => projection.status === "blocked");
  const hasUncertainOperation = record.operations.some((operation) =>
    ["prepared", "may-have-crossed", "unknown"].includes(operation.state),
  );
  const hasCurrentRejectedDecision = record.criteria.some(
    (criterion) =>
      currentDecision(record, criterion, projections, observedAt)?.decision.status === "rejected",
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
        : "incomplete";
  const acceptanceValidity = record.acceptances.length === 0 ? "none" : "needs-review";
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
  observedProjections: CurrentProjection[] = currentProjections(record),
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
    closureHash: null,
    attention: [],
    nextActions: summary.phase === "cancelled" ? [] : ["refresh", "cancel"],
  };
}
