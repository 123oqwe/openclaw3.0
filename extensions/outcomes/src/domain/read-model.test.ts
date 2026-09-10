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

  it("reports source failures by criterion without leaking card identity", () => {
    const input = record();
    input.criteria[0].workRefs = [
      { owner: "workboard", cardId: "secret-card", cardCreatedAt: 4, boardIdAtLink: "board" },
    ];
    input.projections = [
      {
        ref: input.criteria[0].workRefs[0],
        availability: "identity-conflict",
        errorCode: "identity-conflict",
        observedAt: 5,
        proofs: [],
        artifacts: [],
      },
    ];
    const detail = toOutcomeDetail(input, 10);
    expect(detail.readiness).toBe("unavailable");
    expect(detail.sourceIssues).toEqual([{ criterionId: "c-1", reason: "identity-conflict" }]);
    expect(JSON.stringify(detail)).not.toContain("secret-card");
    expect(input.criteria[0].workRefs[0].cardId).toBe("secret-card");
  });
});
