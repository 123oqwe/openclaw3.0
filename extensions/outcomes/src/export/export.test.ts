import { describe, expect, it } from "vitest";
import { createRequestHash } from "../domain/schema.js";
import type { OutcomeRecord } from "../domain/types.js";
import { encodeOutcomeExport, outcomeExportWorkRefs, parseOutcomeExport } from "./export.js";

function draftRecord(): OutcomeRecord {
  const request = {
    id: "export-1",
    title: "Export",
    objective: "Retain the validated aggregate",
    criteria: [{ id: "criterion-1", text: "saved", required: true, workRefs: [] }],
  };
  return {
    schemaVersion: 1,
    id: request.id,
    createRequestHash: createRequestHash(request),
    managerProfileId: "manager-a",
    title: request.title,
    objective: request.objective,
    phase: "draft",
    revision: 1,
    contractRevision: 1,
    planGeneration: 0,
    planHash: null,
    criteria: request.criteria,
    projections: [],
    evidence: [],
    decisions: [],
    operations: [],
    acceptances: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("Outcome export codec", () => {
  it("round-trips a validated lossless record while preserving its owner and history fields", () => {
    const record = draftRecord();
    const encoded = encodeOutcomeExport(record, 42);

    expect(parseOutcomeExport(encoded)).toEqual({ schemaVersion: 1, exportedAt: 42, record });
    expect(outcomeExportWorkRefs(record)).toEqual([]);
  });

  it("fails closed for future envelopes and corrupt persisted snapshots", () => {
    const record = draftRecord();

    expect(() => parseOutcomeExport({ schemaVersion: 2, exportedAt: 42, record })).toThrow();
    for (const exportedAt of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => encodeOutcomeExport(record, exportedAt)).toThrow();
      expect(() => parseOutcomeExport({ schemaVersion: 1, exportedAt, record })).toThrow();
    }
    expect(() =>
      parseOutcomeExport({
        schemaVersion: 1,
        exportedAt: 42,
        record: { ...record, createRequestHash: "not-a-hash" },
      }),
    ).toThrow();
  });
});
