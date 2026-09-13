import { createHash } from "node:crypto";
import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";

/** Domain-separated request and plan hashing entrypoints. */
export { createRequestHash, evidenceSetHash, workboardProjectionFingerprint } from "./schema.js";

export function outcomeClosureHash(input: {
  outcomeId: string;
  planGeneration: number;
  planHash: string;
  requiredCriteria: Array<{
    criterionId: string;
    decisionId: string;
    decidedRevision: number;
    evidenceSetHash: string;
  }>;
}): string {
  const canonical = {
    outcomeId: input.outcomeId,
    planGeneration: input.planGeneration,
    planHash: input.planHash,
    requiredCriteria: [...input.requiredCriteria].toSorted((left, right) =>
      left.criterionId < right.criterionId ? -1 : left.criterionId > right.criterionId ? 1 : 0,
    ),
  };
  return createHash("sha256")
    .update(`openclaw:outcome-closure:v1\0${stableStringify(canonical)}`, "utf8")
    .digest("hex");
}
