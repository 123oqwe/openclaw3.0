import type { OutcomeRecord } from "./types.js";

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
