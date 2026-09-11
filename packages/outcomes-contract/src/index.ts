/** Public P-01 Outcome views. Persisted records and manager identity stay private. */
export const OUTCOME_PHASES = ["draft", "active", "accepted", "cancelled"] as const;
export const OUTCOME_READINESS = [
  "incomplete",
  "blocked",
  "ready",
  "stale",
  "unavailable",
] as const;
export const OUTCOME_ACCEPTANCE_VALIDITY = ["none", "current", "needs-review"] as const;
export const OUTCOME_SOURCE_VISIBILITY = ["complete", "restricted"] as const;
export const OUTCOME_SOURCE_ISSUE_REASONS = [
  "workboard-disabled",
  "not-found",
  "forbidden",
  "timeout",
  "invalid-response",
  "identity-conflict",
] as const;
export const OUTCOME_ATTENTION_CODES = [
  "owner-unavailable",
  "stale",
  "blocked",
  "contract-incomplete",
  "evidence-missing",
  "verification-required",
  "rejected",
  "ready-for-acceptance",
  "acceptance-needs-review",
  "unknown-operation",
] as const;
export const OUTCOME_NEXT_ACTIONS = [
  "edit-contract",
  "link-work",
  "unlink-work",
  "activate",
  "refresh",
  "cancel",
  "review-evidence",
  "accept",
  "observe-operation",
] as const;
export const OUTCOME_EVIDENCE_KINDS = ["workboard-proof", "workboard-artifact"] as const;
export const OUTCOME_PROOF_STATUSES = ["passed", "failed", "skipped", "unknown"] as const;
export const OUTCOME_REFRESH_STATUSES = ["available", "unavailable", "identity-conflict"] as const;
export const OUTCOME_MAX_LIST_LIMIT = 100;
export const OUTCOME_DEFAULT_LIST_LIMIT = 25;
export const OUTCOME_PROJECTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type OutcomePhase = (typeof OUTCOME_PHASES)[number];
export type OutcomeReadiness = (typeof OUTCOME_READINESS)[number];
export type OutcomeAcceptanceValidity = (typeof OUTCOME_ACCEPTANCE_VALIDITY)[number];
export type OutcomeSourceVisibility = (typeof OUTCOME_SOURCE_VISIBILITY)[number];
export type OutcomeSourceIssueReason = (typeof OUTCOME_SOURCE_ISSUE_REASONS)[number];
export type OutcomeAttentionCode = (typeof OUTCOME_ATTENTION_CODES)[number];
export type OutcomeNextAction = (typeof OUTCOME_NEXT_ACTIONS)[number];
export type OutcomeEvidenceKind = (typeof OUTCOME_EVIDENCE_KINDS)[number];
export type OutcomeProofStatus = (typeof OUTCOME_PROOF_STATUSES)[number];
export type OutcomeRefreshStatus = (typeof OUTCOME_REFRESH_STATUSES)[number];
export type OutcomeAcceptanceReason =
  | "contract-changed"
  | "evidence-changed"
  | "decision-changed"
  | "blocked"
  | "stale"
  | "unavailable"
  | "unknown-operation"
  | "not-rechecked";
export type OutcomeAcceptanceView = {
  acceptanceValidity: OutcomeAcceptanceValidity;
  lastSuccessfulAt?: number;
  reason?: OutcomeAcceptanceReason;
};

export type WorkboardRef = {
  owner: "workboard";
  cardId: string;
  cardCreatedAt: number;
  boardIdAtLink: string;
};

export type OutcomeSummary = {
  id: string;
  title: string;
  phase: OutcomePhase;
  revision: number;
  updatedAt: number;
  readiness: OutcomeReadiness;
  acceptanceValidity: OutcomeAcceptanceValidity;
};

export type OutcomePlanSnapshotView = {
  outcomeId: string;
  objective: string;
  contractRevision: number;
  planGeneration: number;
  criteria: Array<{
    id: string;
    text: string;
    required: boolean;
    workRefs: WorkboardRef[];
    sourcesVisibility: OutcomeSourceVisibility;
  }>;
};

export type OutcomeCriterionView = {
  id: string;
  text: string;
  required: boolean;
  workRefs: WorkboardRef[];
  sourcesVisibility: OutcomeSourceVisibility;
  evidenceSetHash: string | null;
};

export type OutcomeWorkView = {
  ref: WorkboardRef;
  currentBoardId: string;
  status: string;
  observedAt: number;
  sourceUpdatedAt?: number;
  lastSuccessfulAt?: number;
  upstreamStale: boolean;
};

export type OutcomeEvidenceView = {
  id: string;
  criterionId: string;
  workRef: WorkboardRef;
  kind: OutcomeEvidenceKind;
  sourceId: string;
  sourceDigest: string;
  observedAt: number;
  planGeneration: number;
  sourceCreatedAt: number;
  label?: string;
  proofStatus?: OutcomeProofStatus;
  url?: string;
  mimeType?: string;
};

export type OutcomeDetail = OutcomeSummary & {
  objective: string;
  contractRevision: number;
  planGeneration: number;
  planHash: string | null;
  createdAt: number;
  criteria: OutcomeCriterionView[];
  work: OutcomeWorkView[];
  evidence: OutcomeEvidenceView[];
  sourceIssues: Array<{ criterionId: string; reason: OutcomeSourceIssueReason }>;
  acceptance: OutcomeAcceptanceView;
  observedAt: number;
  recheckAfter: number | null;
  closureHash: string | null;
  attention: Array<{ code: OutcomeAttentionCode; criterionId?: string }>;
  nextActions: OutcomeNextAction[];
};

/** Client-owned fields for the first authenticated Outcome Gateway package. */
export type OutcomeCriterionInput = {
  id: string;
  text: string;
  required: boolean;
};

export type OutcomeCreateParams = {
  id: string;
  title: string;
  objective: string;
  criteria: OutcomeCriterionInput[];
};

export type OutcomeGetParams = { id: string };

export type OutcomeListParams = { limit?: number; cursor?: string };

export type OutcomeUpdateParams = {
  id: string;
  expectedRevision: number;
  patch: {
    title?: string;
    objective?: string;
    criteria?: OutcomeCriterionInput[];
  };
};

export type OutcomeRevisionParams = { id: string; expectedRevision: number };
export type OutcomeRefreshParams = OutcomeRevisionParams;

/** Client may name a card, but the server derives its immutable Workboard identity. */
export type OutcomeWorkboardLinkParams = OutcomeRevisionParams & {
  criterionId: string;
  cardId: string;
};

export type OutcomeWorkboardUnlinkParams = OutcomeWorkboardLinkParams;

export type OutcomeCreateResult = {
  outcome: OutcomeDetail;
  replayed: boolean;
  receipt: { kind: "create"; id: string; committedRevision: number };
};

export type OutcomeMutationResult = { outcome: OutcomeDetail };

export type OutcomeRefreshResult = OutcomeMutationResult & {
  refresh: { status: OutcomeRefreshStatus; reason?: OutcomeSourceIssueReason };
};

export type OutcomeListResult = { outcomes: OutcomeSummary[]; nextCursor?: string };
