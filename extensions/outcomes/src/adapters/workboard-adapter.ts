import {
  WORKBOARD_PROOF_STATUSES,
  WORKBOARD_STATUSES,
  type WorkboardProofStatus,
  type WorkboardStatus,
} from "@openclaw/workboard-contract";
import { z } from "zod";

/** The owner reused a card ID with distinct immutable creation identities. */
export class WorkboardIdentityConflictError extends Error {
  constructor() {
    super("ambiguous Workboard card identity");
    this.name = "WorkboardIdentityConflictError";
  }
}

const optionalText = z.string().min(1).optional();
const proofSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(WORKBOARD_PROOF_STATUSES),
    createdAt: z.number().finite(),
    label: optionalText,
    command: optionalText,
    url: optionalText,
    note: optionalText,
  })
  .passthrough();
const artifactSchema = z
  .object({
    id: z.string().min(1),
    createdAt: z.number().finite(),
    label: optionalText,
    url: optionalText,
    path: optionalText,
    mimeType: optionalText,
  })
  .passthrough();
const staleSchema = z
  .object({
    detectedAt: z.number().finite(),
    lastSessionUpdatedAt: z.number().finite().optional(),
    reason: z.string().min(1),
  })
  .passthrough();
const cardSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(WORKBOARD_STATUSES),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    metadata: z
      .object({
        automation: z.object({ boardId: z.string().min(1) }).optional(),
        proof: z.array(proofSchema).optional(),
        artifacts: z.array(artifactSchema).optional(),
        stale: staleSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const responseSchema = z.object({ cards: z.array(cardSchema) }).passthrough();

export type WorkboardCard = {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: WorkboardStatus;
  boardId: string;
  upstreamStale: boolean;
  proofs: Array<{
    id: string;
    status: WorkboardProofStatus;
    createdAt: number;
    label?: string;
    command?: string;
    url?: string;
    note?: string;
  }>;
  artifacts: Array<{
    id: string;
    createdAt: number;
    label?: string;
    url?: string;
    path?: string;
    mimeType?: string;
  }>;
};

/** Parses only the frozen public cards.list fields, accepting harmless owner additions. */
export function readWorkboardCards(value: unknown): WorkboardCard[] {
  const response = responseSchema.parse(value);
  const seenCardIds = new Set<string>();
  return response.cards.map((card) => {
    if (seenCardIds.has(card.id)) {
      throw new WorkboardIdentityConflictError();
    }
    seenCardIds.add(card.id);
    const proofs = card.metadata?.proof ?? [];
    const artifacts = card.metadata?.artifacts ?? [];
    if (new Set(proofs.map((proof) => proof.id)).size !== proofs.length) {
      throw new Error("duplicate Workboard proof identity");
    }
    if (new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length) {
      throw new Error("duplicate Workboard artifact identity");
    }
    return {
      id: card.id,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      status: card.status,
      boardId: card.metadata?.automation?.boardId ?? "default",
      upstreamStale: card.metadata?.stale !== undefined,
      proofs,
      artifacts,
    };
  });
}
