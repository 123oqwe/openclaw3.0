import { describe, expect, it } from "vitest";
import { parseOutcomeExport } from "../export/export.js";
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

  it("fails closed on an ambiguous Workboard card identity", async () => {
    const harness = createHarness();
    const id = await createLinkedOutcome(harness, outcomeIds[0]!);
    const record = structuredClone(harness.records.get(id)!);
    const writes = harness.writes();
    harness.gatewayRequest.mockResolvedValue({
      cards: [
        { id: "card-a", status: "done", createdAt: 1, updatedAt: 2, metadata: {} },
        { id: "card-a", status: "done", createdAt: 2, updatedAt: 2, metadata: {} },
      ],
    });
    harness.gatewayRequest.mockClear();

    expect(await harness.call("outcomes.export", { id })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_IDENTITY_CONFLICT" },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledTimes(1);
    expect(harness.records.get(id)).toEqual(record);
    expect(harness.writes()).toBe(writes);
  });

  it("maps an owner timeout without leaking a partial export", async () => {
    const harness = createHarness();
    const id = await createLinkedOutcome(harness, outcomeIds[0]!);
    const record = structuredClone(harness.records.get(id)!);
    const writes = harness.writes();
    harness.gatewayRequest.mockRejectedValue(
      Object.assign(new Error("owner timeout"), { code: "TIMEOUT" }),
    );
    harness.gatewayRequest.mockClear();

    expect(await harness.call("outcomes.export", { id })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_OWNER_TIMEOUT", message: "Outcome request could not be completed" },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledTimes(1);
    expect(harness.records.get(id)).toEqual(record);
    expect(harness.writes()).toBe(writes);
  });

  it("exports the stored snapshot when an authorized source changes content", async () => {
    const harness = createHarness();
    const id = await createLinkedOutcome(harness, outcomeIds[0]!);
    const record = structuredClone(harness.records.get(id)!);
    const writes = harness.writes();
    harness.gatewayRequest.mockResolvedValue({
      cards: [
        {
          id: "card-a",
          status: "blocked",
          createdAt: 1,
          updatedAt: 99,
          metadata: { automation: { boardId: "moved" }, proof: [], artifacts: [] },
        },
      ],
    });
    harness.gatewayRequest.mockClear();

    expect(await harness.call("outcomes.export", { id })).toMatchObject([true, { record }]);
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
    await harness.call("outcomes.linkWorkboard", {
      id,
      expectedRevision: 1,
      criterionId,
      cardId: "card-a",
    });
    await harness.call("outcomes.linkWorkboard", {
      id,
      expectedRevision: 2,
      criterionId: secondaryCriterionId,
      cardId: "card-b",
    });
    await harness.call("outcomes.activate", { id, expectedRevision: 3 });
    const refreshed = await harness.call("outcomes.refresh", { id, expectedRevision: 4 });
    const outcome = (
      refreshed[1] as {
        outcome: {
          revision: number;
          planHash: string;
          criteria: Array<{ evidenceSetHash: string }>;
        };
      }
    ).outcome;
    expect(
      await harness.call("outcomes.verifyCriterion", {
        id,
        expectedRevision: outcome.revision,
        decisionId: "123e4567-e89b-42d3-a456-426614174094",
        criterionId,
        status: "verified",
        planHash: outcome.planHash,
        evidenceSetHash: outcome.criteria[0]!.evidenceSetHash,
      }),
    ).toMatchObject([true, { outcome: { phase: "active" } }]);
    const verified = harness.records.get(id)!;
    const detail = (await harness.call("outcomes.get", { id }))[1] as {
      outcome: { closureHash: string };
    };
    expect(
      await harness.call("outcomes.accept", {
        id,
        expectedRevision: verified.revision,
        acceptanceId: "123e4567-e89b-42d3-a456-426614174095",
        planHash: verified.planHash!,
        closureHash: detail.outcome.closureHash,
      }),
    ).toMatchObject([true, { outcome: { phase: "accepted", acceptances: [expect.any(Object)] } }]);
    const accepted = harness.records.get(id)!;
    const acceptedPlan = structuredClone(accepted.acceptances[0]!.acceptedPlan);
    const acceptedPlanHash = accepted.acceptances[0]!.planHash;
    expect(
      acceptedPlan.criteria.find((criterion) => criterion.id === secondaryCriterionId)?.workRefs,
    ).toHaveLength(1);
    expect(
      await harness.call("outcomes.unlinkWorkboard", {
        id,
        expectedRevision: accepted.revision,
        criterionId: secondaryCriterionId,
        cardId: "card-b",
      }),
    ).toMatchObject([true, { outcome: { phase: "active" } }]);
    const unlinked = harness.records.get(id)!;
    expect(
      await harness.call("outcomes.refresh", { id, expectedRevision: unlinked.revision }),
    ).toMatchObject([true, { outcome: { phase: "active" } }]);
    const refreshedAfterUnlink = harness.records.get(id)!;
    const baseline = structuredClone(refreshedAfterUnlink);
    expect(
      refreshedAfterUnlink.criteria.find((criterion) => criterion.id === secondaryCriterionId)?.workRefs,
    ).toEqual([]);
    expect(refreshedAfterUnlink.projections.map((projection) => projection.ref.cardId)).toEqual(["card-a"]);
    expect(refreshedAfterUnlink.acceptances).toHaveLength(1);
    const writes = harness.writes();
    harness.gatewayRequest.mockClear();
    const exported = await harness.call("outcomes.export", { id });
    expect(exported[0]).toBe(true);
    expect(parseOutcomeExport(JSON.parse(JSON.stringify(exported[1])))).toEqual({
      schemaVersion: 1,
      exportedAt: expect.any(Number),
      record: baseline,
    });
    expect(
      (exported[1] as { record: typeof baseline }).record.acceptances[0]!.acceptedPlan,
    ).toEqual(acceptedPlan);
    expect((exported[1] as { record: typeof baseline }).record.acceptances[0]!.planHash).toBe(
      acceptedPlanHash,
    );
    expect(harness.gatewayRequest).toHaveBeenCalledTimes(1);
    expect(harness.writes()).toBe(writes);
    harness.gatewayRequest.mockResolvedValue({
      cards: [
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
    harness.gatewayRequest.mockClear();
    expect(await harness.call("outcomes.export", { id })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_OWNER_UNAVAILABLE" },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledTimes(1);
    expect(harness.records.get(id)).toEqual(baseline);
    expect(harness.writes()).toBe(writes);
  });
});
