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

const projectionSchema = z.strictObject({
  ref: workboardRefSchema.optional(),
  criterionId: z.string().min(1),
  availability: z.enum(["available", "unavailable", "identity-conflict"]),
  sourceDigest: z.string().min(1).optional(),
  observedAt: z.number().finite().optional(),
  upstreamStale: z.boolean().optional(),
  error: z.string().optional(),
});

const evidenceSchema = z.strictObject({
  id: z.string().min(1),
  criterionId: z.string().min(1),
  planGeneration: z.number().int().nonnegative(),
  workRef: workboardRefSchema,
  kind: z.enum(["workboard-proof", "workboard-artifact"]),
  sourceId: z.string().min(1),
  sourceDigest: z.string().min(1),
  observedAt: z.number().finite(),
});

const decisionSchema = z.strictObject({
  id: z.string().min(1),
  criterionId: z.string().min(1),
  planGeneration: z.number().int().nonnegative(),
  decidedRevision: z.number().int().positive(),
  status: z.enum(["verified", "rejected"]),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  profileId: z.string().min(1),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  decidedPlan: z.strictObject({
    outcomeId: z.string().min(1),
    objective: z.string().min(1).max(4000),
    contractRevision: z.number().int().positive(),
    planGeneration: z.number().int().positive(),
    criteria: z.array(criterionSchema).min(1).max(5),
  }),
  evidenceSetHash: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.string().optional(),
  decidedAt: z.number().finite(),
});

const operationSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("workboard-card-start"),
  criterionId: z.string().min(1),
  planGeneration: z.number().int().nonnegative(),
  createdRevision: z.number().int().positive(),
  requestHash: z.string().length(64),
  state: z.enum(["prepared", "may-have-crossed", "succeeded", "failed", "unknown"]),
  target: workboardRefSchema,
  attemptedAt: z.number().finite().optional(),
  terminalAt: z.number().finite().optional(),
  resultDigest: z.string().min(1).optional(),
});

const acceptanceSchema = z.strictObject({
  id: z.string().min(1),
  requestHash: z.string().length(64),
  acceptedRevision: z.number().int().positive(),
  profileId: z.string().min(1),
  acceptedAt: z.number().finite(),
  planGeneration: z.number().int().nonnegative(),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  closureHash: z.string().regex(/^[0-9a-f]{64}$/),
  acceptedPlan: z.strictObject({
    outcomeId: z.string().min(1),
    objective: z.string().min(1),
    contractRevision: z.number().int().positive(),
    planGeneration: z.number().int().positive(),
    criteria: z.array(criterionSchema).min(1).max(5),
  }),
});

/** Strict persisted aggregate contract; adapters should parse before exposing records. */
export const outcomeRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(160),
  createRequestHash: z.string().length(64),
  managerProfileId: z.string().min(1),
  title: z.string().min(1).max(160),
  objective: z.string().min(1).max(4000),
  phase: z.enum(["draft", "active", "accepted", "cancelled"]),
  revision: z.number().int().positive(),
  contractRevision: z.number().int().positive(),
  planGeneration: z.number().int().nonnegative(),
  planHash: z.string().length(64).nullable(),
  criteria: z.array(criterionSchema).min(1).max(5),
  projections: z.array(projectionSchema),
  evidence: z.array(evidenceSchema).max(100),
  decisions: z.array(decisionSchema).max(100),
  operations: z.array(operationSchema).max(20),
  acceptances: z.array(acceptanceSchema).max(20),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).superRefine((record, ctx) => {
  if (record.phase === "draft" && (record.planGeneration !== 0 || record.planHash !== null)) {
    ctx.addIssue({ code: "custom", message: "draft records must have generation 0 and null planHash" });
  }
  if (record.phase === "active" || record.phase === "accepted") {
    if (record.planGeneration < 1 || record.planHash === null) {
      ctx.addIssue({ code: "custom", message: "active and accepted records require a plan" });
    }
  }
  for (const decision of record.decisions) {
    if (decision.decidedPlan.outcomeId !== record.id || decision.decidedPlan.planGeneration !== decision.planGeneration) {
      ctx.addIssue({ code: "custom", message: "decision snapshot does not match its outcome/generation" });
    }
    if (!decision.decidedPlan.criteria.some((criterion) => criterion.id === decision.criterionId)) {
      ctx.addIssue({ code: "custom", message: "decision criterion is absent from its plan snapshot" });
    }
  }
  for (const acceptance of record.acceptances) {
    if (acceptance.acceptedPlan.outcomeId !== record.id || acceptance.acceptedPlan.planGeneration !== acceptance.planGeneration) {
      ctx.addIssue({ code: "custom", message: "acceptance snapshot does not match its outcome/generation" });
    }
  }
});

export function parseOutcomeRecord(input: unknown) {
  return outcomeRecordSchema.parse(input);
}

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
