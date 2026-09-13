import { describe, expect, it } from "vitest";
import { toOutcomeDetail, toOutcomeSummary } from "./read-model.js";
import { parseOutcomeRecord, planHash } from "./schema.js";
import type { OutcomeRecord } from "./types.js";

function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error("fixture item missing");
  }
  return item;
}

function record(): OutcomeRecord {
  const criteria = [{ id: "c-1", text: "Done", required: true, workRefs: [] }];
  return {
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
    planHash: planHash({
      outcomeId: "outcome-1",
      objective: "Ship safely",
      contractRevision: 1,
      planGeneration: 1,
      criteria,
    }),
    criteria,
    projections: [],
    evidence: [],
    decisions: [],
    operations: [],
    acceptances: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("Outcome read model observations", () => {
  it("uses last successful observation and the inclusive 24-hour boundary", () => {
    const input = record();
    const ref = {
      owner: "workboard" as const,
      cardId: "card",
      cardCreatedAt: 1,
      boardIdAtLink: "board",
    };
    first(input.criteria).workRefs = [ref];
    input.projections = [
      {
        ref,
        availability: "available",
        observedAt: 99,
        lastSuccessfulAt: 1,
        proofs: [],
        artifacts: [],
      },
    ];
    expect(toOutcomeSummary(input, 1 + 24 * 60 * 60 * 1000 - 1).readiness).toBe("incomplete");
    expect(toOutcomeSummary(input, 1 + 24 * 60 * 60 * 1000).readiness).toBe("stale");
  });

  it("ignores unlinked failures and reports every criterion sharing a ref", () => {
    const input = record();
    const current = {
      owner: "workboard" as const,
      cardId: "shared",
      cardCreatedAt: 1,
      boardIdAtLink: "board",
    };
    const old = {
      owner: "workboard" as const,
      cardId: "old",
      cardCreatedAt: 1,
      boardIdAtLink: "board",
    };
    first(input.criteria).workRefs = [current];
    input.criteria.push({ id: "c-2", text: "Also done", required: true, workRefs: [current] });
    input.projections = [
      {
        ref: current,
        availability: "identity-conflict",
        errorCode: "identity-conflict",
        observedAt: 1,
        proofs: [],
        artifacts: [],
      },
      {
        ref: old,
        availability: "identity-conflict",
        errorCode: "identity-conflict",
        observedAt: 1,
        proofs: [],
        artifacts: [],
      },
      {
        ref: current,
        availability: "identity-conflict",
        errorCode: "identity-conflict",
        observedAt: 2,
        proofs: [],
        artifacts: [],
      },
    ];
    const detail = toOutcomeDetail(input, 10);
    expect(detail.sourceIssues).toEqual([
      { criterionId: "c-1", reason: "identity-conflict" },
      { criterionId: "c-2", reason: "identity-conflict" },
    ]);
    expect(detail.sourceIssues.map((issue) => issue.criterionId)).not.toContain("old");
    expect(detail.sourceIssues).toHaveLength(2);
  });

  it("ignores an old failed projection after its link is removed", () => {
    const input = record();
    input.projections = [
      {
        ref: { owner: "workboard", cardId: "old", cardCreatedAt: 1, boardIdAtLink: "board" },
        availability: "identity-conflict",
        errorCode: "identity-conflict",
        observedAt: 1,
        proofs: [],
        artifacts: [],
      },
    ];
    expect(toOutcomeSummary(input, 10).readiness).toBe("incomplete");
  });

  it("keeps a valid historical acceptance reviewable until observed again", () => {
    const input = record();
    input.phase = "accepted";
    input.acceptances = [
      {
        id: "accept-1",
        requestHash: "f".repeat(64),
        acceptedRevision: 2,
        profileId: "manager-1",
        acceptedAt: 2,
        planGeneration: 1,
        planHash: input.planHash!,
        closureHash: "e".repeat(64),
        acceptedPlan: {
          outcomeId: input.id,
          objective: input.objective,
          contractRevision: 1,
          planGeneration: 1,
          criteria: input.criteria,
        },
      },
    ];
    expect(() => parseOutcomeRecord(input)).not.toThrow();
    expect(toOutcomeSummary(input, 10).acceptanceValidity).toBe("needs-review");
    expect(toOutcomeDetail(input, 10).acceptance).toEqual({
      acceptanceValidity: "needs-review",
      reason: "not-rechecked",
    });
  });
});
