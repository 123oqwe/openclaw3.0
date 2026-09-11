import { describe, expect, it } from "vitest";
import { OUTCOME_PROJECTION_MAX_AGE_MS } from "@openclaw/outcomes-contract";
import { evidenceSetHash } from "./hash.js";
import { toOutcomeDetail, toOutcomeSummary } from "./read-model.js";
import { parseOutcomeRecord, planHash, workboardProjectionFingerprint } from "./schema.js";
import type { OutcomeRecord } from "./types.js";

function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error("fixture item missing");
  }
  return item;
}
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
  planHash: planHash({
    outcomeId: "outcome-1",
    objective: "Ship safely",
    contractRevision: 1,
    planGeneration: 1,
    criteria: [{ id: "c-1", text: "Done", required: true, workRefs: [] }],
  }),
  criteria: [{ id: "c-1", text: "Done", required: true, workRefs: [] }],
  projections: [],
  evidence: [],
  decisions: [],
  operations: [],
  acceptances: [],
  createdAt: 1,
  updatedAt: 2,
});

function valid(input: OutcomeRecord): OutcomeRecord {
  for (const projection of input.projections) {
    if (
      projection.availability === "available" &&
      projection.currentBoardId !== undefined &&
      projection.status !== undefined &&
      projection.sourceUpdatedAt !== undefined
    ) {
      projection.sourceFingerprint = workboardProjectionFingerprint({
        ref: projection.ref,
        proofs: projection.proofs,
        artifacts: projection.artifacts,
        currentBoardId: projection.currentBoardId,
        status: projection.status,
        sourceUpdatedAt: projection.sourceUpdatedAt,
      });
    }
  }
  input.planHash = planHash({
    outcomeId: input.id,
    objective: input.objective,
    contractRevision: input.contractRevision,
    planGeneration: input.planGeneration,
    criteria: input.criteria,
  });
  return parseOutcomeRecord(input);
}

function withCurrentVerifiedEvidence(input: OutcomeRecord): OutcomeRecord {
  const ref = {
    owner: "workboard" as const,
    cardId: "card-current",
    cardCreatedAt: 1,
    boardIdAtLink: "board-link",
  };
  const criterion = first(input.criteria);
  criterion.workRefs = [ref];
  input.planHash = planHash({
    outcomeId: input.id,
    objective: input.objective,
    contractRevision: input.contractRevision,
    planGeneration: input.planGeneration,
    criteria: input.criteria,
  });
  input.projections = [
    {
      ref,
      availability: "available",
      currentBoardId: "board-current",
      status: "done",
      sourceUpdatedAt: 10,
      observedAt: 10,
      lastSuccessfulAt: 10,
      proofs: [{ sourceId: "proof-1", digest: "proof-digest-1" }],
      artifacts: [],
    },
  ];
  input.evidence = [
    {
      id: "evidence-1",
      criterionId: criterion.id,
      planGeneration: input.planGeneration,
      workRef: ref,
      kind: "workboard-proof",
      sourceId: "proof-1",
      sourceDigest: "proof-digest-1",
      observedAt: 10,
    },
  ];
  input.decisions = [
    {
      id: "decision-verified",
      criterionId: criterion.id,
      planGeneration: input.planGeneration,
      decidedRevision: input.revision,
      status: "verified",
      requestHash: "d".repeat(64),
      profileId: input.managerProfileId,
      planHash: input.planHash!,
      decidedPlan: {
        outcomeId: input.id,
        objective: input.objective,
        contractRevision: input.contractRevision,
        planGeneration: input.planGeneration,
        criteria: input.criteria,
      },
      evidenceSetHash: evidenceSetHash({
        criterionId: criterion.id,
        planGeneration: input.planGeneration,
        sourceDigests: ["proof-digest-1"],
      }),
      decidedAt: 10,
    },
  ];
  return valid(input);
}

function syncCurrentDecisionPlan(input: OutcomeRecord): OutcomeRecord {
  input.planHash = planHash({
    outcomeId: input.id,
    objective: input.objective,
    contractRevision: input.contractRevision,
    planGeneration: input.planGeneration,
    criteria: input.criteria,
  });
  const decision = first(input.decisions);
  decision.planHash = input.planHash;
  decision.decidedPlan = {
    outcomeId: input.id,
    objective: input.objective,
    contractRevision: input.contractRevision,
    planGeneration: input.planGeneration,
    criteria: input.criteria,
  };
  return valid(input);
}

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

  it("returns source fields only from explicit authorized read material", () => {
    const input = withCurrentVerifiedEvidence(record());
    const ref = first(first(input.criteria).workRefs);
    const restricted = toOutcomeDetail(input, 10);
    expect(restricted.criteria[0]).toMatchObject({ workRefs: [], sourcesVisibility: "restricted" });
    expect(restricted.work).toEqual([]);

    const complete = toOutcomeDetail(input, 10, [
      {
        ref,
        currentBoardId: "board-current",
        status: "done",
        sourceUpdatedAt: 10,
        upstreamStale: false,
        evidence: [
          {
            id: "evidence-1",
            criterionId: "c-1",
            workRef: ref,
            kind: "workboard-proof",
            sourceId: "proof-1",
            sourceDigest: "proof-digest-1",
            observedAt: 10,
            planGeneration: 1,
            sourceCreatedAt: 9,
            label: "Hosted proof",
            proofStatus: "passed",
            url: "https://example.test/proof-1",
          },
        ],
      },
    ]);
    expect(complete.criteria[0]).toMatchObject({
      workRefs: [ref],
      sourcesVisibility: "complete",
      evidenceSetHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(complete.work).toMatchObject([{ ref, currentBoardId: "board-current", status: "done" }]);
    expect(complete.evidence).toMatchObject([
      { sourceId: "proof-1", label: "Hosted proof", proofStatus: "passed" },
    ]);
  });

  it("reports source failures by criterion without leaking card identity", () => {
    const input = record();
    const criterion = first(input.criteria);
    criterion.workRefs = [
      { owner: "workboard", cardId: "secret-card", cardCreatedAt: 4, boardIdAtLink: "board" },
    ];
    input.projections = [
      {
        ref: first(criterion.workRefs),
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
    expect(first(criterion.workRefs).cardId).toBe("secret-card");
  });

  it.each([
    ["required", true],
    ["optional", false],
  ])("blocks when a %s linked card is blocked", (_label, required) => {
    const input = record();
    input.criteria = [
      { id: "c-required", text: "Required", required: true, workRefs: [] },
      {
        id: "c-1",
        text: "Done",
        required,
        workRefs: [
          { owner: "workboard", cardId: "card", cardCreatedAt: 1, boardIdAtLink: "board" },
        ],
      },
    ];
    input.projections = [
      {
        ref: input.criteria[1]!.workRefs[0]!,
        availability: "available",
        currentBoardId: "board-current",
        status: "blocked",
        observedAt: 1,
        lastSuccessfulAt: 10,
        sourceUpdatedAt: 10,
        proofs: [],
        artifacts: [],
      },
    ];
    expect(toOutcomeSummary(valid(input), 10).readiness).toBe("blocked");
  });

  it.each(["prepared", "may-have-crossed", "unknown"] as const)(
    "blocks when an operation is %s",
    (state) => {
      const input = record();
      const ref = {
        owner: "workboard" as const,
        cardId: "card",
        cardCreatedAt: 1,
        boardIdAtLink: "board",
      };
      input.criteria[0]!.workRefs = [ref];
      input.operations = [
        {
          id: `op-${state}`,
          kind: "workboard-card-start",
          criterionId: "c-1",
          planGeneration: 1,
          createdRevision: 2,
          requestHash: "b".repeat(64),
          state,
          target: ref,
          attemptedAt: 1,
        },
      ];
      expect(toOutcomeSummary(valid(input), 10).readiness).toBe("blocked");
    },
  );

  it("keeps unavailable and stale ahead of blocked", () => {
    const input = record();
    input.criteria = [
      {
        id: "c-1",
        text: "Done",
        required: true,
        workRefs: [
          { owner: "workboard", cardId: "card", cardCreatedAt: 1, boardIdAtLink: "board" },
        ],
      },
    ];
    input.projections = [
      {
        ref: input.criteria[0]!.workRefs[0]!,
        availability: "unavailable",
        errorCode: "timeout",
        currentBoardId: "board-current",
        status: "blocked",
        observedAt: 1,
        lastSuccessfulAt: 10,
        sourceUpdatedAt: 10,
        proofs: [],
        artifacts: [],
      },
    ];
    expect(toOutcomeSummary(valid(input), 10).readiness).toBe("unavailable");
    input.projections[0]!.availability = "available";
    delete input.projections[0]!.errorCode;
    input.projections[0]!.lastSuccessfulAt = 0;
    expect(toOutcomeSummary(valid(input), 24 * 60 * 60 * 1000 + 1).readiness).toBe("stale");
  });

  it("turns stale exactly at 24 hours and derives the earliest valid recheck time", () => {
    const input = record();
    const ref = { owner: "workboard" as const, cardId: "card-fresh", cardCreatedAt: 1, boardIdAtLink: "board" };
    input.criteria[0]!.workRefs = [ref];
    input.projections = [
      {
        ref,
        availability: "available",
        observedAt: 100,
        lastSuccessfulAt: 100,
        currentBoardId: "board",
        status: "done",
        sourceUpdatedAt: 100,
        proofs: [],
        artifacts: [],
      },
    ];
    const parsed = valid(input);
    expect(toOutcomeSummary(parsed, 100 + OUTCOME_PROJECTION_MAX_AGE_MS - 1).readiness).toBe("incomplete");
    expect(toOutcomeSummary(parsed, 100 + OUTCOME_PROJECTION_MAX_AGE_MS).readiness).toBe("stale");
    expect(toOutcomeDetail(parsed, 101).recheckAfter).toBe(100 + OUTCOME_PROJECTION_MAX_AGE_MS);
    parsed.projections[0]!.upstreamStale = true;
    expect(toOutcomeSummary(valid(parsed), 101).readiness).toBe("stale");
    expect(toOutcomeDetail(valid(parsed), 101).recheckAfter).toBeNull();
  });

  it.each(["succeeded", "failed"] as const)(
    "ignores terminal %s operations and preserves input",
    (state) => {
      const input = record();
      input.operations = [
        {
          id: "op-done",
          kind: "workboard-card-start",
          criterionId: "c-1",
          planGeneration: 1,
          createdRevision: 2,
          requestHash: "b".repeat(64),
          state,
          target: { owner: "workboard", cardId: "card", cardCreatedAt: 1, boardIdAtLink: "board" },
        },
      ];
      const parsed = valid(input);
      const before = structuredClone(parsed);
      expect(toOutcomeSummary(parsed, 10).readiness).toBe("incomplete");
      expect(parsed).toEqual(before);
    },
  );

  it("ignores a blocked projection after its link is removed", () => {
    const input = record();
    input.projections = [
      {
        ref: { owner: "workboard", cardId: "old-card", cardCreatedAt: 1, boardIdAtLink: "board" },
        availability: "available",
        currentBoardId: "board-current",
        status: "blocked",
        observedAt: 1,
        lastSuccessfulAt: 10,
        sourceUpdatedAt: 10,
        proofs: [],
        artifacts: [],
      },
    ];
    const parsed = valid(input);
    const before = structuredClone(parsed);
    expect(toOutcomeSummary(parsed, 10).readiness).toBe("incomplete");
    expect(parsed).toEqual(before);
  });

  it("never treats historical decisions as current readiness", () => {
    const input = record();
    input.planGeneration = 2;
    input.planHash = planHash({
      outcomeId: input.id,
      objective: input.objective,
      contractRevision: input.contractRevision,
      planGeneration: 2,
      criteria: input.criteria,
    });
    input.decisions = [
      {
        id: "decision-old",
        criterionId: "c-1",
        planGeneration: 1,
        decidedRevision: 1,
        status: "verified",
        requestHash: "c".repeat(64),
        profileId: "manager-1",
        planHash: planHash({
          outcomeId: input.id,
          objective: input.objective,
          contractRevision: 1,
          planGeneration: 1,
          criteria: input.criteria,
        }),
        decidedPlan: {
          outcomeId: input.id,
          objective: input.objective,
          contractRevision: 1,
          planGeneration: 1,
          criteria: input.criteria,
        },
        evidenceSetHash: "e".repeat(64),
        decidedAt: 1,
      },
    ];
    expect(toOutcomeSummary(input, 10).readiness).toBe("incomplete");
  });

  it("does not promote persisted verification to ready before P-02 source authorization", () => {
    const input = withCurrentVerifiedEvidence(record());
    expect(toOutcomeSummary(input, 10).readiness).toBe("incomplete");

    input.projections[0]!.ref = {
      ...input.projections[0]!.ref,
      boardIdAtLink: "board-moved-after-link",
    };
    expect(toOutcomeSummary(valid(input), 10).readiness).toBe("incomplete");

    input.projections[0]!.proofs[0]!.digest = "changed-proof-digest";
    expect(toOutcomeSummary(valid(input), 10).readiness).toBe("incomplete");
  });

  it("blocks only a current rejected decision whose evidence still matches", () => {
    const input = withCurrentVerifiedEvidence(record());
    const current = first(input.decisions);
    input.decisions = [{ ...current, id: "decision-current-rejected", status: "rejected" }];
    expect(toOutcomeSummary(valid(input), 10).readiness).toBe("blocked");

    input.projections[0]!.proofs[0]!.digest = "changed-proof-digest";
    expect(toOutcomeSummary(valid(input), 10).readiness).toBe("incomplete");
  });

  it("does not select a rejected decision after its criterion is unlinked", () => {
    const input = withCurrentVerifiedEvidence(record());
    const current = first(input.decisions);
    input.decisions = [{ ...current, id: "decision-unlinked-rejected", status: "rejected" }];
    first(input.criteria).workRefs = [];
    expect(toOutcomeSummary(syncCurrentDecisionPlan(input), 10).readiness).toBe("incomplete");
  });

  it.each(["missing projection", "source from another linked card"])(
    "does not select a rejected decision with %s",
    (caseName) => {
      const input = withCurrentVerifiedEvidence(record());
      const criterion = first(input.criteria);
      const secondRef = {
        owner: "workboard" as const,
        cardId: "card-second",
        cardCreatedAt: 2,
        boardIdAtLink: "board-link",
      };
      criterion.workRefs.push(secondRef);
      const current = first(input.decisions);
      input.decisions = [{ ...current, id: `decision-rejected-${caseName}`, status: "rejected" }];
      if (caseName === "source from another linked card") {
        input.projections.push({
          ref: secondRef,
          availability: "available",
          currentBoardId: "board-current",
          status: "done",
          observedAt: 10,
          lastSuccessfulAt: 10,
          sourceUpdatedAt: 10,
          proofs: [],
          artifacts: [],
        });
        first(input.evidence).workRef = secondRef;
      }
      expect(toOutcomeSummary(syncCurrentDecisionPlan(input), 10).readiness).toBe("incomplete");
    },
  );

  it("lets the newest current decision supersede historical rejection", () => {
    const input = withCurrentVerifiedEvidence(record());
    const current = first(input.decisions);
    input.decisions = [
      { ...current, id: "decision-old-rejected", decidedRevision: 1, status: "rejected" },
      current,
    ];
    expect(toOutcomeSummary(valid(input), 10).readiness).toBe("incomplete");
  });

  it("uses last successful observation and the inclusive 24-hour boundary", () => {
    const input = record();
    const ref = {
      owner: "workboard" as const,
      cardId: "card",
      cardCreatedAt: 1,
      boardIdAtLink: "board",
    };
    const criterion = first(input.criteria);
    criterion.workRefs = [ref];
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
    const firstCriterion = first(input.criteria);
    firstCriterion.workRefs = [current];
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
  });
});
