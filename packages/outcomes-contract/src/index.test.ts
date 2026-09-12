import { describe, expect, it } from "vitest";
import * as contract from "./index.js";
import {
  OUTCOME_DEFAULT_LIST_LIMIT,
  OUTCOME_ERROR_CODES,
  OUTCOME_MAX_LIST_LIMIT,
  OUTCOME_PHASES,
  OUTCOME_REFRESH_STATUSES,
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
    expect(OUTCOME_REFRESH_STATUSES).toEqual(["available", "unavailable", "identity-conflict"]);
  });

  it("publishes the bounded Outcome error-code vocabulary, including reserved later-stage codes", () => {
    expect(OUTCOME_ERROR_CODES).toEqual({
      CAPACITY_EXCEEDED: "OUTCOME_CAPACITY_EXCEEDED",
      CLOSURE_INCOMPLETE: "OUTCOME_CLOSURE_INCOMPLETE",
      IDENTITY_CONFLICT: "OUTCOME_IDENTITY_CONFLICT",
      ID_UNAVAILABLE: "OUTCOME_ID_UNAVAILABLE",
      INTERNAL: "OUTCOME_INTERNAL",
      INVALID_CURSOR: "OUTCOME_INVALID_CURSOR",
      INVALID_REQUEST: "OUTCOME_INVALID_REQUEST",
      INVALID_STATE: "OUTCOME_INVALID_STATE",
      NOT_FOUND: "OUTCOME_NOT_FOUND",
      NOT_QUIESCENT: "OUTCOME_NOT_QUIESCENT",
      OPERATION_CONFLICT: "OUTCOME_OPERATION_CONFLICT",
      OWNER_FORBIDDEN: "OUTCOME_OWNER_FORBIDDEN",
      OWNER_TIMEOUT: "OUTCOME_OWNER_TIMEOUT",
      OWNER_UNAVAILABLE: "OUTCOME_OWNER_UNAVAILABLE",
      REVISION_CONFLICT: "OUTCOME_REVISION_CONFLICT",
    });
  });

  it("keeps core detail views free of persistence identity and internal history", () => {
    expect(Object.keys(contract).toSorted()).toEqual(
      [
        "OUTCOME_ACCEPTANCE_VALIDITY",
        "OUTCOME_ATTENTION_CODES",
        "OUTCOME_DEFAULT_LIST_LIMIT",
        "OUTCOME_ERROR_CODES",
        "OUTCOME_EVIDENCE_KINDS",
        "OUTCOME_MAX_LIST_LIMIT",
        "OUTCOME_NEXT_ACTIONS",
        "OUTCOME_PHASES",
        "OUTCOME_PROOF_STATUSES",
        "OUTCOME_PROJECTION_MAX_AGE_MS",
        "OUTCOME_READINESS",
        "OUTCOME_REFRESH_STATUSES",
        "OUTCOME_SOURCE_ISSUE_REASONS",
        "OUTCOME_SOURCE_VISIBILITY",
      ].toSorted(),
    );
  });
});
