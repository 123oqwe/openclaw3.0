import { describe, expect, it } from "vitest";
import { assertOutcomeRecordSize, createRequestHash, createRequestSchema } from "./schema.js";

describe("Outcome create schema and canonical hash", () => {
  it("accepts at most five criteria and produces order-independent hashes", () => {
    const base = {
      id: "o-1",
      title: "Ship",
      objective: "Ship safely",
      criteria: [{ id: "c-1", text: "done", required: true, workRefs: [] }],
    };
    expect(createRequestSchema.parse(base).criteria).toHaveLength(1);
    expect(createRequestHash(base)).toBe(createRequestHash({ ...base, criteria: [...base.criteria].reverse() }));
    expect(() => createRequestSchema.parse({ ...base, criteria: Array.from({ length: 6 }, (_, i) => ({ ...base.criteria[0], id: `c-${i}` })) })).toThrow();
  });

  it("enforces the UTF-8 aggregate size limit", () => {
    expect(() => assertOutcomeRecordSize({ text: "x".repeat(128 * 1024) })).toThrow();
    expect(() => assertOutcomeRecordSize({ text: "ok" })).not.toThrow();
  });
});
