import { describe, expect, it } from "vitest";
import {
  createHarness,
  createLinkedOutcome,
  createOutcome,
  outcomeIds,
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
    const harness = createHarness({ workboardCards: [] });
    const id = await createLinkedOutcome(harness, outcomeIds[0]!);
    const record = harness.records.get(id)!;
    const writes = harness.writes();

    expect(await harness.call("outcomes.export", { id })).toMatchObject([
      false,
      undefined,
      { code: "OUTCOME_OWNER_UNAVAILABLE" },
    ]);
    expect(harness.gatewayRequest).toHaveBeenCalledTimes(1);
    expect(harness.records.get(id)).toEqual(record);
    expect(harness.writes()).toBe(writes);
  });
});
