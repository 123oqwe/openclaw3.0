import { createHash } from "node:crypto";
import { OUTCOME_PROJECTION_MAX_AGE_MS } from "@openclaw/outcomes-contract";
import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";
import { evidenceSetHash } from "../domain/hash.js";
import type { OutcomeRecord } from "../domain/types.js";

type CurrentProjection = OutcomeRecord["projections"][number];

export type CurrentDecisionBinding = {
  criterionId: string;
  decisionId: string;
  decidedRevision: number;
  evidenceSetHash: string;
};

export type CurrentDecision = {
  decision: OutcomeRecord["decisions"][number];
  sourceDigests: string[];
};

function workRefIdentity(ref: OutcomeRecord["criteria"][number]["workRefs"][number]): string {
  return `${ref.cardId}\0${ref.cardCreatedAt}`;
}

export function isStaleOutcomeProjection(projection: CurrentProjection, observedAt: number): boolean {
  return (
    projection.upstreamStale === true ||
    projection.lastSuccessfulAt === undefined ||
    observedAt - projection.lastSuccessfulAt >= OUTCOME_PROJECTION_MAX_AGE_MS
  );
}

/** Keep only the newest projection for every currently linked Workboard identity. */
export function currentOutcomeProjections(record: OutcomeRecord): CurrentProjection[] {
  const linked = new Set(
    record.criteria.flatMap((criterion) => criterion.workRefs.map(workRefIdentity)),
  );
  const newest = new Map<string, CurrentProjection>();
  for (const projection of record.projections) {
    const identity = workRefIdentity(projection.ref);
    if (!linked.has(identity)) {
      continue;
    }
    const previous = newest.get(identity);
    if (previous === undefined || projection.observedAt > previous.observedAt) {
      newest.set(identity, projection);
    }
  }
  return Array.from(newest.values());
}

export function currentOutcomeEvidenceSourceDigests(
  record: OutcomeRecord,
  criterion: OutcomeRecord["criteria"][number],
  projections: CurrentProjection[],
  observedAt: number,
): string[] | undefined {
  const linked = new Map<string, OutcomeRecord["criteria"][number]["workRefs"][number]>();
  for (const ref of criterion.workRefs) {
    linked.set(workRefIdentity(ref), ref);
  }
  if (linked.size === 0) {
    return undefined;
  }
  const linkedProjections = new Map<string, CurrentProjection>();
  for (const projection of projections) {
    const identity = workRefIdentity(projection.ref);
    if (linked.has(identity)) {
      linkedProjections.set(identity, projection);
    }
  }
  if (
    linkedProjections.size !== linked.size ||
    Array.from(linkedProjections.values()).some(
      (projection) =>
        projection.availability !== "available" || isStaleOutcomeProjection(projection, observedAt),
    )
  ) {
    return undefined;
  }
  const sources = new Set<string>();
  for (const projection of linkedProjections.values()) {
    const identity = workRefIdentity(projection.ref);
    for (const source of projection.proofs) {
      sources.add(`${identity}\0workboard-proof\0${source.sourceId}\0${source.digest}`);
    }
    for (const source of projection.artifacts) {
      sources.add(`${identity}\0workboard-artifact\0${source.sourceId}\0${source.digest}`);
    }
  }
  return record.evidence
    .filter(
      (evidence) =>
        evidence.planGeneration === record.planGeneration &&
        evidence.criterionId === criterion.id &&
        linked.has(workRefIdentity(evidence.workRef)) &&
        sources.has(
          `${workRefIdentity(evidence.workRef)}\0${evidence.kind}\0${evidence.sourceId}\0${evidence.sourceDigest}`,
        ),
    )
    .map((evidence) => evidence.sourceDigest);
}

export function currentOutcomeDecision(
  record: OutcomeRecord,
  criterion: OutcomeRecord["criteria"][number],
  projections: CurrentProjection[],
  observedAt: number,
): CurrentDecision | undefined {
  const sourceDigests = currentOutcomeEvidenceSourceDigests(
    record,
    criterion,
    projections,
    observedAt,
  );
  if (sourceDigests === undefined || record.planHash === null) {
    return undefined;
  }
  const expectedEvidenceSetHash = evidenceSetHash({
    criterionId: criterion.id,
    planGeneration: record.planGeneration,
    sourceDigests,
  });
  const selectedDecision = record.decisions
    .filter(
      (candidate) =>
        candidate.criterionId === criterion.id &&
        candidate.planGeneration === record.planGeneration,
    )
    .toSorted((a, b) => b.decidedRevision - a.decidedRevision)[0];
  if (
    selectedDecision === undefined ||
    selectedDecision.planHash !== record.planHash ||
    selectedDecision.evidenceSetHash !== expectedEvidenceSetHash
  ) {
    return undefined;
  }
  return { decision: selectedDecision, sourceDigests };
}

export function outcomeClosureHash(input: {
  outcomeId: string;
  planGeneration: number;
  planHash: string;
  requiredCriteria: CurrentDecisionBinding[];
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

function requestHash(domain: string, value: object): string {
  return createHash("sha256")
    .update(`${domain}\0${stableStringify(value)}`, "utf8")
    .digest("hex");
}

export function outcomeDecisionRequestHash(input: {
  id: string;
  decisionId: string;
  criterionId: string;
  status: "verified" | "rejected";
  planHash: string;
  evidenceSetHash: string;
  note?: string;
}): string {
  return requestHash("openclaw:outcome-decision:v1", input);
}

export function outcomeAcceptanceRequestHash(input: {
  id: string;
  acceptanceId: string;
  planHash: string;
  closureHash: string;
}): string {
  return requestHash("openclaw:outcome-accept:v1", input);
}

/**
 * A closure exists only while every required criterion has a current verified
 * human decision and every linked source remains available, fresh, and unblocked.
 */
export function deriveOutcomeClosure(
  record: OutcomeRecord,
  projections: CurrentProjection[],
  observedAt: number,
): string | null {
  if (record.phase === "draft" || record.phase === "cancelled" || record.planHash === null) {
    return null;
  }
  if (
    projections.some(
      (projection) =>
        projection.availability !== "available" ||
        projection.status === "blocked" ||
        isStaleOutcomeProjection(projection, observedAt),
    ) ||
    record.operations.some((operation) =>
      ["prepared", "may-have-crossed", "unknown"].includes(operation.state),
    )
  ) {
    return null;
  }
  const currentDecisions = record.criteria.map((criterion) => ({
    criterion,
    current: currentOutcomeDecision(record, criterion, projections, observedAt),
  }));
  if (currentDecisions.some(({ current }) => current?.decision.status === "rejected")) {
    return null;
  }
  const requiredCriteria: CurrentDecisionBinding[] = [];
  for (const criterion of record.criteria) {
    if (!criterion.required) {
      continue;
    }
    const current = currentDecisions.find((item) => item.criterion === criterion)?.current;
    if (current?.decision.status !== "verified" || current.sourceDigests.length === 0) {
      return null;
    }
    requiredCriteria.push({
      criterionId: criterion.id,
      decisionId: current.decision.id,
      decidedRevision: current.decision.decidedRevision,
      evidenceSetHash: current.decision.evidenceSetHash,
    });
  }
  return outcomeClosureHash({
    outcomeId: record.id,
    planGeneration: record.planGeneration,
    planHash: record.planHash,
    requiredCriteria,
  });
}
