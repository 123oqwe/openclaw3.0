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
  if (current.phase === "cancelled") {
    return { kind: "rejected", record: current };
  }
  if (mutation.expectedRevision !== current.revision) {
    return { kind: "conflict", record: current };
  }
  const canonicalCriteria = (criteria: Criterion[]) =>
    criteria
      .map((criterion) => ({
        ...criterion,
        workRefs: criterion.workRefs
          .map((ref) => ({ ...ref }))
          .sort(
            (a, b) =>
              (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0) ||
              a.cardCreatedAt - b.cardCreatedAt ||
              (a.boardIdAtLink < b.boardIdAtLink ? -1 : a.boardIdAtLink > b.boardIdAtLink ? 1 : 0),
          ),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (
    current.objective === mutation.objective &&
    stableStringify(canonicalCriteria(current.criteria)) ===
      stableStringify(canonicalCriteria(mutation.criteria))
  ) {
    return { kind: "noop", record: current };
  }
  const planGeneration = current.phase === "draft" ? 0 : current.planGeneration + 1;
  const phase = current.phase === "accepted" ? "active" : current.phase;
  const criteria = canonicalCriteria(mutation.criteria);
  return {
    kind: "updated",
    record: {
      ...current,
      objective: mutation.objective,
      criteria,
      phase,
      contractRevision: current.contractRevision + 1,
      planGeneration,
      planHash: planGeneration === 0 ? null : planHash({
        outcomeId: current.id,
        objective: mutation.objective,
        contractRevision: current.contractRevision + 1,
        planGeneration,
        criteria,
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
