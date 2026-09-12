/** P-01 persistence limits; these are part of the storage contract. */
export const OUTCOME_MAX_CRITERIA = 5;
export const OUTCOME_MAX_WORK_REFS_PER_CRITERION = 10;
export const OUTCOME_MAX_DISTINCT_WORK_REFS = 20;
export const OUTCOME_MAX_RECORD_BYTES = 128 * 1024;
export const OUTCOME_MAX_ENTRIES = 500;
export const OUTCOME_OVERFLOW_POLICY = "reject-new" as const;

/** Internal diagnostic thresholds; neither changes the reject-new hard limits. */
export const OUTCOME_CAPACITY_WARNING_ENTRIES = 400;
export const OUTCOME_CAPACITY_WARNING_RECORD_BYTES = 96 * 1024;
export const OUTCOME_CAPACITY_WARNING_WRITE_DURATION_MS = 100;
