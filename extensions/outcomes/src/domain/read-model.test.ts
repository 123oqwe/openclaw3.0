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
    const summary = toOutcomeSummary(record(), 10);
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

  it("never treats historical decisions as current readiness", () => {
    const input = record();
    input.decisions = [
      {
        id: "decision-old",
        criterionId: "c-1",
        planGeneration: 0,
        decidedRevision: 1,
        status: "verified",
        requestHash: "c".repeat(64),
        profileId: "manager-1",
        planHash: "d".repeat(64),
        decidedPlan: {
          outcomeId: input.id,
          objective: input.objective,
          contractRevision: 1,
          planGeneration: 0,
          criteria: input.criteria,
        },
        evidenceSetHash: "e".repeat(64),
        decidedAt: 1,
      },
    ];
    expect(toOutcomeSummary(input, 10).readiness).toBe("incomplete");
  });

  it("uses last successful observation and the inclusive 24-hour boundary", () => {
    const input = record();
    const ref = {
      owner: "workboard" as const,
      cardId: "card",
      cardCreatedAt: 1,
      boardIdAtLink: "board",
    };
    input.criteria[0].workRefs = [ref];
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
    input.criteria[0].workRefs = [current];
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
        planHash: input.planHash,
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
    expect(toOutcomeSummary(input, 10).acceptanceValidity).toBe("needs-review");
  });
});
