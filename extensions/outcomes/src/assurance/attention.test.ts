import { describe, expect, it } from "vitest";
import { planHash } from "../domain/canonical-plan.js";
import { parseOutcomeRecord } from "../domain/schema.js";
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
    criteria: [
      { id: "criterion-1", text: "Done", required: true, workRefs: [] },
    ],
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
    const acceptedPlan = {
      outcomeId: "outcome-1",
      objective: "Ship safely",
      contractRevision: 1,
      planGeneration: 1,
      criteria: [
        { id: "criterion-1", text: "Done", required: true, workRefs: [] },
      ],
    };
    const currentPlan = {
      ...acceptedPlan,
      objective: "Ship safely after a contract update",
      contractRevision: 2,
      planGeneration: 2,
    };
    const acceptedThenCancelled = parseOutcomeRecord({
      ...record(),
      phase: "cancelled",
      revision: 4,
      contractRevision: 2,
      planGeneration: currentPlan.planGeneration,
      planHash: planHash(currentPlan),
      objective: currentPlan.objective,
      criteria: currentPlan.criteria,
      acceptances: [
        {
          id: "acceptance-1",
          requestHash: "b".repeat(64),
          acceptedRevision: 2,
          profileId: "manager-1",
          acceptedAt: 2,
          planGeneration: acceptedPlan.planGeneration,
          planHash: planHash(acceptedPlan),
          closureHash: "d".repeat(64),
          acceptedPlan,
        },
      ],
    });

    expect(
      deriveOutcomeAttention(acceptedThenCancelled, [], 4, null).nextActions,
    ).not.toContain("delete");
  });
});
