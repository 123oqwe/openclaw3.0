import { z } from "zod";

const proofSchema = z.object({ id: z.string().min(1), status: z.string(), createdAt: z.number().finite() }).passthrough();
const artifactSchema = z.object({ id: z.string().min(1), createdAt: z.number().finite() }).passthrough();
const cardSchema = z.object({
  id: z.string().min(1), status: z.string().min(1), createdAt: z.number().finite(), updatedAt: z.number().finite(),
  metadata: z.object({
    automation: z.object({ boardId: z.string().min(1) }).optional(),
    proof: z.array(proofSchema).optional(), artifacts: z.array(artifactSchema).optional(),
  }).passthrough().optional(),
}).passthrough();
const responseSchema = z.object({ cards: z.array(cardSchema) }).passthrough();

export type WorkboardCard = {
  id: string; createdAt: number; updatedAt: number; status: string; boardId: string;
  proofs: Array<{ id: string; status: string; createdAt: number }>;
  artifacts: Array<{ id: string; createdAt: number }>;
};

/** Parses only the frozen public cards.list fields, accepting harmless owner additions. */
export function readWorkboardCards(value: unknown): WorkboardCard[] {
  const response = responseSchema.parse(value);
  const seen = new Set<string>();
  return response.cards.map((card) => {
    const identity = `${card.id}\0${card.createdAt}`;
    if (seen.has(identity)) throw new Error("ambiguous Workboard card identity");
    seen.add(identity);
    return {
      id: card.id, createdAt: card.createdAt, updatedAt: card.updatedAt, status: card.status,
      boardId: card.metadata?.automation?.boardId ?? "default",
      proofs: (card.metadata?.proof ?? []).map(({ id, status, createdAt }) => ({ id, status, createdAt })),
      artifacts: (card.metadata?.artifacts ?? []).map(({ id, createdAt }) => ({ id, createdAt })),
    };
  });
}
