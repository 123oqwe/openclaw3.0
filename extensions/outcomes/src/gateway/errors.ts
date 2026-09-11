import { WorkboardIdentityConflictError } from "../adapters/workboard-adapter.js";
import {
  OutcomeRepositoryCapacityError,
  OutcomeRepositoryConflictError,
  OutcomeRepositoryNotFoundError,
} from "../store/plugin-state-repository.js";

export const OutcomeErrorCodes = {
  INVALID_REQUEST: "OUTCOME_INVALID_REQUEST",
  INVALID_CURSOR: "OUTCOME_INVALID_CURSOR",
  NOT_FOUND: "OUTCOME_NOT_FOUND",
  ID_UNAVAILABLE: "OUTCOME_ID_UNAVAILABLE",
  REVISION_CONFLICT: "OUTCOME_REVISION_CONFLICT",
  CAPACITY_EXCEEDED: "OUTCOME_CAPACITY_EXCEEDED",
  INVALID_STATE: "OUTCOME_INVALID_STATE",
  OWNER_UNAVAILABLE: "OUTCOME_OWNER_UNAVAILABLE",
  OWNER_FORBIDDEN: "OUTCOME_OWNER_FORBIDDEN",
  OWNER_TIMEOUT: "OUTCOME_OWNER_TIMEOUT",
  IDENTITY_CONFLICT: "OUTCOME_IDENTITY_CONFLICT",
  NOT_QUIESCENT: "OUTCOME_NOT_QUIESCENT",
  INTERNAL: "OUTCOME_INTERNAL",
} as const;

export function outcomeError(code: (typeof OutcomeErrorCodes)[keyof typeof OutcomeErrorCodes]) {
  return { code, message: "Outcome request could not be completed" };
}

export function outcomeStorageError(error: unknown, operation: "create" | "read" | "mutation") {
  if (error instanceof OutcomeRepositoryNotFoundError) return OutcomeErrorCodes.NOT_FOUND;
  if (error instanceof OutcomeRepositoryCapacityError) return OutcomeErrorCodes.CAPACITY_EXCEEDED;
  if (operation === "create" && error instanceof OutcomeRepositoryConflictError) {
    return OutcomeErrorCodes.ID_UNAVAILABLE;
  }
  return OutcomeErrorCodes.INTERNAL;
}

/** Maps owner failures without exposing a host exception, path, or method detail. */
export function outcomeOwnerError(error: unknown) {
  if (error instanceof WorkboardIdentityConflictError) {
    return OutcomeErrorCodes.IDENTITY_CONFLICT;
  }
  const code =
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code.toLowerCase()
      : "";
  if (code.includes("forbidden") || code.includes("unauthorized") || code.includes("scope")) {
    return OutcomeErrorCodes.OWNER_FORBIDDEN;
  }
  if (code.includes("timeout") || code.includes("timed_out")) {
    return OutcomeErrorCodes.OWNER_TIMEOUT;
  }
  return OutcomeErrorCodes.OWNER_UNAVAILABLE;
}
