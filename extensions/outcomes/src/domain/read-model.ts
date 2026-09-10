import type {
  OutcomeDetail,
  OutcomeSummary,
  WorkboardRef as PublicWorkboardRef,
} from "@openclaw/outcomes-contract";
import type { OutcomeRecord } from "./types.js";

/** Build the redacted P-01 summary without exposing the persisted aggregate. */
export function toOutcomeSummary(record: OutcomeRecord): OutcomeSummary {
  const required = record.criteria.filter((criterion) => criterion.required);
  const verified = new Set(
    record.decisions
      .filter((decision) => decision.status === "verified")
      .map((decision) => decision.criterionId),
  );
  const readiness =
    record.phase === "cancelled"
      ? "blocked"
      : required.length > 0 && required.every((criterion) => verified.has(criterion.id))
        ? "ready"
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
    workRefs: criterion.workRefs as PublicWorkboardRef[],
    sourcesVisibility: "complete" as const,
    evidenceSetHash: null,
  }));
  const work = record.projections.map((projection) => ({
    ref: projection.ref,
    currentBoardId: projection.currentBoardId ?? projection.ref.boardIdAtLink,
    status: projection.status ?? "unknown",
    observedAt: projection.observedAt,
    sourceUpdatedAt: projection.sourceUpdatedAt,
    lastSuccessfulAt: projection.lastSuccessfulAt,
    upstreamStale: projection.upstreamStale ?? false,
  }));
  const evidence = record.evidence.map((item) => ({
    id: item.id,
    criterionId: item.criterionId,
    workRef: item.workRef,
    kind: item.kind,
    sourceId: item.sourceId,
    sourceDigest: item.sourceDigest,
    observedAt: item.observedAt,
    planGeneration: item.planGeneration,
    sourceCreatedAt: item.observedAt,
  }));
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
    sourceIssues: [],
    acceptance: { acceptanceValidity: summary.acceptanceValidity },
    observedAt,
    recheckAfter: null,
    closureHash: null,
    attention: [],
    nextActions: summary.phase === "cancelled" ? [] : ["refresh", "cancel"],
  };
}
