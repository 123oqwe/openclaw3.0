import { describe, expect, it } from "vitest";
import type { OutcomeRecord } from "../domain/types.js";
import { deriveOutcomeAttention } from "./attention.js";

function record(): OutcomeRecord {
  return {
    schemaVersion: 1,
    id: "outcome-1",
    createRequestHash: "a".repeat(64),
    managerProfileId: "manager-1",
    title: "Ship",
    objective: "Ship safely",
    phase: "draft",
    revision: 1,
    contractRevision: 1,
    planGeneration: 0,
    planHash: null,
    criteria: [{ id: "criterion-1", text: "Done", required: true, workRefs: [] }],
    projections: [],
    evidence: [],
    decisions: [],
    operations: [],
    acceptances: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("Outcome delete guidance", () => {
  it.each(["draft", "cancelled"] as const)(
    "offers delete for a quiescent %s Outcome without acceptance history",
    (phase) => {
      expect(deriveOutcomeAttention({ ...record(), phase }, [], 1, null).nextActions).toContain(
        "delete",
      );
    },
  );

  it("withholds delete after an accepted Outcome is later changed and cancelled", () => {
    const acceptedThenCancelled: OutcomeRecord = {
      ...record(),
      phase: "cancelled",
      revision: 4,
      contractRevision: 2,
      acceptances: [
        {
          id: "acceptance-1",
          requestHash: "b".repeat(64),
          acceptedRevision: 2,
          profileId: "manager-1",
          acceptedAt: 2,
          planGeneration: 1,
          planHash: "c".repeat(64),
          closureHash: "d".repeat(64),
          acceptedPlan: {
            outcomeId: "outcome-1",
            objective: "Ship safely",
            contractRevision: 1,
            planGeneration: 1,
            criteria: [{ id: "criterion-1", text: "Done", required: true, workRefs: [] }],
          },
        },
      ],
    };

    expect(
      deriveOutcomeAttention(acceptedThenCancelled, [], 4, null).nextActions,
    ).not.toContain("delete");
  });
});
