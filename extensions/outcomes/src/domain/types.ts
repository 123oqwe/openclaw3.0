import type { OutcomePhase, WorkboardRef as PublicWorkboardRef } from "@openclaw/outcomes-contract";

export type WorkboardRef = PublicWorkboardRef;

export type Criterion = {
  id: string;
  text: string;
  required: boolean;
  workRefs: WorkboardRef[];
};

export type WorkProjection = {
  ref: WorkboardRef;
  availability: "available" | "unavailable" | "identity-conflict";
  observedAt: number;
  proofs: Array<{ sourceId: string; digest: string }>;
  artifacts: Array<{ sourceId: string; digest: string }>;
  currentBoardId?: string;
  status?: string;
  lastSuccessfulAt?: number;
  sourceUpdatedAt?: number;
  upstreamStale?: boolean;
  sourceFingerprint?: string;
  errorCode?: "workboard-disabled" | "not-found" | "forbidden" | "timeout" | "invalid-response" | "identity-conflict";
};

export type OutcomePlanSnapshot = {
  outcomeId: string;
  objective: string;
  contractRevision: number;
  planGeneration: number;
  criteria: Criterion[];
};

export type Acceptance = {
  id: string;
  requestHash: string;
  acceptedRevision: number;
  profileId: string;
  acceptedAt: number;
  planGeneration: number;
  planHash: string;
  closureHash: string;
  acceptedPlan: OutcomePlanSnapshot;
};

export type OutcomeOperation = {
  id: string;
  kind: "workboard-card-start";
  criterionId: string;
  planGeneration: number;
  createdRevision: number;
  requestHash: string;
  state: "prepared" | "may-have-crossed" | "succeeded" | "failed" | "unknown";
  target: WorkboardRef;
  attemptedAt?: number;
  terminalAt?: number;
  resultDigest?: string;
};

export type EvidenceRef = {
  id: string;
  criterionId: string;
  planGeneration: number;
  workRef: WorkboardRef;
  kind: "workboard-proof" | "workboard-artifact";
  sourceId: string;
  sourceDigest: string;
  observedAt: number;
};

export type HumanDecision = {
  id: string;
  criterionId: string;
  planGeneration: number;
  decidedRevision: number;
  status: "verified" | "rejected";
  requestHash: string;
  profileId: string;
  planHash: string;
  decidedPlan: OutcomePlanSnapshot;
  evidenceSetHash: string;
  note?: string;
  decidedAt: number;
};

export type OutcomeRecordDraft = {
  schemaVersion?: 1;
  id: string;
  createRequestHash?: string;
  managerProfileId?: string;
  title?: string;
  objective?: string;
  contractRevision?: number;
  revision: number;
  phase?: OutcomePhase;
  planGeneration?: number;
  planHash?: string | null;
  criteria?: Criterion[];
  projections?: WorkProjection[];
  evidence?: EvidenceRef[];
  decisions?: HumanDecision[];
  operations?: OutcomeOperation[];
  acceptances?: Acceptance[];
  createdAt?: number;
  updatedAt?: number;
};

/** Fully materialized aggregate accepted at the persistence boundary. */
export type PersistedOutcomeRecord = OutcomeRecordDraft & {
  schemaVersion: 1;
  createRequestHash: string;
  managerProfileId: string;
  title: string;
  objective: string;
  contractRevision: number;
  phase: "draft" | "active" | "accepted" | "cancelled";
  planGeneration: number;
  planHash: string | null;
  criteria: Criterion[];
  projections: WorkProjection[];
  evidence: EvidenceRef[];
  decisions: HumanDecision[];
  operations: OutcomeOperation[];
  acceptances: Acceptance[];
  createdAt: number;
  updatedAt: number;
};

/** The formal record type is always fully materialized. */
export type OutcomeRecord = PersistedOutcomeRecord;
