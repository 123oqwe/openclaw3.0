import { OUTCOME_PROJECTION_MAX_AGE_MS } from "@openclaw/outcomes-contract";
import type { OutcomeDetail, OutcomeSummary } from "@openclaw/outcomes-contract";
import { evidenceSetHash } from "./hash.js";
import type { OutcomeRecord } from "./types.js";

type CurrentProjection = OutcomeRecord["projections"][number];

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
  const linked = new Map(criterion.workRefs.map((ref) => [workRefIdentity(ref), ref]));
  const linkedProjections = new Map(
    projections
      .filter((projection) => linked.has(workRefIdentity(projection.ref)))
      .map((projection) => [workRefIdentity(projection.ref), projection]),
  );
  if (
    linkedProjections.size !== linked.size ||
    Array.from(linkedProjections.values()).some(
      (projection) =>
        projection.availability !== "available" || isStaleProjection(projection, observedAt),
    )
  ) {
    return undefined;
  }
  const sources = new Set(
    Array.from(linkedProjections.values()).flatMap((projection) => {
      const identity = workRefIdentity(projection.ref);
      return [
        ...projection.proofs.map(
          (source) => `${identity}\0workboard-proof\0${source.sourceId}\0${source.digest}`,
        ),
        ...projection.artifacts.map(
          (source) => `${identity}\0workboard-artifact\0${source.sourceId}\0${source.digest}`,
        ),
      ];
    }),
  );
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
  const decision = record.decisions
    .filter(
      (decision) =>
        decision.criterionId === criterion.id &&
        decision.planGeneration === record.planGeneration &&
        decision.planHash === record.planHash &&
        decision.evidenceSetHash === expectedEvidenceSetHash,
    )
    .toSorted((a, b) => b.decidedRevision - a.decidedRevision)[0];
  return decision === undefined ? undefined : { decision, sourceDigests };
}

/** Build the redacted P-01 summary without exposing the persisted aggregate. */
export function toOutcomeSummary(record: OutcomeRecord, observedAt: number): OutcomeSummary {
  const projections = currentProjections(record);
  const hasUnavailableSource = projections.some(
    (projection) =>
      projection.availability !== "available" ||
      ["workboard-disabled", "not-found", "forbidden", "timeout", "invalid-response"].includes(
        projection.errorCode ?? "",
      ),
  );
  const hasStaleSource = projections.some((projection) => isStaleProjection(projection, observedAt));
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
      : hasBlockedSource || hasUncertainOperation || hasCurrentRejectedDecision || record.phase === "cancelled"
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

/** Build the public detail view; identity, request hashes, and internal history stay private. */
export function toOutcomeDetail(record: OutcomeRecord, observedAt: number): OutcomeDetail {
  const summary = toOutcomeSummary(record, observedAt);
  const criteria = record.criteria.map((criterion) => ({
    id: criterion.id,
    text: criterion.text,
    required: criterion.required,
    workRefs: [],
    sourcesVisibility: "restricted" as const,
    evidenceSetHash: null,
  }));
  // P-01 has no owner-authorized observation adapter yet. Do not leak persisted
  // refs/evidence or invent source timestamps; P-02 supplies these inputs.
  const work: OutcomeDetail["work"] = [];
  const evidence: OutcomeDetail["evidence"] = [];
  const sourceIssues = currentProjections(record)
    .flatMap((projection) => {
      const linkedCriteria = record.criteria.filter((item) =>
        item.workRefs.some(
          (ref) =>
            workRefIdentity(ref) === workRefIdentity(projection.ref),
        ),
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
    recheckAfter: null,
    closureHash: null,
    attention: [],
    nextActions: summary.phase === "cancelled" ? [] : ["refresh", "cancel"],
  };
}
