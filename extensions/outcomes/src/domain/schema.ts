import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";

export const workboardRefSchema = z.strictObject({
  owner: z.literal("workboard"),
  cardId: z.string().min(1),
  cardCreatedAt: z.number().finite(),
  boardIdAtLink: z.string().min(1),
});

export const criterionSchema = z.strictObject({
  id: z.string().min(1).max(160),
  text: z.string().min(1).max(1000),
  required: z.boolean(),
  workRefs: z.array(workboardRefSchema),
});

export const createRequestSchema = z.strictObject({
  id: z.string().min(1).max(160),
  title: z.string().min(1).max(160),
  objective: z.string().min(1).max(4000),
  criteria: z.array(criterionSchema).min(1).max(5),
}).refine((request) => request.criteria.some((criterion) => criterion.required), {
  message: "at least one criterion must be required",
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
          a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : a.cardCreatedAt - b.cardCreatedAt || (a.boardIdAtLink < b.boardIdAtLink ? -1 : a.boardIdAtLink > b.boardIdAtLink ? 1 : 0),
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
