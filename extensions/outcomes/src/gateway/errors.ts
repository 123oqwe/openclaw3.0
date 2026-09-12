import { WorkboardIdentityConflictError } from "../adapters/workboard-adapter.js";
import {
  OUTCOME_ERROR_CODES,
  type OutcomeError,
  type OutcomeErrorCode,
} from "@openclaw/outcomes-contract";
import {
  OutcomeRepositoryCapacityError,
  OutcomeRepositoryConflictError,
  OutcomeRepositoryNotFoundError,
} from "../store/plugin-state-repository.js";

export const OutcomeErrorCodes = OUTCOME_ERROR_CODES;

export function outcomeError(code: OutcomeErrorCode): OutcomeError {
  return { code, message: "Outcome request could not be completed" };
}

export function outcomeStorageError(error: unknown, operation: "create" | "read" | "mutation") {
  if (error instanceof OutcomeRepositoryNotFoundError) {
    return OutcomeErrorCodes.NOT_FOUND;
  }
  if (error instanceof OutcomeRepositoryCapacityError) {
    return OutcomeErrorCodes.CAPACITY_EXCEEDED;
  }
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
