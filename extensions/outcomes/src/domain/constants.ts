/** P-01 persistence limits; these are part of the storage contract. */
export const OUTCOME_MAX_CRITERIA = 5;
export const OUTCOME_MAX_RECORD_BYTES = 128 * 1024;
export const OUTCOME_MAX_ENTRIES = 500;
export const OUTCOME_OVERFLOW_POLICY = "reject-new" as const;
