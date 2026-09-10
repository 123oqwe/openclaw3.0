import { describe, expect, it } from "vitest";
import { toOutcomeDetail, toOutcomeSummary } from "./read-model.js";
import type { OutcomeRecord } from "./types.js";

const record = (): OutcomeRecord => ({
  schemaVersion: 1,
  id: "outcome-1",
  createRequestHash: "a".repeat(64),
  managerProfileId: "manager-1",
  title: "Ship",
  objective: "Ship safely",
  phase: "active",
  revision: 2,
  contractRevision: 1,
  planGeneration: 1,
  planHash: "b".repeat(64),
  criteria: [{ id: "c-1", text: "Done", required: true, workRefs: [] }],
  projections: [],
  evidence: [],
  decisions: [],
  operations: [],
  acceptances: [],
  createdAt: 1,
  updatedAt: 2,
});

describe("Outcome P-01 read model", () => {
  it("derives a redacted summary and detail", () => {
    const summary = toOutcomeSummary(record());
    expect(summary).toEqual({
      id: "outcome-1",
      title: "Ship",
      phase: "active",
      revision: 2,
      updatedAt: 2,
      readiness: "incomplete",
      acceptanceValidity: "none",
    });
    const detail = toOutcomeDetail(record(), 10);
    expect(detail.id).toBe("outcome-1");
    expect(detail.objective).toBe("Ship safely");
    expect(detail).not.toHaveProperty("managerProfileId");
    expect(detail).not.toHaveProperty("createRequestHash");
    expect(detail).not.toHaveProperty("operations");
  });
});
