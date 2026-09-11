import { createHash } from "node:crypto";
import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";
import { z } from "zod";
import { OUTCOME_MAX_CRITERIA, OUTCOME_MAX_RECORD_BYTES } from "./constants.js";
import type { Criterion, PersistedOutcomeRecord, WorkProjection } from "./types.js";

export const workboardRefSchema = z.strictObject({
  owner: z.literal("workboard"),
  cardId: z.string().min(1),
  cardCreatedAt: z.number().finite().nonnegative(),
  boardIdAtLink: z.string().min(1),
});

export const criterionSchema = z.strictObject({
  id: z.string().min(1).max(160),
  text: z.string().min(1).max(1000),
  required: z.boolean(),
  workRefs: z.array(workboardRefSchema),
});

export const createRequestSchema = z
  .strictObject({
    id: z.string().min(1).max(160),
    title: z.string().min(1).max(160),
    objective: z.string().min(1).max(4000),
    criteria: z.array(criterionSchema).min(1).max(OUTCOME_MAX_CRITERIA),
  })
  .refine((request) => request.criteria.some((criterion) => criterion.required), {
    message: "at least one criterion must be required",
  })
  .superRefine((request, ctx) => {
    const ids = new Set(request.criteria.map((criterion) => criterion.id));
    if (ids.size !== request.criteria.length) {
      ctx.addIssue({ code: "custom", message: "criterion ids must be unique" });
    }
    const refs = request.criteria.flatMap((criterion) =>
      criterion.workRefs.map((ref) => `${ref.cardId}\0${ref.cardCreatedAt}`),
    );
    if (
      request.criteria.some(
        (criterion) =>
          new Set(criterion.workRefs.map((ref) => `${ref.cardId}\0${ref.cardCreatedAt}`)).size > 10,
      )
    ) {
      ctx.addIssue({ code: "custom", message: "a criterion cannot link more than 10 refs" });
    }
    if (new Set(refs).size > 20) {
      ctx.addIssue({ code: "custom", message: "an outcome cannot link more than 20 refs" });
    }
  });

const projectionSchema = z
  .strictObject({
    ref: workboardRefSchema,
    availability: z.enum(["available", "unavailable", "identity-conflict"]),
    observedAt: z.number().finite(),
    proofs: z.array(z.strictObject({ sourceId: z.string().min(1), digest: z.string().min(1) })),
    artifacts: z.array(z.strictObject({ sourceId: z.string().min(1), digest: z.string().min(1) })),
    currentBoardId: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    lastSuccessfulAt: z.number().finite().optional(),
    sourceUpdatedAt: z.number().finite().optional(),
    upstreamStale: z.boolean().optional(),
    sourceFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    errorCode: z
      .enum([
        "workboard-disabled",
        "not-found",
        "forbidden",
        "timeout",
        "invalid-response",
        "identity-conflict",
      ])
      .optional(),
  })
  .superRefine((projection, ctx) => {
    if (projection.availability !== "available") {
      if (projection.sourceFingerprint !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "sourceFingerprint is valid only for available Workboard sources",
        });
      }
      if (
        projection.availability === "identity-conflict" &&
        projection.errorCode !== "identity-conflict"
      ) {
        ctx.addIssue({
          code: "custom",
          message: "identity-conflict projections require an identity-conflict error",
        });
      }
      if (
        projection.availability === "unavailable" &&
        (projection.errorCode === undefined || projection.errorCode === "identity-conflict")
      ) {
        ctx.addIssue({
          code: "custom",
          message: "unavailable projections require a non-identity refresh error",
        });
      }
      return;
    }
    if (projection.errorCode !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "available Workboard sources cannot carry a refresh error",
      });
    }
    if (projection.sourceFingerprint === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "available Workboard sources require a sourceFingerprint",
      });
      return;
    }
    if (
      projection.currentBoardId === undefined ||
      projection.status === undefined ||
      projection.sourceUpdatedAt === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "sourceFingerprint requires complete Workboard source fields",
      });
      return;
    }
    const sourceFingerprint = workboardProjectionFingerprint({
      ref: projection.ref,
      proofs: projection.proofs,
      artifacts: projection.artifacts,
      currentBoardId: projection.currentBoardId,
      status: projection.status,
      sourceUpdatedAt: projection.sourceUpdatedAt,
    });
    if (projection.sourceFingerprint !== sourceFingerprint) {
      ctx.addIssue({
        code: "custom",
        message: "sourceFingerprint does not match projection source",
      });
    }
  });

type ProjectionFingerprintInput = Pick<
  WorkProjection,
  "ref" | "proofs" | "artifacts" | "currentBoardId" | "status" | "sourceUpdatedAt"
> & {
  currentBoardId: string;
  status: string;
  sourceUpdatedAt: number;
};

/** Canonical binding for the latest Workboard source material on a projection. */
export function workboardProjectionFingerprint(projection: ProjectionFingerprintInput): string {
  const sortPairs = (pairs: Array<{ sourceId: string; digest: string }>) =>
    [...pairs]
      .map((pair) => ({ sourceId: pair.sourceId, digest: pair.digest }))
      .toSorted(
        (left, right) =>
          (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0) ||
          (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0),
      );
  const canonical = {
    cardId: projection.ref.cardId,
    cardCreatedAt: projection.ref.cardCreatedAt,
    currentBoardId: projection.currentBoardId,
    status: projection.status,
    sourceUpdatedAt: projection.sourceUpdatedAt,
    proofs: sortPairs(projection.proofs),
    artifacts: sortPairs(projection.artifacts),
  };
  return createHash("sha256")
    .update(`openclaw:workboard-projection:v1\0${stableStringify(canonical)}`, "utf8")
    .digest("hex");
}

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
  decidedPlan: z
    .strictObject({
      outcomeId: z.string().min(1),
      objective: z.string().min(1).max(4000),
      contractRevision: z.number().int().positive(),
      planGeneration: z.number().int().positive(),
      criteria: z.array(criterionSchema).min(1).max(5),
    })
    .refine((plan) => plan.criteria.some((criterion) => criterion.required), {
      message: "at least one criterion must be required",
    }),
  evidenceSetHash: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.string().max(2000).optional(),
  decidedAt: z.number().finite(),
});

const operationSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("workboard-card-start"),
  criterionId: z.string().min(1),
  planGeneration: z.number().int().nonnegative(),
  createdRevision: z.number().int().positive(),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(["prepared", "may-have-crossed", "succeeded", "failed", "unknown"]),
  target: workboardRefSchema,
  attemptedAt: z.number().finite().optional(),
  terminalAt: z.number().finite().optional(),
  resultDigest: z.string().min(1).optional(),
});

const acceptanceSchema = z.strictObject({
  id: z.string().min(1),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  acceptedRevision: z.number().int().positive(),
  profileId: z.string().min(1),
  acceptedAt: z.number().finite(),
  planGeneration: z.number().int().nonnegative(),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  closureHash: z.string().regex(/^[0-9a-f]{64}$/),
  acceptedPlan: z
    .strictObject({
      outcomeId: z.string().min(1),
      objective: z.string().min(1),
      contractRevision: z.number().int().positive(),
      planGeneration: z.number().int().positive(),
      criteria: z.array(criterionSchema).min(1).max(5),
    })
    .refine((plan) => plan.criteria.some((criterion) => criterion.required), {
      message: "at least one criterion must be required",
    }),
});

/** Strict persisted aggregate contract; adapters should parse before exposing records. */
function safePlanHash(input: CanonicalPlan): string | null {
  try {
    return planHash(input);
  } catch {
    return null;
  }
}

export const outcomeRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(160),
    createRequestHash: z.string().regex(/^[0-9a-f]{64}$/),
    managerProfileId: z.string().min(1),
    title: z.string().min(1).max(160),
    objective: z.string().min(1).max(4000),
    phase: z.enum(["draft", "active", "accepted", "cancelled"]),
    revision: z.number().int().positive(),
    contractRevision: z.number().int().positive(),
    planGeneration: z.number().int().nonnegative(),
    planHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    criteria: z.array(criterionSchema).min(1).max(5),
    projections: z.array(projectionSchema),
    evidence: z.array(evidenceSchema).max(100),
    decisions: z.array(decisionSchema).max(100),
    operations: z.array(operationSchema).max(20),
    acceptances: z.array(acceptanceSchema).max(20),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
  })
  .superRefine((record, ctx) => {
    const criterionIds = new Set<string>();
    const linkedRefs = new Set<string>();
    for (const criterion of record.criteria) {
      if (criterionIds.has(criterion.id)) {
        ctx.addIssue({ code: "custom", message: "criterion ids must be unique" });
      }
      criterionIds.add(criterion.id);
      const criterionRefs = new Set(
        criterion.workRefs.map((ref) => `${ref.cardId}\0${ref.cardCreatedAt}`),
      );
      if (criterionRefs.size !== criterion.workRefs.length) {
        ctx.addIssue({ code: "custom", message: "criterion refs must be unique" });
      }
      if (criterionRefs.size > 10) {
        ctx.addIssue({ code: "custom", message: "a criterion cannot link more than 10 refs" });
      }
      for (const ref of criterionRefs) {
        linkedRefs.add(ref);
      }
    }
    if (linkedRefs.size > 20) {
      ctx.addIssue({ code: "custom", message: "an outcome cannot link more than 20 refs" });
    }
    if (record.revision < record.contractRevision) {
      ctx.addIssue({ code: "custom", message: "revision cannot be below contractRevision" });
    }
    const decisionRevisions = new Set<number>();
    for (const decision of record.decisions) {
      if (decision.decidedRevision > record.revision) {
        ctx.addIssue({
          code: "custom",
          message: "decision revision cannot be ahead of the aggregate revision",
        });
      }
      if (decisionRevisions.has(decision.decidedRevision)) {
        ctx.addIssue({ code: "custom", message: "decision revisions must be unique" });
      }
      decisionRevisions.add(decision.decidedRevision);
    }
    for (const acceptance of record.acceptances) {
      if (acceptance.acceptedRevision > record.revision) {
        ctx.addIssue({
          code: "custom",
          message: "acceptance revision cannot be ahead of the aggregate revision",
        });
      }
    }
    for (const [label, items] of [
      ["evidence", record.evidence],
      ["decisions", record.decisions],
      ["operations", record.operations],
      ["acceptances", record.acceptances],
    ] as const) {
      const ids = new Set(items.map((item) => item.id));
      if (ids.size !== items.length) {
        ctx.addIssue({ code: "custom", message: `${label} ids must be unique` });
      }
    }
    if (!record.criteria.some((criterion) => criterion.required)) {
      ctx.addIssue({ code: "custom", message: "at least one criterion must be required" });
    }
    if (record.phase === "draft" && (record.planGeneration !== 0 || record.planHash !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "draft records must have generation 0 and null planHash",
      });
    }
    if (record.phase === "active" || record.phase === "accepted") {
      if (record.planGeneration < 1 || record.planHash === null) {
        ctx.addIssue({ code: "custom", message: "active and accepted records require a plan" });
      } else if (
        record.planHash !==
        safePlanHash({
          outcomeId: record.id,
          objective: record.objective,
          contractRevision: record.contractRevision,
          planGeneration: record.planGeneration,
          criteria: record.criteria,
        })
      ) {
        ctx.addIssue({
          code: "custom",
          message: "record planHash does not match its canonical plan",
        });
      }
    }
    if (record.phase === "cancelled") {
      const validDraftCancellation = record.planGeneration === 0 && record.planHash === null;
      const validPlannedCancellation =
        record.planGeneration > 0 &&
        record.planHash ===
          safePlanHash({
            outcomeId: record.id,
            objective: record.objective,
            contractRevision: record.contractRevision,
            planGeneration: record.planGeneration,
            criteria: record.criteria,
          });
      if (!validDraftCancellation && !validPlannedCancellation) {
        ctx.addIssue({
          code: "custom",
          message: "cancelled record must preserve a valid plan or draft state",
        });
      }
    }
    for (const decision of record.decisions) {
      if (
        decision.decidedPlan.outcomeId !== record.id ||
        decision.decidedPlan.planGeneration !== decision.planGeneration
      ) {
        ctx.addIssue({
          code: "custom",
          message: "decision snapshot does not match its outcome/generation",
        });
      }
      if (
        !decision.decidedPlan.criteria.some((criterion) => criterion.id === decision.criterionId)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "decision criterion is absent from its plan snapshot",
        });
      }
      if (decision.planHash !== safePlanHash(decision.decidedPlan)) {
        ctx.addIssue({ code: "custom", message: "decision planHash does not match its snapshot" });
      }
    }
    for (const acceptance of record.acceptances) {
      if (
        acceptance.acceptedPlan.outcomeId !== record.id ||
        acceptance.acceptedPlan.planGeneration !== acceptance.planGeneration
      ) {
        ctx.addIssue({
          code: "custom",
          message: "acceptance snapshot does not match its outcome/generation",
        });
      }
      if (acceptance.planHash !== safePlanHash(acceptance.acceptedPlan)) {
        ctx.addIssue({
          code: "custom",
          message: "acceptance planHash does not match its snapshot",
        });
      }
    }
  });

export function parseOutcomeRecord(input: unknown): PersistedOutcomeRecord {
  const record = outcomeRecordSchema.parse(input);
  assertOutcomeRecordSize(record);
  return record;
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

export const canonicalPlanSchema = z
  .strictObject({
    outcomeId: z.string().min(1).max(160),
    objective: z.string().min(1).max(4000),
    contractRevision: z.number().int().positive(),
    planGeneration: z.number().int().positive(),
    criteria: z.array(criterionSchema).min(1).max(5),
  })
  .refine((plan) => plan.criteria.some((criterion) => criterion.required), {
    message: "at least one criterion must be required",
  })
  .superRefine((plan, ctx) => {
    const criterionIds = new Set(plan.criteria.map((criterion) => criterion.id));
    if (criterionIds.size !== plan.criteria.length) {
      ctx.addIssue({ code: "custom", message: "criterion ids must be unique" });
    }
    const linkedRefs = new Set<string>();
    for (const criterion of plan.criteria) {
      const refs = new Set(criterion.workRefs.map((ref) => `${ref.cardId}\0${ref.cardCreatedAt}`));
      if (refs.size !== criterion.workRefs.length) {
        ctx.addIssue({ code: "custom", message: "criterion refs must be unique" });
      }
      if (refs.size > 10) {
        ctx.addIssue({ code: "custom", message: "a criterion cannot link more than 10 refs" });
      }
      for (const ref of refs) {
        linkedRefs.add(ref);
      }
    }
    if (linkedRefs.size > 20) {
      ctx.addIssue({ code: "custom", message: "an outcome cannot link more than 20 refs" });
    }
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

export function evidenceSetHash(input: {
  criterionId: string;
  planGeneration: number;
  sourceDigests: string[];
}): string {
  const canonical = {
    criterionId: input.criterionId,
    planGeneration: input.planGeneration,
    sourceDigests: [...new Set(input.sourceDigests)].toSorted(),
  };
  return createHash("sha256")
    .update(`openclaw:outcome-evidence-set:v1\0${stableStringify(canonical)}`, "utf8")
    .digest("hex");
}

export function closureHash(input: {
  outcomeId: string;
  planGeneration: number;
  planHash: string;
  requiredCriteria: Array<{
    criterionId: string;
    decisionId: string;
    decidedRevision: number;
    evidenceSetHash: string;
  }>;
}): string {
  const canonical = {
    outcomeId: input.outcomeId,
    planGeneration: input.planGeneration,
    planHash: input.planHash,
    requiredCriteria: [...input.requiredCriteria].toSorted((a, b) =>
      a.criterionId < b.criterionId ? -1 : a.criterionId > b.criterionId ? 1 : 0,
    ),
  };
  return createHash("sha256")
    .update(`openclaw:outcome-closure:v1\0${stableStringify(canonical)}`, "utf8")
    .digest("hex");
}

export class OutcomeRecordSizeError extends Error {
  readonly code = "outcome-record-too-large" as const;

  constructor(maxBytes: number) {
    super(`Outcome record exceeds ${maxBytes}-byte limit`);
    this.name = "OutcomeRecordSizeError";
  }
}

export function assertOutcomeRecordSize(
  record: unknown,
  maxBytes = OUTCOME_MAX_RECORD_BYTES,
): void {
  const bytes = outcomeRecordByteLength(record);
  if (bytes > maxBytes) {
    throw new OutcomeRecordSizeError(maxBytes);
  }
}

export function outcomeRecordByteLength(record: unknown): number {
  return Buffer.byteLength(stableStringify(record), "utf8");
}
