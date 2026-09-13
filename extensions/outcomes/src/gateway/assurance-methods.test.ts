import { describe, expect, it } from "vitest";
import { createHarness, createLinkedOutcome, criterionId } from "./methods.test-support.js";

describe("P-05 Outcome assurance Gateway handlers", () => {
  it("records a verified criterion and then accepts the exact current closure", async () => {
    const cards = [
      {
        id: "card-a",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
        metadata: {
          automation: { boardId: "board-a" },
          proof: [{ id: "proof-a", status: "passed", createdAt: 2, label: "Release verified" }],
          artifacts: [],
        },
      },
    ];
    const harness = createHarness({ workboardCards: cards });
    const id = await createLinkedOutcome(harness);
    await harness.call("outcomes.activate", { id, expectedRevision: 2 });
    const refreshed = await harness.call("outcomes.refresh", { id, expectedRevision: 3 });
    const refreshedOutcome = (
      refreshed[1] as {
        outcome: {
          criteria: Array<{ evidenceSetHash: string }>;
          planHash: string;
          revision: number;
        };
      }
    ).outcome;
    const criterion = refreshedOutcome.criteria[0]!;

    const writesBeforeRejectedGuard = harness.writes();
    expect(
      await harness.call("outcomes.verifyCriterion", {
        id,
        expectedRevision: refreshedOutcome.revision,
        decisionId: "123e4567-e89b-42d3-a456-426614174019",
        criterionId,
        status: "verified",
        planHash: "f".repeat(64),
        evidenceSetHash: criterion.evidenceSetHash,
      }),
    ).toMatchObject([false, undefined, { code: "OUTCOME_REVISION_CONFLICT" }]);
    expect(harness.writes()).toBe(writesBeforeRejectedGuard);

    const verified = await harness.call("outcomes.verifyCriterion", {
      id,
      expectedRevision: refreshedOutcome.revision,
      decisionId: "123e4567-e89b-42d3-a456-426614174020",
      criterionId,
      status: "verified",
      planHash: refreshedOutcome.planHash,
      evidenceSetHash: criterion.evidenceSetHash,
    });
    expect(verified).toMatchObject([
      true,
      { replayed: false, receipt: { kind: "verify-criterion", committedRevision: 5 } },
    ]);
    const verifiedOutcome = (
      verified[1] as { outcome: { closureHash: string; planHash: string; revision: number } }
    ).outcome;

    const originalProofs = [...cards[0]!.metadata.proof];
    cards[0]!.metadata.proof = [];
    const afterRemovedProof = await harness.call("outcomes.get", { id });
    expect(afterRemovedProof).toMatchObject([
      true,
      { outcome: { closureHash: null, evidence: [] } },
    ]);
    const removedProofOutcome = (
      afterRemovedProof[1] as { outcome: { criteria: Array<{ evidenceSetHash: string | null }> } }
    ).outcome;
    expect(removedProofOutcome.criteria[0]?.evidenceSetHash).not.toBe(criterion.evidenceSetHash);
    const writesBeforeRemovedProofReplay = harness.writes();
    expect(
      await harness.call("outcomes.verifyCriterion", {
        id,
        expectedRevision: refreshedOutcome.revision,
        decisionId: "123e4567-e89b-42d3-a456-426614174020",
        criterionId,
        status: "verified",
        planHash: refreshedOutcome.planHash,
        evidenceSetHash: criterion.evidenceSetHash,
      }),
    ).toMatchObject([
      true,
      {
        replayed: true,
        receipt: { kind: "verify-criterion", committedRevision: 5 },
        outcome: { closureHash: null, revision: 5 },
      },
    ]);
    expect(harness.writes()).toBe(writesBeforeRemovedProofReplay);
    cards[0]!.metadata.proof = originalProofs;

    cards[0]!.metadata.proof.push({
      id: "proof-added-after-verification",
      status: "passed",
      createdAt: 3,
      label: "Added after the verification response was lost",
    });
    const afterAddedProof = await harness.call("outcomes.get", { id });
    expect(afterAddedProof).toMatchObject([true, { outcome: { closureHash: null } }]);
    const addedProofOutcome = (
      afterAddedProof[1] as { outcome: { criteria: Array<{ evidenceSetHash: string | null }> } }
    ).outcome;
    expect(addedProofOutcome.criteria[0]?.evidenceSetHash).not.toBe(criterion.evidenceSetHash);
    const writesBeforeAddedProofReplay = harness.writes();
    expect(
      await harness.call("outcomes.verifyCriterion", {
        id,
        expectedRevision: refreshedOutcome.revision,
        decisionId: "123e4567-e89b-42d3-a456-426614174020",
        criterionId,
        status: "verified",
        planHash: refreshedOutcome.planHash,
        evidenceSetHash: criterion.evidenceSetHash,
      }),
    ).toMatchObject([
      true,
      {
        replayed: true,
        receipt: { kind: "verify-criterion", committedRevision: 5 },
        outcome: { closureHash: null, revision: 5 },
      },
    ]);
    expect(harness.writes()).toBe(writesBeforeAddedProofReplay);
    cards[0]!.metadata.proof.pop();

    const originalProofLabel = cards[0]!.metadata.proof[0]!.label;
    cards[0]!.metadata.proof[0]!.label = "Changed after the client lost its response";
    const writesBeforeChangedProofReplay = harness.writes();
    const replayAfterProofChange = await harness.call("outcomes.verifyCriterion", {
      id,
      expectedRevision: refreshedOutcome.revision,
      decisionId: "123e4567-e89b-42d3-a456-426614174020",
      criterionId,
      status: "verified",
      planHash: refreshedOutcome.planHash,
      evidenceSetHash: criterion.evidenceSetHash,
    });
    expect(replayAfterProofChange).toMatchObject([
      true,
      {
        replayed: true,
        receipt: { kind: "verify-criterion", committedRevision: 5 },
        outcome: { closureHash: null, revision: 5 },
      },
    ]);
    expect(harness.writes()).toBe(writesBeforeChangedProofReplay);
    cards[0]!.metadata.proof[0]!.label = originalProofLabel;

    const writesBeforeReplay = harness.writes();
    harness.gatewayRequest.mockRejectedValueOnce(
      Object.assign(new Error("owner unavailable"), { code: "GATEWAY_TIMEOUT" }),
    );
    expect(
      await harness.call("outcomes.verifyCriterion", {
        id,
        expectedRevision: refreshedOutcome.revision,
        decisionId: "123e4567-e89b-42d3-a456-426614174020",
        criterionId,
        status: "verified",
        planHash: refreshedOutcome.planHash,
        evidenceSetHash: criterion.evidenceSetHash,
      }),
    ).toMatchObject([
      true,
      {
        replayed: true,
        receipt: { kind: "verify-criterion", committedRevision: 5 },
        outcome: { revision: 5, work: [], evidence: [] },
      },
    ]);
    expect(harness.writes()).toBe(writesBeforeReplay);

    const acceptanceParams = {
      id,
      expectedRevision: verifiedOutcome.revision,
      acceptanceId: "123e4567-e89b-42d3-a456-426614174021",
      planHash: verifiedOutcome.planHash,
      closureHash: verifiedOutcome.closureHash,
    };
    expect(await harness.call("outcomes.accept", acceptanceParams)).toMatchObject([
      true,
      {
        replayed: false,
        outcome: {
          phase: "accepted",
          revision: 6,
          planHash: acceptanceParams.planHash,
          closureHash: acceptanceParams.closureHash,
        },
        receipt: { kind: "accept", committedRevision: 6 },
      },
    ]);
    const writesBeforeAcceptanceReplay = harness.writes();
    expect(
      await harness.call("outcomes.accept", {
        ...acceptanceParams,
        acceptanceId: "123e4567-e89b-42d3-a456-426614174022",
        expectedRevision: 6,
      }),
    ).toMatchObject([false, undefined, { code: "OUTCOME_INVALID_STATE" }]);
    expect(harness.writes()).toBe(writesBeforeAcceptanceReplay);
    expect(
      await harness.call("outcomes.accept", {
        ...acceptanceParams,
        acceptanceId: "123e4567-e89b-42d3-a456-426614174023",
        closureHash: "f".repeat(64),
        expectedRevision: 6,
      }),
    ).toMatchObject([false, undefined, { code: "OUTCOME_REVISION_CONFLICT" }]);
    expect(harness.writes()).toBe(writesBeforeAcceptanceReplay);
    harness.gatewayRequest.mockRejectedValueOnce(
      Object.assign(new Error("owner unavailable"), { code: "GATEWAY_TIMEOUT" }),
    );
    expect(await harness.call("outcomes.accept", acceptanceParams)).toMatchObject([
      true,
      {
        replayed: true,
        receipt: { kind: "accept", committedRevision: 6 },
        outcome: { revision: 6, work: [], evidence: [] },
      },
    ]);
    expect(harness.writes()).toBe(writesBeforeAcceptanceReplay);
    harness.gatewayRequest.mockClear();
    expect(
      await harness.call("outcomes.accept", {
        ...acceptanceParams,
        closureHash: "f".repeat(64),
      }),
    ).toMatchObject([false, undefined, { code: "OUTCOME_OPERATION_CONFLICT" }]);
    expect(harness.gatewayRequest).not.toHaveBeenCalled();
    expect(harness.writes()).toBe(writesBeforeAcceptanceReplay);

    cards[0]!.metadata.proof.push({
      id: "proof-added-during-title-update",
      status: "passed",
      createdAt: 4,
      label: "A title update must not hide changed current evidence",
    });
    harness.gatewayRequest.mockClear();
    const writesBeforeTitleUpdate = harness.writes();
    expect(
      await harness.call("outcomes.update", {
        id,
        expectedRevision: 6,
        patch: { title: "Accepted Outcome with a changed source" },
      }),
    ).toMatchObject([
      true,
      {
        outcome: {
          phase: "accepted",
          title: "Accepted Outcome with a changed source",
          closureHash: null,
          acceptanceValidity: "needs-review",
        },
      },
    ]);
    expect(harness.writes()).toBe(writesBeforeTitleUpdate + 1);
    expect(harness.gatewayRequest).toHaveBeenCalledOnce();
    expect(harness.records.get(id)).toMatchObject({
      title: "Accepted Outcome with a changed source",
      revision: 7,
      evidence: [{ sourceId: "proof-a" }],
    });
    expect(harness.records.get(id)?.evidence).toHaveLength(1);

    harness.gatewayRequest.mockClear();
    expect(
      await harness.call("outcomes.unlinkWorkboard", {
        id,
        expectedRevision: 7,
        criterionId,
        cardId: "card-a",
      }),
    ).toMatchObject([
      true,
      {
        outcome: {
          phase: "active",
          work: [],
          evidence: [],
          decisions: [
            {
              decidedPlan: {
                criteria: [{ sourcesVisibility: "complete", workRefs: [{ cardId: "card-a" }] }],
              },
            },
          ],
          acceptances: [
            {
              acceptedPlan: {
                criteria: [{ sourcesVisibility: "complete", workRefs: [{ cardId: "card-a" }] }],
              },
            },
          ],
        },
      },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledOnce();

    harness.gatewayRequest.mockClear();
    expect(await harness.call("outcomes.get", { id })).toMatchObject([
      true,
      {
        outcome: {
          work: [],
          evidence: [],
          decisions: [
            {
              decidedPlan: {
                criteria: [{ sourcesVisibility: "complete", workRefs: [{ cardId: "card-a" }] }],
              },
            },
          ],
          acceptances: [
            {
              acceptedPlan: {
                criteria: [{ sourcesVisibility: "complete", workRefs: [{ cardId: "card-a" }] }],
              },
            },
          ],
        },
      },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledOnce();

    harness.gatewayRequest.mockClear();
    harness.gatewayRequest.mockResolvedValueOnce({ cards: [] });
    expect(await harness.call("outcomes.get", { id })).toMatchObject([
      true,
      {
        outcome: {
          work: [],
          evidence: [],
          decisions: [
            {
              decidedPlan: {
                criteria: [{ sourcesVisibility: "restricted", workRefs: [] }],
              },
            },
          ],
          acceptances: [
            {
              acceptedPlan: {
                criteria: [{ sourcesVisibility: "restricted", workRefs: [] }],
              },
            },
          ],
        },
      },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledOnce();
  });

  it.each([
    ["outcomes.verifyCriterion", "123e4567-e89b-42d3-a456-426614174040"],
    ["outcomes.accept", "123e4567-e89b-42d3-a456-426614174041"],
  ] as const)(
    "rejects an over-capacity evidence refresh from %s without writing",
    async (method, mutationId) => {
      const harness = createHarness({
        workboardCards: [
          {
            id: "card-a",
            status: "done",
            createdAt: 1,
            updatedAt: 2,
            metadata: {
              automation: { boardId: "board-a" },
              proof: Array.from({ length: 101 }, (_unused, index) => ({
                id: `proof-${index}`,
                status: "passed",
                createdAt: index + 1,
                label: `Proof ${index}`,
              })),
              artifacts: [],
            },
          },
        ],
      });
      const id = await createLinkedOutcome(harness);
      await harness.call("outcomes.activate", { id, expectedRevision: 2 });
      const record = harness.records.get(id);
      if (record?.planHash === null || record === undefined) {
        throw new Error("fixture must be active with a plan hash");
      }
      const writes = harness.writes();
      const params =
        method === "outcomes.verifyCriterion"
          ? {
              id,
              expectedRevision: record.revision,
              decisionId: mutationId,
              criterionId,
              status: "verified",
              planHash: record.planHash,
              evidenceSetHash: "e".repeat(64),
            }
          : {
              id,
              expectedRevision: record.revision,
              acceptanceId: mutationId,
              planHash: record.planHash,
              closureHash: "c".repeat(64),
            };

      expect(await harness.call(method, params)).toMatchObject([
        false,
        undefined,
        { code: "OUTCOME_CAPACITY_EXCEEDED" },
      ]);
      expect(harness.writes()).toBe(writes);
    },
  );
});
