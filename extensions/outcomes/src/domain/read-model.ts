import type {
  OutcomeDetail,
  OutcomeSummary,
  WorkboardRef as PublicWorkboardRef,
} from "@openclaw/outcomes-contract";
import type { OutcomeRecord } from "./types.js";

/** Build the redacted P-01 summary without exposing the persisted aggregate. */
export function toOutcomeSummary(record: OutcomeRecord): OutcomeSummary {
  const required = record.criteria.filter((criterion) => criterion.required);
  const hasUnavailableSource = record.projections.some((projection) =>
    ["workboard-disabled", "not-found", "forbidden", "timeout", "invalid-response"].includes(
      projection.errorCode ?? "",
    ),
  );
  const hasStaleSource = record.projections.some((projection) => projection.upstreamStale === true);
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
      : record.phase === "accepted" && record.acceptances.at(-1)?.planHash === record.planHash
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

/** Build the public detail view; identity, request hashes, and internal history stay private. */
export function toOutcomeDetail(record: OutcomeRecord, observedAt: number): OutcomeDetail {
  const summary = toOutcomeSummary(record);
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
  const sourceIssues = record.projections.flatMap((projection) =>
    projection.errorCode
      ? [{ criterionId: projection.ref.cardId, reason: projection.errorCode }]
      : [],
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
