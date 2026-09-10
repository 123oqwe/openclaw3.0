import type { OutcomeRecord } from "../store/outcome-repository.js";

export type OutcomeMutation = {
  requestHash: string;
  expectedRevision?: number;
  title: string;
};

export type OutcomeMutationResult =
  | { kind: "replay"; record: OutcomeRecord }
  | { kind: "conflict"; record: OutcomeRecord }
  | { kind: "noop"; record: OutcomeRecord }
  | { kind: "updated"; record: OutcomeRecord };

export function reduceOutcomeTitle(
  current: OutcomeRecord,
  mutation: OutcomeMutation,
): OutcomeMutationResult {
  const previousHash = current.lastRequestHash;
  if (previousHash === mutation.requestHash) {
    return { kind: "replay", record: current };
  }
  if (mutation.expectedRevision != null && mutation.expectedRevision !== current.revision) {
    return { kind: "conflict", record: current };
  }
  if (current.title === mutation.title) {
    return { kind: "noop", record: current };
  }
  return {
    kind: "updated",
    record: { ...current, title: mutation.title, revision: current.revision + 1, lastRequestHash: mutation.requestHash },
  };
}
