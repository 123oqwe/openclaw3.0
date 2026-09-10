export type WorkboardRef = {
  owner: "workboard";
  cardId: string;
  cardCreatedAt: number;
  boardIdAtLink: string;
};

export type Criterion = {
  id: string;
  text: string;
  required: boolean;
  workRefs: WorkboardRef[];
};

export type WorkProjection = {
  criterionId: string;
  availability: "available" | "unavailable" | "identity-conflict";
  sourceDigest?: string;
  observedAt?: number;
  upstreamStale?: boolean;
  error?: string;
};

export type EvidenceRef = {
  criterionId: string;
  planGeneration: number;
  sourceId: string;
  sourceDigest: string;
};

export type HumanDecision = {
  id: string;
  criterionId: string;
  planGeneration: number;
  decidedRevision: number;
  status: "verified" | "rejected";
  evidenceSetHash: string;
  note?: string;
  decidedAt: number;
};

export type OutcomeRecord = {
  schemaVersion?: 1;
  id: string;
  createRequestHash?: string;
  managerProfileId?: string;
  title?: string;
  objective?: string;
  contractRevision?: number;
  revision: number;
  phase?: "draft" | "active" | "accepted" | "cancelled";
  planGeneration?: number;
  planHash?: string | null;
  criteria?: Criterion[];
  projections?: WorkProjection[];
  evidence?: EvidenceRef[];
  decisions?: HumanDecision[];
  operations?: unknown[];
  acceptances?: unknown[];
  createdAt?: number;
  updatedAt?: number;
};
