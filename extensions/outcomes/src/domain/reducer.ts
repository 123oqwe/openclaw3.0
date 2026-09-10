import type { OutcomeRecord } from "./types.js";
import { planHash } from "./schema.js";
import type { Criterion } from "./types.js";
import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";

export type OutcomeMutation = {
  expectedRevision: number;
  title: string;
};

export type OutcomeMutationResult =
  | { kind: "conflict"; record: OutcomeRecord }
  | { kind: "noop"; record: OutcomeRecord }
  | { kind: "updated"; record: OutcomeRecord }
  | { kind: "rejected"; record: OutcomeRecord };

export type OutcomeCancelResult =
  | { kind: "conflict"; record: OutcomeRecord }
  | { kind: "rejected"; record: OutcomeRecord }
  | { kind: "updated"; record: OutcomeRecord };

export type OutcomeContractMutation = {
  expectedRevision: number;
  objective: string;
  criteria: Criterion[];
};

/** Update the contract with an ABA-safe CAS and a new plan generation. */
export function reduceOutcomeContract(
  current: OutcomeRecord,
  mutation: OutcomeContractMutation,
): OutcomeMutationResult {
  if (current.phase === "cancelled" || current.phase === "accepted") {
    return { kind: "rejected", record: current };
  }
  if (mutation.expectedRevision !== current.revision) {
    return { kind: "conflict", record: current };
  }
  if (
    current.objective === mutation.objective &&
    stableStringify(current.criteria) === stableStringify(mutation.criteria)
  ) {
    return { kind: "noop", record: current };
  }
  const planGeneration = current.planGeneration + 1;
  return {
    kind: "updated",
    record: {
      ...current,
      objective: mutation.objective,
      criteria: mutation.criteria,
      contractRevision: current.contractRevision + 1,
      planGeneration,
      planHash: planHash({
        outcomeId: current.id,
        objective: mutation.objective,
        contractRevision: current.contractRevision + 1,
        planGeneration,
        criteria: mutation.criteria,
      }),
      revision: current.revision + 1,
    },
  };
}

export function reduceOutcomeTitle(
  current: OutcomeRecord,
  mutation: OutcomeMutation,
): OutcomeMutationResult {
  if (current.phase === "cancelled") {
    return { kind: "rejected", record: current };
  }
  if (mutation.expectedRevision !== current.revision) {
    return { kind: "conflict", record: current };
  }
  if (current.title === mutation.title) {
    return { kind: "noop", record: current };
  }
  return {
    kind: "updated",
    record: { ...current, title: mutation.title, revision: current.revision + 1 },
  };
}

export function reduceOutcomeCancel(
  current: OutcomeRecord,
  expectedRevision: number,
): OutcomeCancelResult {
  if (expectedRevision !== current.revision) {
    return { kind: "conflict", record: current };
  }
  if (current.phase === "accepted" || current.phase === "cancelled") {
    return { kind: "rejected", record: current };
  }
  if (
    current.operations?.some((operation) =>
      ["prepared", "unknown", "may-have-crossed"].includes(operation.state),
    )
  ) {
    return { kind: "rejected", record: current };
  }
  return {
    kind: "updated",
    record: {
      ...current,
      phase: "cancelled",
      revision: current.revision + 1,
    },
  };
}
