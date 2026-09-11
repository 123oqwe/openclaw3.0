import {
  reduceOutcomeContract,
  reduceOutcomePatch,
  reduceOutcomeTitle,
  type OutcomeMutationResult,
  type OutcomePatchMutation,
} from "../domain/reducer.js";
import type { OutcomeRecord } from "../domain/types.js";

/**
 * Routes a validated public patch to the narrowest aggregate transition. This
 * preserves the title-only operation's deliberately independent lifecycle
 * while ensuring contract changes continue to advance their plan generation.
 */
export function reduceGatewayOutcomePatch(
  current: OutcomeRecord,
  mutation: OutcomePatchMutation,
): OutcomeMutationResult {
  const title = mutation.title;
  const hasTitle = title !== undefined;
  const hasContract = mutation.objective !== undefined || mutation.criteria !== undefined;
  if (hasTitle && !hasContract) {
    return reduceOutcomeTitle(current, {
      expectedRevision: mutation.expectedRevision,
      title,
      serverTime: mutation.serverTime,
    });
  }
  if (!hasTitle && hasContract) {
    return reduceOutcomeContract(current, {
      expectedRevision: mutation.expectedRevision,
      objective: mutation.objective ?? current.objective,
      criteria: mutation.criteria ?? current.criteria,
      serverTime: mutation.serverTime,
    });
  }
  return reduceOutcomePatch(current, mutation);
}
