import type {
  OutcomeDetail,
  OutcomeSummary,
  WorkboardRef as PublicWorkboardRef,
} from "@openclaw/outcomes-contract";
import type { OutcomeRecord } from "./types.js";

/** Build the redacted P-01 summary without exposing the persisted aggregate. */
export function toOutcomeSummary(record: OutcomeRecord, observedAt = record.updatedAt): OutcomeSummary {
  const hasUnavailableSource = record.projections.some(
    (projection) =>
      projection.availability !== "available" ||
      ["workboard-disabled", "not-found", "forbidden", "timeout", "invalid-response"].includes(
        projection.errorCode ?? "",
      ),
  );
  const currentRefs = new Set(
    record.criteria.flatMap((criterion) =>
      criterion.workRefs.map((ref) => `${ref.cardId}:${ref.cardCreatedAt}:${ref.boardIdAtLink}`),
    ),
  );
  const currentProjections = record.projections.filter((projection) =>
    currentRefs.has(
      `${projection.ref.cardId}:${projection.ref.cardCreatedAt}:${projection.ref.boardIdAtLink}`,
    ),
  );
  const hasStaleSource = currentProjections.some(
    (projection) =>
      projection.upstreamStale === true || observedAt - projection.observedAt > 24 * 60 * 60 * 1000,
  );
  const readiness = hasUnavailableSource
    ? "unavailable"
    : hasStaleSource
      ? "stale"
      : record.phase === "cancelled"
        ? "blocked"
        : "incomplete";
  const acceptanceValidity =
    record.acceptances.length === 0
      ? "none"
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

/** Build the public detail view; identity, request hashes, and internal history stay private. */
export function toOutcomeDetail(record: OutcomeRecord, observedAt: number): OutcomeDetail {
  const summary = toOutcomeSummary(record, observedAt);
  const criteria = record.criteria.map((criterion) => ({
    id: criterion.id,
    text: criterion.text,
    required: criterion.required,
    workRefs: [] as PublicWorkboardRef[],
    sourcesVisibility: "restricted" as const,
    evidenceSetHash: null,
  }));
  // P-01 has no owner-authorized observation adapter yet. Do not leak persisted
  // refs/evidence or invent source timestamps; P-02 supplies these inputs.
  const work: OutcomeDetail["work"] = [];
  const evidence: OutcomeDetail["evidence"] = [];
  const currentRefs = new Set(
    record.criteria.flatMap((criterion) =>
      criterion.workRefs.map((ref) => `${ref.cardId}:${ref.cardCreatedAt}:${ref.boardIdAtLink}`),
    ),
  );
  const currentProjections = record.projections.filter((projection) =>
    currentRefs.has(
      `${projection.ref.cardId}:${projection.ref.cardCreatedAt}:${projection.ref.boardIdAtLink}`,
    ),
  );
  const sourceIssues = currentProjections.flatMap((projection) => {
    const criteria = record.criteria.filter((item) =>
      item.workRefs.some(
        (ref) =>
          ref.cardId === projection.ref.cardId &&
          ref.cardCreatedAt === projection.ref.cardCreatedAt &&
          ref.boardIdAtLink === projection.ref.boardIdAtLink,
      ),
    );
    const reason = projection.errorCode;
    return reason ? criteria.map((criterion) => ({ criterionId: criterion.id, reason })) : [];
  }).filter(
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
        ? { reason: summary.readiness === "stale" ? "stale" as const : "not-rechecked" as const }
        : {}),
    },
    observedAt,
    recheckAfter: null,
    closureHash: null,
    attention: [],
    nextActions: summary.phase === "cancelled" ? [] : ["refresh", "cancel"],
  };
}
