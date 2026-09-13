import { z } from "zod";
import { parseOutcomeRecord } from "../domain/schema.js";
import type { OutcomeRecord } from "../domain/types.js";

const outcomeExportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  exportedAt: z.number().finite().nonnegative(),
  record: z.unknown(),
});

export type OutcomeExport = {
  schemaVersion: 1;
  exportedAt: number;
  record: OutcomeRecord;
};

/** Parses versioned lossless exports at the persistence/transport boundary. */
export function parseOutcomeExport(input: unknown): OutcomeExport {
  const envelope = outcomeExportSchema.parse(input);
  return { ...envelope, record: parseOutcomeRecord(envelope.record) };
}
