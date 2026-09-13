import { describe, expect, it } from "vitest";
import {
  createHarness,
  createLinkedOutcome,
  createOutcome,
  criterionId,
  outcomeIds,
  secondaryCriterionId,
} from "./methods.test-support.js";

describe("P-06 Outcome export Gateway handler", () => {
  it("exports only the caller's own zero-reference record without an owner read", async () => {
    const harness = createHarness();
    const { id, record } = await createOutcome(harness, outcomeIds[0]!);
    const writes = harness.writes();

    expect(await harness.call("outcomes.export", { id })).toEqual([
      true,
      { schemaVersion: 1, exportedAt: expect.any(Number), record },
    ]);
    expect(harness.gatewayRequest).not.toHaveBeenCalled();
    expect(harness.records.get(id)).toEqual(record);
    expect(harness.writes()).toBe(writes);
  });

  it("hides foreign records before any Workboard read", async () => {
    const harness = createHarness();
    const { id } = await createOutcome(harness, outcomeIds[0]!);

    expect(
      await harness.call(
        "outcomes.export",
        { id },
        { authenticatedUserProfile: { profileId: "manager-b" } },
      ),
    ).toMatchObject([false, undefined, { code: "OUTCOME_NOT_FOUND" }]);
    expect(harness.gatewayRequest).not.toHaveBeenCalled();
  });

  it("refuses the whole export when a current Workboard reference is no longer visible", async () => {
    const harness = createHarness();
    const id = await createLinkedOutcome(harness, outcomeIds[0]!);
    const record = harness.records.get(id)!;
    const writes = harness.writes();
    harness.gatewayRequest.mockResolvedValue({ cards: [] });
    harness.gatewayRequest.mockClear();

    expect(await harness.call("outcomes.export", { id })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_OWNER_UNAVAILABLE" },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledTimes(1);
    expect(harness.records.get(id)).toEqual(record);
    expect(harness.writes()).toBe(writes);
  });

  it("keeps an optional no-proof accepted snapshot subject to current owner authorization", async () => {
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
        {
          id: "card-b",
          status: "done",
          createdAt: 2,
          updatedAt: 2,
          metadata: { automation: { boardId: "board-b" }, proof: [], artifacts: [] },
        },
      ],
    });
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", {
      id,
      title: "Historical optional source",
      objective: "Export must retain accepted optional sources",
      criteria: [
        { id: criterionId, text: "Required proof", required: true },
        { id: secondaryCriterionId, text: "Optional source", required: false },
      ],
    });
    await harness.call("outcomes.linkWorkboard", { id, expectedRevision: 1, criterionId, cardId: "card-a" });
    await harness.call("outcomes.linkWorkboard", { id, expectedRevision: 2, criterionId: secondaryCriterionId, cardId: "card-b" });
    await harness.call("outcomes.activate", { id, expectedRevision: 3 });
    const refreshed = await harness.call("outcomes.refresh", { id, expectedRevision: 4 });
    const outcome = (refreshed[1] as { outcome: { revision: number; planHash: string; criteria: Array<{ evidenceSetHash: string }> } }).outcome;
    await harness.call("outcomes.verifyCriterion", { id, expectedRevision: outcome.revision, decisionId: "123e4567-e89b-42d3-a456-426614174094", criterionId, status: "verified", planHash: outcome.planHash, evidenceSetHash: outcome.criteria[0]!.evidenceSetHash });
    const verified = harness.records.get(id)!;
    const detail = (await harness.call("outcomes.get", { id }))[1] as {
      outcome: { closureHash: string };
    };
    await harness.call("outcomes.accept", { id, expectedRevision: verified.revision, acceptanceId: "123e4567-e89b-42d3-a456-426614174095", planHash: verified.planHash!, closureHash: detail.outcome.closureHash });
    const accepted = harness.records.get(id)!;
    await harness.call("outcomes.unlinkWorkboard", { id, expectedRevision: accepted.revision, criterionId: secondaryCriterionId, cardId: "card-b" });
    const unlinked = harness.records.get(id)!;
    harness.gatewayRequest.mockClear();
    expect(await harness.call("outcomes.export", { id })).toMatchObject([true, { record: unlinked }]);
    expect(harness.gatewayRequest).toHaveBeenCalledTimes(1);
    harness.gatewayRequest.mockResolvedValue({ cards: [{ id: "card-a", status: "done", createdAt: 1, updatedAt: 2, metadata: { automation: { boardId: "board-a" }, proof: [], artifacts: [] } }] });
    harness.gatewayRequest.mockClear();
    expect(await harness.call("outcomes.export", { id })).toMatchObject([false, undefined, { code: "OUTCOME_OWNER_UNAVAILABLE" }]);
    expect(harness.gatewayRequest).toHaveBeenCalledTimes(1);
    expect(harness.records.get(id)).toEqual(unlinked);
  });
});
