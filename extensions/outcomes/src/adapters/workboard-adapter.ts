import { z } from "zod";

const optionalText = z.string().min(1).optional();
const proofSchema = z.object({ id: z.string().min(1), status: z.enum(["passed", "failed", "skipped", "unknown"]), createdAt: z.number().finite(), label: optionalText, command: optionalText, url: optionalText, note: optionalText }).passthrough();
const artifactSchema = z.object({ id: z.string().min(1), createdAt: z.number().finite(), label: optionalText, url: optionalText, path: optionalText, mimeType: optionalText }).passthrough();
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
  proofs: Array<{ id: string; status: "passed" | "failed" | "skipped" | "unknown"; createdAt: number; label?: string; command?: string; url?: string; note?: string }>;
  artifacts: Array<{ id: string; createdAt: number; label?: string; url?: string; path?: string; mimeType?: string }>;
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
      proofs: card.metadata?.proof ?? [],
      artifacts: card.metadata?.artifacts ?? [],
    };
  });
}
