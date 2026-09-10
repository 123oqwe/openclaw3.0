import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";

export const workboardRefSchema = z.object({
  owner: z.literal("workboard"),
  cardId: z.string().min(1),
  cardCreatedAt: z.number().finite(),
  boardIdAtLink: z.string().min(1),
});

export const criterionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  required: z.boolean(),
  workRefs: z.array(workboardRefSchema),
});

export const createRequestSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  criteria: z.array(criterionSchema).min(1).max(5),
});

export function createRequestHash(input: unknown): string {
  const request = createRequestSchema.parse(input);
  const canonical = {
    ...request,
    criteria: [...request.criteria]
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((criterion) => ({
        ...criterion,
        workRefs: [...criterion.workRefs].toSorted((a, b) =>
          `${a.cardId}\0${a.cardCreatedAt}\0${a.boardIdAtLink}` <
          `${b.cardId}\0${b.cardCreatedAt}\0${b.boardIdAtLink}`
            ? -1
            : `${a.cardId}\0${a.cardCreatedAt}\0${a.boardIdAtLink}` >
                `${b.cardId}\0${b.cardCreatedAt}\0${b.boardIdAtLink}`
              ? 1
              : 0,
        ),
      })),
  };
  return createHash("sha256")
    .update(`openclaw:outcome-create:v1\0${stableStringify(canonical)}`, "utf8")
    .digest("hex");
}

export function assertOutcomeRecordSize(record: unknown, maxBytes = 128 * 1024): void {
  const bytes = Buffer.byteLength(stableStringify(record), "utf8");
  if (bytes > maxBytes) {
    throw new Error(`Outcome record exceeds ${maxBytes}-byte limit`);
  }
}
