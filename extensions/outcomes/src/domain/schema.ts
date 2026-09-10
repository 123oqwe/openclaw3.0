import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";
import type { Criterion } from "./types.js";

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
        id: criterion.id,
        text: criterion.text,
        required: criterion.required,
        workRefs: [...criterion.workRefs].toSorted((a, b) => {
          if (a.cardId !== b.cardId) {
            return a.cardId < b.cardId ? -1 : 1;
          }
          if (a.cardCreatedAt !== b.cardCreatedAt) {
            return a.cardCreatedAt - b.cardCreatedAt;
          }
          return a.boardIdAtLink < b.boardIdAtLink ? -1 : a.boardIdAtLink > b.boardIdAtLink ? 1 : 0;
        }),
      })),
  };
  return createHash("sha256")
    .update(`openclaw:outcome-create:v1\0${stableStringify(canonical)}`, "utf8")
    .digest("hex");
}

export type CanonicalPlan = {
  outcomeId: string;
  objective: string;
  contractRevision: number;
  planGeneration: number;
  criteria: Criterion[];
};

const canonicalPlanSchema = z.strictObject({
  outcomeId: z.string().min(1).max(160),
  objective: z.string().min(1).max(4000),
  contractRevision: z.number().int().positive(),
  planGeneration: z.number().int().positive(),
  criteria: z.array(criterionSchema).min(1).max(5),
}).refine((plan) => plan.criteria.some((criterion) => criterion.required), {
  message: "at least one criterion must be required",
});

export function planHash(input: CanonicalPlan): string {
  const plan = canonicalPlanSchema.parse(input);
  const canonical = {
    outcomeId: plan.outcomeId,
    objective: plan.objective,
    contractRevision: plan.contractRevision,
    planGeneration: plan.planGeneration,
    criteria: [...plan.criteria]
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((criterion) => ({
        id: criterion.id,
        text: criterion.text,
        required: criterion.required,
        workRefs: [...criterion.workRefs].toSorted((a, b) => {
          if (a.cardId !== b.cardId) {
            return a.cardId < b.cardId ? -1 : 1;
          }
          if (a.cardCreatedAt !== b.cardCreatedAt) {
            return a.cardCreatedAt - b.cardCreatedAt;
          }
          return a.boardIdAtLink < b.boardIdAtLink ? -1 : a.boardIdAtLink > b.boardIdAtLink ? 1 : 0;
        }),
      })),
  };
  return createHash("sha256")
    .update(`openclaw:outcome-plan:v1\0${stableStringify(canonical)}`, "utf8")
    .digest("hex");
}

export function assertOutcomeRecordSize(record: unknown, maxBytes = 128 * 1024): void {
  const bytes = Buffer.byteLength(stableStringify(record), "utf8");
  if (bytes > maxBytes) {
    throw new Error(`Outcome record exceeds ${maxBytes}-byte limit`);
  }
}
