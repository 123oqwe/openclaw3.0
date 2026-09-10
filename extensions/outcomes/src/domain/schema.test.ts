import { describe, expect, it } from "vitest";
import { assertOutcomeRecordSize, createRequestHash, createRequestSchema, planHash } from "./schema.js";

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
});
