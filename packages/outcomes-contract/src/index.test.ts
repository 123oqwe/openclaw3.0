import { describe, expect, it } from "vitest";
import * as contract from "./index.js";
import {
  OUTCOME_DEFAULT_LIST_LIMIT,
  OUTCOME_MAX_LIST_LIMIT,
  OUTCOME_PHASES,
  type OutcomeDetail,
} from "./index.js";

type Forbidden = "managerProfileId" | "requestHash" | "operations" | "decisions" | "acceptances";
type AssertNever<T extends never> = T;
type PublicForbiddenKeys = AssertNever<Extract<keyof OutcomeDetail, Forbidden>>;
void (undefined as unknown as PublicForbiddenKeys);

describe("outcomes public contract", () => {
  it("exports only the P-01 view surface and bounded list constants", () => {
    expect(OUTCOME_PHASES).toEqual(["draft", "active", "accepted", "cancelled"]);
    expect(OUTCOME_DEFAULT_LIST_LIMIT).toBe(25);
    expect(OUTCOME_MAX_LIST_LIMIT).toBe(100);
  });

  it("keeps core detail views free of persistence identity and internal history", () => {
    expect(Object.keys(contract)).toEqual(
      expect.arrayContaining([
        "OUTCOME_PHASES",
        "OUTCOME_READINESS",
        "OUTCOME_ACCEPTANCE_VALIDITY",
        "OUTCOME_MAX_LIST_LIMIT",
        "OUTCOME_DEFAULT_LIST_LIMIT",
      ]),
    );
  });
});
