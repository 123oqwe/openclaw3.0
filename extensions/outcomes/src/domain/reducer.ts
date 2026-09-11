import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";
import { planHash } from "./canonical-plan.js";
import {
  OUTCOME_MAX_DISTINCT_WORK_REFS,
  OUTCOME_MAX_WORK_REFS_PER_CRITERION,
} from "./constants.js";
import type {
  Criterion,
  EvidenceRef,
  OutcomeRecord,
  WorkProjection,
  WorkboardRef,
} from "./types.js";

export type OutcomeMutation = {
  expectedRevision: number;
  title: string;
  serverTime: number;
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
  /** Supplied by the authenticated server context, never client payload. */
  serverTime: number;
};

export type OutcomePatchMutation = {
  expectedRevision: number;
  title?: string;
  objective?: string;
  criteria?: Criterion[];
  /** Supplied by the authenticated server context, never client payload. */
  serverTime: number;
};

export type OutcomeActivateResult =
  | { kind: "conflict"; record: OutcomeRecord }
  | { kind: "rejected"; record: OutcomeRecord }
  | { kind: "updated"; record: OutcomeRecord };

export type OutcomeLinkMutation = {
  expectedRevision: number;
  criterionId: string;
  ref: WorkboardRef;
  serverTime: number;
};

/**
 * The Gateway builds these values exclusively from one authorized Workboard
 * observation.  A refresh is intentionally all-or-nothing for the record's
 * current linked identities: a partial observation must not look current.
 */
export type OutcomeRefreshMutation = {
  expectedRevision: number;
  projections: WorkProjection[];
  evidence: EvidenceRef[];
  /** Supplied by the authenticated server context, never client payload. */
  serverTime: number;
};

function workRefIdentity(ref: WorkboardRef): string {
  return `${ref.cardId}\0${ref.cardCreatedAt}`;
}

function evidenceIdentity(evidence: EvidenceRef): string {
  return evidence.id;
}

function canonicalRefOrder(left: WorkboardRef, right: WorkboardRef): number {
  return (
    (left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0) ||
    left.cardCreatedAt - right.cardCreatedAt ||
    (left.boardIdAtLink < right.boardIdAtLink
      ? -1
      : left.boardIdAtLink > right.boardIdAtLink
        ? 1
        : 0)
  );
}

function reduceWorkboardRefContract(
  current: OutcomeRecord,
  mutation: OutcomeLinkMutation,
  criteria: Criterion[],
): OutcomeMutationResult {
  return reduceOutcomeContract(current, {
    expectedRevision: mutation.expectedRevision,
    objective: current.objective,
    criteria,
    serverTime: mutation.serverTime,
  });
}

function hasInFlightOperation(current: OutcomeRecord): boolean {
  return (
    current.operations?.some((operation) =>
      ["prepared", "unknown", "may-have-crossed"].includes(operation.state),
    ) ?? false
  );
}

function assertServerTime(serverTime: number): void {
  if (!Number.isFinite(serverTime)) {
    throw new Error("serverTime must be finite");
  }
}

/** Update the contract with an ABA-safe CAS and a new plan generation. */
export function reduceOutcomeContract(
  current: OutcomeRecord,
  mutation: OutcomeContractMutation,
): OutcomeMutationResult {
  assertServerTime(mutation.serverTime);
  if (current.phase === "cancelled") {
    return { kind: "rejected", record: current };
  }
  if (mutation.expectedRevision !== current.revision) {
    return { kind: "conflict", record: current };
  }
  if (hasInFlightOperation(current)) {
    return { kind: "rejected", record: current };
  }
  const canonicalCriteria = (criteria: Criterion[]) =>
    criteria
      .map((criterion) => ({
        ...criterion,
        workRefs: criterion.workRefs
          .map((ref) => ({ ...ref }))
          .toSorted(
            (a, b) =>
              (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0) ||
              a.cardCreatedAt - b.cardCreatedAt ||
              (a.boardIdAtLink < b.boardIdAtLink ? -1 : a.boardIdAtLink > b.boardIdAtLink ? 1 : 0),
          ),
      }))
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
      planHash:
        planGeneration === 0
          ? null
          : planHash({
              outcomeId: current.id,
              objective: mutation.objective,
              contractRevision: current.contractRevision + 1,
              planGeneration,
              criteria,
            }),
      revision: current.revision + 1,
      updatedAt: mutation.serverTime,
    },
  };
}

/** Freeze a draft contract into its first active plan generation. */
export function reduceOutcomeActivate(
  current: OutcomeRecord,
  expectedRevision: number,
  serverTime: number,
): OutcomeActivateResult {
  assertServerTime(serverTime);
  if (expectedRevision !== current.revision) {
    return { kind: "conflict", record: current };
  }
  if (current.phase !== "draft" || hasInFlightOperation(current)) {
    return { kind: "rejected", record: current };
  }
  if (current.criteria.some((criterion) => criterion.required && criterion.workRefs.length === 0)) {
    return { kind: "rejected", record: current };
  }
  const planGeneration = 1;
  return {
    kind: "updated",
    record: {
      ...current,
      phase: "active",
      planGeneration,
      planHash: planHash({
        outcomeId: current.id,
        objective: current.objective,
        contractRevision: current.contractRevision,
        planGeneration,
        criteria: current.criteria,
      }),
      revision: current.revision + 1,
      updatedAt: serverTime,
    },
  };
}

export function reduceOutcomeTitle(
  current: OutcomeRecord,
  mutation: OutcomeMutation,
): OutcomeMutationResult {
  assertServerTime(mutation.serverTime);
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
    record: {
      ...current,
      title: mutation.title,
      revision: current.revision + 1,
      updatedAt: mutation.serverTime,
    },
  };
}

/**
 * Applies the public update patch in one CAS decision. Contract changes retain
 * refs supplied by the gateway and advance the plan exactly once; a title-only
 * change leaves the contract generation alone.
 */
export function reduceOutcomePatch(
  current: OutcomeRecord,
  mutation: OutcomePatchMutation,
): OutcomeMutationResult {
  assertServerTime(mutation.serverTime);
  if (current.phase === "cancelled") return { kind: "rejected", record: current };
  if (mutation.expectedRevision !== current.revision) return { kind: "conflict", record: current };
  if (hasInFlightOperation(current)) return { kind: "rejected", record: current };

  const title = mutation.title ?? current.title;
  const objective = mutation.objective ?? current.objective;
  const criteria = mutation.criteria ?? current.criteria;
  const contractChanged =
    objective !== current.objective ||
    stableStringify(criteria) !== stableStringify(current.criteria);
  if (title === current.title && !contractChanged) return { kind: "noop", record: current };

  if (!contractChanged) {
    return {
      kind: "updated",
      record: { ...current, title, revision: current.revision + 1, updatedAt: mutation.serverTime },
    };
  }

  const planGeneration = current.phase === "draft" ? 0 : current.planGeneration + 1;
  const phase = current.phase === "accepted" ? "active" : current.phase;
  const contractRevision = current.contractRevision + 1;
  return {
    kind: "updated",
    record: {
      ...current,
      title,
      objective,
      criteria,
      phase,
      contractRevision,
      planGeneration,
      planHash:
        planGeneration === 0
          ? null
          : planHash({
              outcomeId: current.id,
              objective,
              contractRevision,
              planGeneration,
              criteria,
            }),
      revision: current.revision + 1,
      updatedAt: mutation.serverTime,
    },
  };
}

/** Atomically adds one owner-derived Workboard identity to a criterion. */
export function reduceOutcomeLink(
  current: OutcomeRecord,
  mutation: OutcomeLinkMutation,
): OutcomeMutationResult {
  assertServerTime(mutation.serverTime);
  if (mutation.expectedRevision !== current.revision) return { kind: "conflict", record: current };
  if (current.phase === "cancelled" || hasInFlightOperation(current))
    return { kind: "rejected", record: current };
  const criterion = current.criteria.find((item) => item.id === mutation.criterionId);
  if (!criterion) return { kind: "rejected", record: current };
  const refIdentity = workRefIdentity(mutation.ref);
  if (criterion.workRefs.some((ref) => workRefIdentity(ref) === refIdentity)) {
    return { kind: "noop", record: current };
  }
  if (criterion.workRefs.length >= OUTCOME_MAX_WORK_REFS_PER_CRITERION) {
    return { kind: "rejected", record: current };
  }
  const existingRefs = new Set(
    current.criteria.flatMap((item) => item.workRefs.map(workRefIdentity)),
  );
  if (!existingRefs.has(refIdentity) && existingRefs.size >= OUTCOME_MAX_DISTINCT_WORK_REFS) {
    return { kind: "rejected", record: current };
  }
  return reduceWorkboardRefContract(
    current,
    mutation,
    current.criteria.map((item) =>
      item.id === mutation.criterionId
        ? { ...item, workRefs: [...item.workRefs, mutation.ref] }
        : item,
    ),
  );
}

/** Atomically removes one current Workboard identity without erasing history. */
export function reduceOutcomeUnlink(
  current: OutcomeRecord,
  mutation: OutcomeLinkMutation,
): OutcomeMutationResult {
  assertServerTime(mutation.serverTime);
  if (mutation.expectedRevision !== current.revision) return { kind: "conflict", record: current };
  if (current.phase === "cancelled" || hasInFlightOperation(current))
    return { kind: "rejected", record: current };
  const criterion = current.criteria.find((item) => item.id === mutation.criterionId);
  if (!criterion) return { kind: "rejected", record: current };
  const workRefs = criterion.workRefs.filter(
    (ref) => workRefIdentity(ref) !== workRefIdentity(mutation.ref),
  );
  if (workRefs.length === criterion.workRefs.length) return { kind: "noop", record: current };
  return reduceWorkboardRefContract(
    current,
    mutation,
    current.criteria.map((item) =>
      item.id === mutation.criterionId ? { ...item, workRefs } : item,
    ),
  );
}

/**
 * Replaces every current linked Workboard projection from one observation and
 * appends its evidence to the immutable evidence history.  It deliberately
 * does not silently accept a partial list, because that would let omitted
 * sources retain an apparently-current cached projection.
 */
export function reduceOutcomeRefresh(
  current: OutcomeRecord,
  mutation: OutcomeRefreshMutation,
): OutcomeMutationResult {
  assertServerTime(mutation.serverTime);
  if (mutation.expectedRevision !== current.revision) return { kind: "conflict", record: current };
  if (current.phase === "cancelled") return { kind: "rejected", record: current };

  const linkedRefs = current.criteria.flatMap((criterion) => criterion.workRefs);
  const linkedIdentities = new Set(linkedRefs.map(workRefIdentity));
  const projectionIdentities = mutation.projections.map((projection) =>
    workRefIdentity(projection.ref),
  );
  const projectionIdentitySet = new Set(projectionIdentities);
  if (
    projectionIdentitySet.size !== projectionIdentities.length ||
    projectionIdentitySet.size !== linkedIdentities.size ||
    Array.from(linkedIdentities).some((identity) => !projectionIdentitySet.has(identity))
  ) {
    return { kind: "rejected", record: current };
  }

  const evidenceIds = new Set(mutation.evidence.map(evidenceIdentity));
  if (
    evidenceIds.size !== mutation.evidence.length ||
    mutation.evidence.some(
      (evidence) =>
        evidence.planGeneration !== current.planGeneration ||
        !linkedIdentities.has(workRefIdentity(evidence.workRef)),
    )
  ) {
    return { kind: "rejected", record: current };
  }

  const existingEvidence = new Map(
    current.evidence.map((evidence) => [evidenceIdentity(evidence), evidence]),
  );
  for (const evidence of mutation.evidence)
    existingEvidence.set(evidenceIdentity(evidence), evidence);
  const evidence = Array.from(existingEvidence.values()).toSorted((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  if (evidence.length > 100) return { kind: "rejected", record: current };
  const previousProjections = new Map(
    current.projections.map((projection) => [workRefIdentity(projection.ref), projection]),
  );

  return {
    kind: "updated",
    record: {
      ...current,
      projections: mutation.projections
        .map((projection) => {
          const previous = previousProjections.get(workRefIdentity(projection.ref));
          const cached =
            projection.availability === "available" || previous === undefined
              ? projection
              : {
                  ...previous,
                  ...projection,
                  proofs: previous.proofs,
                  artifacts: previous.artifacts,
                  sourceFingerprint: undefined,
                };
          return {
            ...cached,
            ref: { ...cached.ref },
            proofs: cached.proofs.map((proof) => ({ ...proof })),
            artifacts: cached.artifacts.map((artifact) => ({ ...artifact })),
          };
        })
        .toSorted((left, right) => canonicalRefOrder(left.ref, right.ref)),
      evidence,
      revision: current.revision + 1,
      updatedAt: mutation.serverTime,
    },
  };
}

export function reduceOutcomeCancel(
  current: OutcomeRecord,
  expectedRevision: number,
  serverTime: number,
): OutcomeCancelResult {
  assertServerTime(serverTime);
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
      updatedAt: serverTime,
    },
  };
}
