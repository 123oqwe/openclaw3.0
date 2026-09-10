import { describe, expect, it } from "vitest";
import {
  OUTCOME_DEFAULT_LIST_LIMIT,
  OUTCOME_MAX_LIST_LIMIT,
  OUTCOME_PHASES,
  type OutcomeDetail,
} from "./index.js";

describe("outcomes public contract", () => {
  it("exports only the P-01 view surface and bounded list constants", () => {
    expect(OUTCOME_PHASES).toEqual(["draft", "active", "accepted", "cancelled"]);
    expect(OUTCOME_DEFAULT_LIST_LIMIT).toBe(25);
    expect(OUTCOME_MAX_LIST_LIMIT).toBe(100);
  });

  it("keeps core detail views free of persistence identity and internal history", () => {
    const detailKeys: Array<keyof OutcomeDetail> = [
      "id",
      "title",
      "phase",
      "revision",
      "updatedAt",
      "readiness",
      "acceptanceValidity",
      "objective",
      "contractRevision",
      "planGeneration",
      "planHash",
      "createdAt",
      "criteria",
      "work",
      "evidence",
      "sourceIssues",
      "observedAt",
      "recheckAfter",
      "closureHash",
      "attention",
      "nextActions",
    ];
    expect(detailKeys).not.toContain("managerProfileId");
    expect(detailKeys).not.toContain("operations");
    expect(detailKeys).not.toContain("requestHash");
  });
});
