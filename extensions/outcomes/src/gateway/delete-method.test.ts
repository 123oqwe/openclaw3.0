import { describe, expect, it } from "vitest";
import {
  createHarness,
  createLinkedOutcome,
  createOutcome,
  criterionId,
  outcomeIds,
} from "./methods.test-support.js";

async function createAcceptedOutcome(harness: ReturnType<typeof createHarness>, id: string) {
  const linkedId = await createLinkedOutcome(harness, id);
  await harness.call("outcomes.activate", { id: linkedId, expectedRevision: 2 });
  const refreshed = await harness.call("outcomes.refresh", { id: linkedId, expectedRevision: 3 });
  const refreshedOutcome = (
    refreshed[1] as {
      outcome: {
        criteria: Array<{ evidenceSetHash: string }>;
        planHash: string;
        revision: number;
      };
    }
  ).outcome;
  const verified = await harness.call("outcomes.verifyCriterion", {
    id: linkedId,
    expectedRevision: refreshedOutcome.revision,
    decisionId: "123e4567-e89b-42d3-a456-426614174090",
    criterionId,
    status: "verified",
    planHash: refreshedOutcome.planHash,
    evidenceSetHash: refreshedOutcome.criteria[0]!.evidenceSetHash,
  });
  expect(verified).toMatchObject([true, { outcome: { closureHash: expect.any(String) } }]);
  const verifiedOutcome = (verified[1] as { outcome: { closureHash: string; revision: number } })
    .outcome;
  expect(
    await harness.call("outcomes.accept", {
      id: linkedId,
      expectedRevision: verifiedOutcome.revision,
      acceptanceId: "123e4567-e89b-42d3-a456-426614174091",
      planHash: refreshedOutcome.planHash,
      closureHash: verifiedOutcome.closureHash,
    }),
  ).toMatchObject([
    true,
    {
      outcome: {
        phase: "accepted",
        acceptances: [{ id: "123e4567-e89b-42d3-a456-426614174091" }],
      },
    },
  ]);
  return linkedId;
}

describe("P-06 Outcome delete Gateway handler", () => {
  it("deletes only an own quiescent draft or cancelled Outcome at its current revision", async () => {
    const harness = createHarness();
    const { id } = await createOutcome(harness, outcomeIds[0]!);

    expect(await harness.call("outcomes.delete", { id, expectedRevision: 1 })).toEqual([
      true,
      { deleted: true, id },
    ]);
    expect(harness.records.has(id)).toBe(false);
    expect(await harness.call("outcomes.delete", { id, expectedRevision: 1 })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_NOT_FOUND" },
    ]);

    const { id: cancelledId } = await createOutcome(harness, outcomeIds[1]!);
    await harness.call("outcomes.cancel", { id: cancelledId, expectedRevision: 1 });
    expect(await harness.call("outcomes.delete", { id: cancelledId, expectedRevision: 2 })).toEqual(
      [true, { deleted: true, id: cancelledId }],
    );
    expect(harness.records.has(cancelledId)).toBe(false);
    expect(harness.gatewayRequest).not.toHaveBeenCalled();
  });

  it("rejects active Outcomes but permits a cancelled decision history without acceptance", async () => {
    const harness = createHarness({
      workboardCards: [
        {
          id: "card-a",
          status: "done",
          createdAt: 1,
          updatedAt: 2,
          metadata: {
            automation: { boardId: "board-a" },
            proof: [{ id: "proof-a", status: "passed", createdAt: 2 }],
            artifacts: [],
          },
        },
      ],
    });
    const { id: activeId, record: draft } = await createOutcome(harness, outcomeIds[0]!);
    harness.records.set(activeId, { ...draft, phase: "active" });
    expect(await harness.call("outcomes.delete", { id: activeId, expectedRevision: 1 })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_INVALID_STATE" },
    ]);

    const decisionOnlyId = await createLinkedOutcome(harness, outcomeIds[1]!);
    await harness.call("outcomes.activate", { id: decisionOnlyId, expectedRevision: 2 });
    const refreshed = await harness.call("outcomes.refresh", {
      id: decisionOnlyId,
      expectedRevision: 3,
    });
    const refreshedOutcome = (
      refreshed[1] as {
        outcome: {
          criteria: Array<{ evidenceSetHash: string }>;
          planHash: string;
          revision: number;
        };
      }
    ).outcome;
    await harness.call("outcomes.verifyCriterion", {
      id: decisionOnlyId,
      expectedRevision: refreshedOutcome.revision,
      decisionId: "123e4567-e89b-42d3-a456-426614174093",
      criterionId,
      status: "verified",
      planHash: refreshedOutcome.planHash,
      evidenceSetHash: refreshedOutcome.criteria[0]!.evidenceSetHash,
    });
    const verified = harness.records.get(decisionOnlyId)!;
    await harness.call("outcomes.cancel", { id: decisionOnlyId, expectedRevision: verified.revision });
    const cancelled = harness.records.get(decisionOnlyId)!;
    expect(cancelled).toMatchObject({ phase: "cancelled", acceptances: [] });
    expect(cancelled.decisions).toHaveLength(1);
    expect(
      await harness.call("outcomes.delete", {
        id: decisionOnlyId,
        expectedRevision: cancelled.revision,
      }),
    ).toEqual([true, { deleted: true, id: decisionOnlyId }]);
  });

  it("hides a foreign record and keeps stale revisions without deleting", async () => {
    const harness = createHarness();
    const { id } = await createOutcome(harness, outcomeIds[0]!);
    const writes = harness.writes();

    expect(
      await harness.call(
        "outcomes.delete",
        { id, expectedRevision: 1 },
        { authenticatedUserProfile: { profileId: "manager-b" } },
      ),
    ).toMatchObject([false, undefined, { code: "OUTCOME_NOT_FOUND" }]);
    expect(harness.records.has(id)).toBe(true);
    expect(harness.writes()).toBe(writes);

    expect(await harness.call("outcomes.delete", { id, expectedRevision: 2 })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_REVISION_CONFLICT" },
    ]);
    expect(harness.records.has(id)).toBe(true);
    expect(harness.writes()).toBe(writes);
  });

  it("preserves accepted history and uncertain operations even after cancellation", async () => {
    const harness = createHarness({
      workboardCards: [
        {
          id: "card-a",
          status: "done",
          createdAt: 1,
          updatedAt: 2,
          metadata: {
            automation: { boardId: "board-a" },
            proof: [{ id: "proof-a", status: "passed", createdAt: 2 }],
            artifacts: [],
          },
        },
      ],
    });
    const acceptedId = await createAcceptedOutcome(harness, outcomeIds[0]!);
    const accepted = harness.records.get(acceptedId)!;
    expect(
      await harness.call("outcomes.update", {
        id: acceptedId,
        expectedRevision: accepted.revision,
        patch: { objective: "Contract changed after acceptance" },
      }),
    ).toMatchObject([
      true,
      { outcome: { phase: "active", acceptances: [{ id: expect.any(String) }] } },
    ]);
    const active = harness.records.get(acceptedId)!;
    expect(
      await harness.call("outcomes.cancel", { id: acceptedId, expectedRevision: active.revision }),
    ).toMatchObject([
      true,
      { outcome: { phase: "cancelled", acceptances: [{ id: expect.any(String) }] } },
    ]);
    const cancelled = harness.records.get(acceptedId)!;
    const writesBeforeAcceptedDelete = harness.writes();

    expect(
      await harness.call("outcomes.delete", {
        id: acceptedId,
        expectedRevision: cancelled.revision,
      }),
    ).toMatchObject([false, undefined, { code: "OUTCOME_INVALID_STATE" }]);
    expect(harness.records.get(acceptedId)).toEqual(cancelled);
    expect(harness.writes()).toBe(writesBeforeAcceptedDelete);

    const { id: unknownOperationId, record } = await createOutcome(harness, outcomeIds[1]!);
    const writesBeforeUnknownDelete = harness.writes();
    for (const state of ["prepared", "unknown", "may-have-crossed"] as const) {
      harness.records.set(unknownOperationId, {
        ...record,
        operations: [
          {
            id: "123e4567-e89b-42d3-a456-426614174092",
            kind: "workboard-card-start",
            criterionId,
            planGeneration: 0,
            createdRevision: 1,
            requestHash: "a".repeat(64),
            state,
            target: {
              owner: "workboard",
              cardId: "card-a",
              cardCreatedAt: 1,
              boardIdAtLink: "board-a",
            },
            attemptedAt: 1,
          },
        ],
      });
      expect(
        await harness.call("outcomes.delete", { id: unknownOperationId, expectedRevision: 1 }),
      ).toMatchObject([false, undefined, { code: "OUTCOME_NOT_QUIESCENT" }]);
      expect(harness.records.get(unknownOperationId)).toBeDefined();
      expect(harness.writes()).toBe(writesBeforeUnknownDelete);
    }
  });
});
