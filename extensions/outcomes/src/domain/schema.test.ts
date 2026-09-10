import { describe, expect, it } from "vitest";
import { assertOutcomeRecordSize, createRequestHash, createRequestSchema } from "./schema.js";

describe("Outcome create schema and canonical hash", () => {
  it("accepts at most five criteria and produces order-independent hashes", () => {
    const base = {
      id: "o-1",
      title: "Ship",
      objective: "Ship safely",
      criteria: [
        { id: "c-2", text: "done", required: false, workRefs: [{ owner: "workboard", cardId: "card", cardCreatedAt: 10, boardIdAtLink: "b" }] },
        { id: "c-1", text: "done", required: true, workRefs: [{ owner: "workboard", cardId: "card", cardCreatedAt: 2, boardIdAtLink: "a" }] },
      ],
    };
    expect(createRequestSchema.parse(base).criteria).toHaveLength(1);
    const reordered = { ...base, criteria: [...base.criteria].reverse() };
    expect(createRequestHash(base)).toBe(createRequestHash(reordered));
    expect(createRequestHash(base)).not.toBe(createRequestHash({ ...base, objective: "changed" }));
    expect(() => createRequestSchema.parse({ ...base, criteria: Array.from({ length: 6 }, (_, i) => ({ ...base.criteria[0], id: `c-${i}` })) })).toThrow();
  });

  it("enforces the UTF-8 aggregate size limit", () => {
    expect(() => assertOutcomeRecordSize({ text: "x".repeat(128 * 1024) })).toThrow();
    expect(() => assertOutcomeRecordSize({ text: "ok" })).not.toThrow();
  });
});
