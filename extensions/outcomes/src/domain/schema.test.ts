import { createHash } from "node:crypto";
import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";
import { describe, expect, it } from "vitest";
import {
  assertOutcomeRecordSize,
  canonicalPlanSchema,
  closureHash,
  createRequestHash,
  createRequestSchema,
  evidenceSetHash,
  outcomeRecordSchema,
  parseOutcomeRecord,
  planHash,
} from "./schema.js";

function malformedSnapshotPlanHash(plan: {
  outcomeId: string;
  objective: string;
  contractRevision: number;
  planGeneration: number;
  criteria: Array<{
    id: string;
    text: string;
    required: boolean;
    workRefs: Array<{
      owner: "workboard";
      cardId: string;
      cardCreatedAt: number;
      boardIdAtLink: string;
    }>;
  }>;
}): string {
  const canonical = {
    outcomeId: plan.outcomeId,
    objective: plan.objective,
    contractRevision: plan.contractRevision,
    planGeneration: plan.planGeneration,
    criteria: [...plan.criteria]
      .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((criterion) => ({
        id: criterion.id,
        text: criterion.text,
        required: criterion.required,
        workRefs: [...criterion.workRefs].toSorted((left, right) => {
          if (left.cardId !== right.cardId) {
            return left.cardId < right.cardId ? -1 : 1;
          }
          if (left.cardCreatedAt !== right.cardCreatedAt) {
            return left.cardCreatedAt - right.cardCreatedAt;
          }
          return left.boardIdAtLink < right.boardIdAtLink
            ? -1
            : left.boardIdAtLink > right.boardIdAtLink
              ? 1
              : 0;
        }),
      })),
  };
  return createHash("sha256")
    .update(`openclaw:outcome-plan:v1\0${stableStringify(canonical)}`, "utf8")
    .digest("hex");
}

describe("Outcome create schema and canonical hash", () => {
  it("accepts at most five criteria and produces order-independent hashes", () => {
    const base = {
      id: "o-1",
      title: "Ship",
      objective: "Ship safely",
      criteria: [
        {
          id: "c-1",
          text: "done",
          required: true,
          workRefs: [
            { owner: "workboard", cardId: "card", cardCreatedAt: 10, boardIdAtLink: "b" },
            { owner: "workboard", cardId: "card", cardCreatedAt: 2, boardIdAtLink: "a" },
          ],
        },
        { id: "c-2", text: "done", required: false, workRefs: [] },
        { id: "c-3", text: "verified", required: false, workRefs: [] },
        { id: "c-4", text: "reviewed", required: false, workRefs: [] },
        { id: "c-5", text: "accepted", required: false, workRefs: [] },
      ],
    };
    expect(createRequestSchema.parse(base).criteria).toHaveLength(5);
    expect(() =>
      createRequestSchema.parse({
        ...base,
        criteria: [
          {
            ...base.criteria[0],
            workRefs: [
              {
                owner: "workboard",
                cardId: "card-negative-time",
                cardCreatedAt: -1,
                boardIdAtLink: "board",
              },
            ],
          },
        ],
      }),
    ).toThrow();
    const reordered = { ...base, criteria: [...base.criteria].toReversed() };
    expect(createRequestHash(base)).toBe(createRequestHash(reordered));
    const refsReordered = {
      ...base,
      criteria: base.criteria.map((criterion) => ({
        id: criterion.id,
        text: criterion.text,
        required: criterion.required,
        workRefs: criterion.workRefs.toReversed(),
      })),
    };
    expect(createRequestHash(base)).toBe(createRequestHash(refsReordered));
    expect(createRequestHash(base)).not.toBe(createRequestHash({ ...base, objective: "changed" }));
    expect(() =>
      createRequestSchema.parse({
        ...base,
        criteria: Array.from({ length: 6 }, (_, i) => ({ ...base.criteria[0], id: `c-${i}` })),
      }),
    ).toThrow();
    expect(() =>
      createRequestSchema.parse({
        ...base,
        criteria: [
          {
            ...base.criteria[0],
            workRefs: Array.from({ length: 21 }, (_, i) => ({
              owner: "workboard" as const,
              cardId: `card-${i}`,
              cardCreatedAt: i,
              boardIdAtLink: "b",
            })),
          },
        ],
      }),
    ).toThrow();
  });

  it("bounds canonical historical plan references by card identity", () => {
    const ref = (index: number) => ({
      owner: "workboard" as const,
      cardId: `card-${index}`,
      cardCreatedAt: index,
      boardIdAtLink: "board-1",
    });
    const plan = {
      outcomeId: "o-history-bounds",
      objective: "Keep bounded history",
      contractRevision: 1,
      planGeneration: 1,
      criteria: [
        {
          id: "c-1",
          text: "one",
          required: true,
          workRefs: Array.from({ length: 10 }, (_, index) => ref(index)),
        },
        {
          id: "c-2",
          text: "two",
          required: false,
          workRefs: Array.from({ length: 10 }, (_, index) => ref(index + 10)),
        },
      ],
    };
    expect(canonicalPlanSchema.safeParse(plan).success).toBe(true);
    expect(
      canonicalPlanSchema.safeParse({
        ...plan,
        criteria: [
          { ...plan.criteria[0], workRefs: Array.from({ length: 11 }, (_, index) => ref(index)) },
        ],
      }).success,
    ).toBe(false);
    expect(
      canonicalPlanSchema.safeParse({
        ...plan,
        criteria: [
          ...plan.criteria,
          { id: "c-3", text: "three", required: false, workRefs: [ref(20)] },
        ],
      }).success,
    ).toBe(false);
  });

  it("enforces the UTF-8 aggregate size limit", () => {
    expect(() => assertOutcomeRecordSize({ text: "x".repeat(128 * 1024) })).toThrow();
    expect(() => assertOutcomeRecordSize({ text: "ok" })).not.toThrow();
    expect(() => assertOutcomeRecordSize({ text: "🙂".repeat(32765) + "a" })).not.toThrow();
    expect(() => assertOutcomeRecordSize({ text: "🙂".repeat(32765) + "aa" })).toThrow();
  });

  it("binds plan hashes to generation and contract revision", () => {
    const criterion = {
      id: "c-1",
      text: "done",
      required: true,
      workRefs: [],
    };
    const plan = {
      outcomeId: "o-1",
      objective: "Ship safely",
      contractRevision: 1,
      planGeneration: 1,
      criteria: [criterion],
    };
    expect(planHash(plan)).toHaveLength(64);
    expect(planHash(plan)).not.toBe(planHash({ ...plan, planGeneration: 2 }));
    expect(planHash(plan)).not.toBe(planHash({ ...plan, contractRevision: 2 }));
  });

  it("requires the complete persisted aggregate shape", () => {
    const record = {
      schemaVersion: 1,
      id: "o-1",
      createRequestHash: "a".repeat(64),
      managerProfileId: "manager-1",
      title: "Ship",
      objective: "Ship safely",
      phase: "draft" as const,
      revision: 1,
      contractRevision: 1,
      planGeneration: 0,
      planHash: null,
      criteria: [{ id: "c-1", text: "done", required: true, workRefs: [] }],
      projections: [],
      evidence: [],
      decisions: [],
      operations: [],
      acceptances: [],
      createdAt: 1,
      updatedAt: 1,
    };
    expect(outcomeRecordSchema.parse(record)).toEqual(record);
    expect(() => outcomeRecordSchema.parse({ ...record, managerProfileId: undefined })).toThrow();
  });

  it("applies the aggregate byte limit at the strict parse boundary", () => {
    const criterion = {
      id: "c-1",
      text: "done",
      required: true,
      workRefs: Array.from({ length: 10 }, (_, index) => ({
        owner: "workboard" as const,
        cardId: `card-${index}-${"x".repeat(20000)}`,
        cardCreatedAt: index,
        boardIdAtLink: "board",
      })),
    };
    const record = {
      schemaVersion: 1,
      id: "o-large",
      createRequestHash: "a".repeat(64),
      managerProfileId: "manager-1",
      title: "Ship",
      objective: "Ship safely",
      phase: "draft" as const,
      revision: 1,
      contractRevision: 1,
      planGeneration: 0,
      planHash: null,
      criteria: [criterion],
      projections: [],
      evidence: [],
      decisions: [],
      operations: [],
      acceptances: [],
      createdAt: 1,
      updatedAt: 1,
    };
    expect(() => outcomeRecordSchema.parse(record)).not.toThrow();
    expect(() => parseOutcomeRecord(record)).toThrow("131072-byte");
  });

  it("reports malformed historical snapshots through safeParse", () => {
    const plan = {
      outcomeId: "o-history",
      objective: "Keep history",
      contractRevision: 1,
      planGeneration: 1,
      criteria: [{ id: "c-1", text: "done", required: true, workRefs: [] }],
    };
    const record = {
      schemaVersion: 1,
      id: "o-history",
      createRequestHash: "a".repeat(64),
      managerProfileId: "manager-1",
      title: "History",
      objective: "Keep history",
      phase: "active" as const,
      revision: 2,
      contractRevision: 1,
      planGeneration: 1,
      planHash: planHash(plan),
      criteria: plan.criteria,
      projections: [],
      evidence: [],
      decisions: [],
      operations: [],
      acceptances: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const decision = {
      id: "decision-1",
      criterionId: "c-1",
      planGeneration: 1,
      decidedRevision: 2,
      status: "verified" as const,
      requestHash: "b".repeat(64),
      profileId: "manager-1",
      planHash: planHash(plan),
      decidedPlan: plan,
      evidenceSetHash: "d".repeat(64),
      decidedAt: 2,
    };
    const valid = { ...record, decisions: [decision] };
    expect(outcomeRecordSchema.safeParse(valid).success).toBe(true);
    expect(
      outcomeRecordSchema.safeParse({
        ...record,
        decisions: [decision, { ...decision, id: "decision-duplicate-revision" }],
      }).success,
    ).toBe(false);
    expect(
      outcomeRecordSchema.safeParse({
        ...record,
        decisions: [{ ...decision, decidedRevision: record.revision + 1 }],
      }).success,
    ).toBe(false);
    expect(malformedSnapshotPlanHash(plan)).toBe(planHash(plan));
    const historicalAcceptance = {
      id: "acceptance-1",
      requestHash: "c".repeat(64),
      acceptedRevision: 2,
      profileId: "manager-1",
      acceptedAt: 2,
      planGeneration: 1,
      planHash: planHash(plan),
      closureHash: "e".repeat(64),
      acceptedPlan: plan,
    };
    const acceptedHistory = { ...record, acceptances: [historicalAcceptance] };
    expect(outcomeRecordSchema.safeParse(acceptedHistory).success).toBe(true);
    expect(
      outcomeRecordSchema.safeParse({
        ...record,
        acceptances: [{ ...historicalAcceptance, acceptedRevision: record.revision + 1 }],
      }).success,
    ).toBe(false);
    const acceptanceWithDuplicateIdentity = {
      ...historicalAcceptance,
      acceptedPlan: {
        ...plan,
        criteria: [
          {
            ...plan.criteria[0],
            workRefs: [
              {
                owner: "workboard" as const,
                cardId: "card-1",
                cardCreatedAt: 1,
                boardIdAtLink: "board-1",
              },
              {
                owner: "workboard" as const,
                cardId: "card-1",
                cardCreatedAt: 1,
                boardIdAtLink: "board-2",
              },
            ],
          },
        ],
      },
    };
    expect(() =>
      outcomeRecordSchema.safeParse({
        ...record,
        acceptances: [
          {
            ...acceptanceWithDuplicateIdentity,
            planHash: malformedSnapshotPlanHash(acceptanceWithDuplicateIdentity.acceptedPlan),
          },
        ],
      }),
    ).not.toThrow();
    expect(
      outcomeRecordSchema.safeParse({
        ...record,
        acceptances: [
          {
            ...acceptanceWithDuplicateIdentity,
            planHash: malformedSnapshotPlanHash(acceptanceWithDuplicateIdentity.acceptedPlan),
          },
        ],
      }).success,
    ).toBe(false);
    const duplicateCriterionPlan = {
      ...plan,
      criteria: [...plan.criteria, { ...plan.criteria[0] }],
    };
    expect(
      outcomeRecordSchema.safeParse({
        ...record,
        decisions: [
          {
            ...decision,
            decidedPlan: duplicateCriterionPlan,
            planHash: malformedSnapshotPlanHash(duplicateCriterionPlan),
          },
        ],
      }).success,
    ).toBe(false);
    const sharedRefAcrossCriteriaPlan = {
      ...plan,
      criteria: [
        {
          ...plan.criteria[0],
          workRefs: [
            {
              owner: "workboard" as const,
              cardId: "card-1",
              cardCreatedAt: 1,
              boardIdAtLink: "board-1",
            },
          ],
        },
        {
          id: "c-2",
          text: "same card is allowed for another criterion",
          required: false,
          workRefs: [
            {
              owner: "workboard" as const,
              cardId: "card-1",
              cardCreatedAt: 1,
              boardIdAtLink: "board-2",
            },
          ],
        },
      ],
    };
    expect(
      outcomeRecordSchema.safeParse({
        ...record,
        decisions: [
          {
            ...decision,
            decidedPlan: sharedRefAcrossCriteriaPlan,
            planHash: planHash(sharedRefAcrossCriteriaPlan),
          },
        ],
      }).success,
    ).toBe(true);
    const duplicateRefPlan = {
      ...plan,
      criteria: [
        {
          ...plan.criteria[0],
          workRefs: [
            {
              owner: "workboard" as const,
              cardId: "card-1",
              cardCreatedAt: 1,
              boardIdAtLink: "board-2",
            },
            {
              owner: "workboard" as const,
              cardId: "card-1",
              cardCreatedAt: 1,
              boardIdAtLink: "board-1",
            },
          ],
        },
      ],
    };
    expect(
      outcomeRecordSchema.safeParse({
        ...record,
        decisions: [
          {
            ...decision,
            decidedPlan: duplicateRefPlan,
            planHash: malformedSnapshotPlanHash(duplicateRefPlan),
          },
        ],
      }).success,
    ).toBe(false);
    const malformed = {
      ...record,
      decisions: [{ ...decision, criterionId: "missing" }],
    };
    expect(() => outcomeRecordSchema.safeParse(malformed)).not.toThrow();
    expect(outcomeRecordSchema.safeParse(malformed).success).toBe(false);
    expect(
      outcomeRecordSchema.safeParse({
        ...record,
        decisions: [{ ...decision, planHash: "c".repeat(64) }],
      }).success,
    ).toBe(false);
    expect(
      outcomeRecordSchema.safeParse({
        ...record,
        decisions: [
          {
            ...decision,
            decidedPlan: {
              ...plan,
              criteria: [{ ...plan.criteria[0], required: false }],
            },
          },
        ],
      }).success,
    ).toBe(false);
    const nextPlan = {
      ...plan,
      planGeneration: 2,
      criteria: [{ id: "c-2", text: "new", required: true, workRefs: [] }],
    };
    expect(
      outcomeRecordSchema.safeParse({
        ...record,
        revision: 3,
        planGeneration: 2,
        planHash: planHash(nextPlan),
        criteria: nextPlan.criteria,
        decisions: [decision],
      }).success,
    ).toBe(true);
    expect(
      outcomeRecordSchema.safeParse({
        ...record,
        revision: 3,
        planGeneration: 2,
        planHash: planHash(nextPlan),
        criteria: nextPlan.criteria,
        acceptances: [historicalAcceptance],
      }).success,
    ).toBe(true);
  });

  it("preserves only coherent cancelled plan state", () => {
    const draft = {
      schemaVersion: 1,
      id: "o-cancel",
      createRequestHash: "a".repeat(64),
      managerProfileId: "m",
      title: "x",
      objective: "y",
      phase: "cancelled" as const,
      revision: 1,
      contractRevision: 1,
      planGeneration: 0,
      planHash: null,
      criteria: [{ id: "c", text: "done", required: true, workRefs: [] }],
      projections: [],
      evidence: [],
      decisions: [],
      operations: [],
      acceptances: [],
      createdAt: 1,
      updatedAt: 1,
    };
    expect(outcomeRecordSchema.safeParse(draft).success).toBe(true);
    expect(outcomeRecordSchema.safeParse({ ...draft, planGeneration: 1 }).success).toBe(false);
    expect(outcomeRecordSchema.safeParse({ ...draft, planHash: "a".repeat(64) }).success).toBe(
      false,
    );
    const planned = {
      ...draft,
      planGeneration: 1,
      planHash: planHash({
        outcomeId: draft.id,
        objective: draft.objective,
        contractRevision: 1,
        planGeneration: 1,
        criteria: draft.criteria,
      }),
    };
    expect(outcomeRecordSchema.safeParse(planned).success).toBe(true);
  });

  it("rejects unknown future schema versions", () => {
    const future = {
      schemaVersion: 2,
      id: "future",
      createRequestHash: "a".repeat(64),
      managerProfileId: "manager-1",
      title: "Future",
      objective: "Future",
      phase: "draft" as const,
      revision: 1,
      contractRevision: 1,
      planGeneration: 0,
      planHash: null,
      criteria: [{ id: "c", text: "criterion", required: true, workRefs: [] }],
      projections: [],
      evidence: [],
      decisions: [],
      operations: [],
      acceptances: [],
      createdAt: 1,
      updatedAt: 1,
    };
    expect(outcomeRecordSchema.safeParse(future).success).toBe(false);
  });

  it("rejects duplicate criteria and overlinked work references", () => {
    const base = {
      schemaVersion: 1 as const,
      id: "o-links",
      createRequestHash: "a".repeat(64),
      managerProfileId: "manager-1",
      title: "Links",
      objective: "Validate links",
      phase: "draft" as const,
      revision: 1,
      contractRevision: 1,
      planGeneration: 0,
      planHash: null,
      criteria: [{ id: "c-1", text: "Done", required: true, workRefs: [] }],
      projections: [],
      evidence: [],
      decisions: [],
      operations: [],
      acceptances: [],
      createdAt: 1,
      updatedAt: 1,
    };
    expect(
      outcomeRecordSchema.safeParse({ ...base, criteria: [base.criteria[0], base.criteria[0]] })
        .success,
    ).toBe(false);
    const refs = Array.from({ length: 21 }, (_, index) => ({
      owner: "workboard" as const,
      cardId: `card-${index}`,
      cardCreatedAt: index,
      boardIdAtLink: "board",
    }));
    expect(
      outcomeRecordSchema.safeParse({
        ...base,
        criteria: [{ ...base.criteria[0], workRefs: refs }],
      }).success,
    ).toBe(false);
    expect(
      outcomeRecordSchema.safeParse({
        ...base,
        criteria: [
          {
            ...base.criteria[0],
            workRefs: [refs[0], refs[0]],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("canonicalizes evidence and closure hashes deterministically", () => {
    expect(
      evidenceSetHash({ criterionId: "c", planGeneration: 2, sourceDigests: ["b", "a", "a"] }),
    ).toBe(evidenceSetHash({ criterionId: "c", planGeneration: 2, sourceDigests: ["a", "b"] }));
    const input = {
      outcomeId: "o",
      planGeneration: 2,
      planHash: "p".repeat(64),
      requiredCriteria: [
        { criterionId: "b", decisionId: "d2", decidedRevision: 4, evidenceSetHash: "e2" },
        { criterionId: "a", decisionId: "d1", decidedRevision: 3, evidenceSetHash: "e1" },
      ],
    };
    expect(closureHash(input)).toBe(
      closureHash({ ...input, requiredCriteria: input.requiredCriteria.toReversed() }),
    );
  });
});
