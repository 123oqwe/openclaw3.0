import { z } from "zod";
import { parseOutcomeRecord } from "../domain/schema.js";
import type { OutcomeRecord, WorkboardRef } from "../domain/types.js";

const outcomeExportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  exportedAt: z.number().finite(),
  record: z.unknown(),
});

export type OutcomeExport = {
  schemaVersion: 1;
  exportedAt: number;
  record: OutcomeRecord;
};

export function encodeOutcomeExport(record: OutcomeRecord, exportedAt: number): OutcomeExport {
  return { schemaVersion: 1, exportedAt, record: parseOutcomeRecord(record) };
}

/** Parses versioned lossless exports without exposing the persisted type to public callers. */
export function parseOutcomeExport(input: unknown): OutcomeExport {
  const envelope = outcomeExportSchema.parse(input);
  return { ...envelope, record: parseOutcomeRecord(envelope.record) };
}

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
