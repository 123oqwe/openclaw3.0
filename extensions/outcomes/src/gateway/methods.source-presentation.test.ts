import { describe, expect, it } from "vitest";
import {
  createHarness,
  createLinkedOutcome,
  createOutcome,
  createParams,
  criterionId,
  defaultLinkParams,
  outcomeIds,
  secondaryCriterionId,
} from "./methods.test-support.js";

describe("Outcome mutation source presentation", () => {
  it("links and unlinks only the authorized owner card identity with one Workboard read", async () => {
    const harness = createHarness();
    const { id } = await createOutcome(harness);
    expect(await harness.call("outcomes.linkWorkboard", defaultLinkParams(id))).toMatchObject([
      true,
      {
        outcome: {
          revision: 2,
          contractRevision: 2,
          criteria: [
            {
              workRefs: [{ cardId: "card-a", cardCreatedAt: 1, boardIdAtLink: "board-a" }],
            },
          ],
          work: [{ ref: { cardId: "card-a", cardCreatedAt: 1, boardIdAtLink: "board-a" } }],
        },
      },
    ]);
    expect(harness.records.get(id)?.criteria[0]?.workRefs).toEqual([
      { owner: "workboard", cardId: "card-a", cardCreatedAt: 1, boardIdAtLink: "board-a" },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "workboard.cards.list",
      {},
      { scopes: ["operator.read"], requireAuthenticatedRequest: true, timeoutMs: 10_000 },
    );
    expect(harness.gatewayRequest).toHaveBeenCalledTimes(1);
    expect(
      await harness.call("outcomes.unlinkWorkboard", {
        id,
        expectedRevision: 2,
        criterionId,
        cardId: "card-a",
      }),
    ).toMatchObject([true, { outcome: { revision: 3, contractRevision: 3 } }]);
  });

  it("preserves every source from one authorized read across link and later mutations", async () => {
    const harness = createHarness({
      workboardCards: [
        {
          id: "card-a",
          status: "done",
          createdAt: 1,
          updatedAt: 2,
          metadata: { automation: { boardId: "board-a" }, proof: [], artifacts: [] },
        },
        {
          id: "card-b",
          status: "todo",
          createdAt: 3,
          updatedAt: 4,
          metadata: { automation: { boardId: "board-b" }, proof: [], artifacts: [] },
        },
      ],
    });
    const id = outcomeIds[0]!;
    await harness.call("outcomes.create", {
      ...createParams(id),
      criteria: [
        { id: criterionId, text: "First required criterion", required: true },
        { id: secondaryCriterionId, text: "Second required criterion", required: true },
      ],
    });
    await harness.call("outcomes.linkWorkboard", defaultLinkParams(id));
    const secondLink = await harness.call("outcomes.linkWorkboard", {
      id,
      expectedRevision: 2,
      criterionId: secondaryCriterionId,
      cardId: "card-b",
    });
    expect(secondLink).toMatchObject([
      true,
      {
        outcome: {
          work: [
            { ref: { cardId: "card-a", cardCreatedAt: 1, boardIdAtLink: "board-a" } },
            { ref: { cardId: "card-b", cardCreatedAt: 3, boardIdAtLink: "board-b" } },
          ],
        },
      },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledTimes(2);

    harness.gatewayRequest.mockResolvedValueOnce({
      cards: [
        {
          id: "card-b",
          status: "todo",
          createdAt: 3,
          updatedAt: 4,
          metadata: { automation: { boardId: "board-b" }, proof: [], artifacts: [] },
        },
      ],
    });
    const titleUpdate = await harness.call("outcomes.update", {
      id,
      expectedRevision: 3,
      patch: { title: "Updated without access to card A" },
    });
    expect(titleUpdate).toMatchObject([
      true,
      {
        outcome: {
          criteria: [
            { id: criterionId, workRefs: [], sourcesVisibility: "restricted" },
            {
              id: secondaryCriterionId,
              workRefs: [{ cardId: "card-b", cardCreatedAt: 3, boardIdAtLink: "board-b" }],
              sourcesVisibility: "complete",
            },
          ],
          work: [{ ref: { cardId: "card-b", cardCreatedAt: 3, boardIdAtLink: "board-b" } }],
        },
      },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledTimes(3);
  });

  it("does not read Workboard after a mutation of an unlinked Outcome", async () => {
    const harness = createHarness();
    const { id } = await createOutcome(harness);
    expect(
      await harness.call("outcomes.update", {
        id,
        expectedRevision: 1,
        patch: { title: "Updated without links" },
      }),
    ).toMatchObject([true, { outcome: { revision: 2, title: "Updated without links" } }]);
    expect(harness.gatewayRequest).not.toHaveBeenCalled();
  });

  it("keeps a committed mutation successful when its linked source cannot be read", async () => {
    const harness = createHarness();
    const id = await createLinkedOutcome(harness);
    harness.gatewayRequest.mockClear();
    harness.gatewayRequest.mockRejectedValueOnce(new Error("source unavailable"));

    expect(
      await harness.call("outcomes.update", {
        id,
        expectedRevision: 2,
        patch: { title: "Updated while source is unavailable" },
      }),
    ).toMatchObject([
      true,
      {
        outcome: {
          revision: 3,
          title: "Updated while source is unavailable",
          criteria: [{ workRefs: [], sourcesVisibility: "restricted" }],
          work: [],
        },
      },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledOnce();
    expect(harness.records.get(id)?.title).toBe("Updated while source is unavailable");
  });
});
