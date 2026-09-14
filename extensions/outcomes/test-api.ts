// Test-only Outcome helpers keep archive compatibility checks outside the product API.
import { parseOutcomeRecord } from "./src/domain/schema.js";

/** Validates a restored archive value without exposing the persisted record. */
export function assertCandidateOutcomeArchiveRecord(input: unknown): void {
  parseOutcomeRecord(input);
}
