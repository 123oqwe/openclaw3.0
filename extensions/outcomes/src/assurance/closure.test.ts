import { describe, expect, it } from "vitest";
import { outcomeClosureHash } from "../domain/hash.js";

describe("Outcome closure hash", () => {
  it("uses the P-05 domain prefix and canonical required-criterion ordering", () => {
    const hash = outcomeClosureHash({
      outcomeId: "outcome",
      planGeneration: 1,
      planHash: "a".repeat(64),
      requiredCriteria: [
        {
          criterionId: "criterion",
          decisionId: "decision",
          decidedRevision: 2,
          evidenceSetHash: "b".repeat(64),
        },
      ],
    });

    expect(hash).toBe("381236683e01bfc47e5cff0bff6fa9020bf223f8369d22dee81521cf4c635773");
    expect(
      outcomeClosureHash({
        outcomeId: "outcome",
        planGeneration: 1,
        planHash: "a".repeat(64),
        requiredCriteria: [
          {
            criterionId: "z",
            decisionId: "decision-z",
            decidedRevision: 3,
            evidenceSetHash: "c".repeat(64),
          },
          {
            criterionId: "a",
            decisionId: "decision-a",
            decidedRevision: 2,
            evidenceSetHash: "b".repeat(64),
          },
        ],
      }),
    ).toBe(
      outcomeClosureHash({
        outcomeId: "outcome",
        planGeneration: 1,
        planHash: "a".repeat(64),
        requiredCriteria: [
          {
            criterionId: "a",
            decisionId: "decision-a",
            decidedRevision: 2,
            evidenceSetHash: "b".repeat(64),
          },
          {
            criterionId: "z",
            decisionId: "decision-z",
            decidedRevision: 3,
            evidenceSetHash: "c".repeat(64),
          },
        ],
      }),
    );
  });
});
