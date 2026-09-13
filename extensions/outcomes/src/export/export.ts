import type { OutcomeRecord, WorkboardRef } from "../domain/types.js";
import { parseOutcomeExport, type OutcomeExport } from "./codec.js";

export type { OutcomeExport } from "./codec.js";

export function encodeOutcomeExport(record: OutcomeRecord, exportedAt: number): OutcomeExport {
  return parseOutcomeExport({ schemaVersion: 1, exportedAt, record });
}

/** Parses versioned lossless exports without exposing the persisted type to public callers. */
/** Every current and historical Workboard identity that makes a record lossless. */
export function outcomeExportWorkRefs(record: OutcomeRecord): WorkboardRef[] {
  const refs = [
    ...record.criteria.flatMap((criterion) => criterion.workRefs),
    ...record.projections.map((projection) => projection.ref),
    ...record.evidence.map((evidence) => evidence.workRef),
    ...record.operations.map((operation) => operation.target),
    ...record.decisions.flatMap((decision) =>
      decision.decidedPlan.criteria.flatMap((criterion) => criterion.workRefs),
    ),
    ...record.acceptances.flatMap((acceptance) =>
      acceptance.acceptedPlan.criteria.flatMap((criterion) => criterion.workRefs),
    ),
  ];
  return refs.filter(
    (ref, index) =>
      refs.findIndex(
        (candidate) =>
          candidate.cardId === ref.cardId && candidate.cardCreatedAt === ref.cardCreatedAt,
      ) === index,
  );
}
