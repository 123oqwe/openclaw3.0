import { createHash } from "node:crypto";
import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";
import type { WorkboardCard } from "../adapters/workboard-adapter.js";
import type { EvidenceRef, WorkboardRef } from "../domain/types.js";

type EvidenceInput = {
  criterionId: string;
  planGeneration: number;
  observedAt: number;
  workRef: WorkboardRef;
  card: WorkboardCard;
};

type CanonicalSourceFields = Record<string, string | number>;

function digest(domain: string, value: object): string {
  return createHash("sha256")
    .update(`${domain}\0${stableStringify(value)}`, "utf8")
    .digest("hex");
}

function proofFields(proof: WorkboardCard["proofs"][number]): CanonicalSourceFields {
  const fields: CanonicalSourceFields = {
    id: proof.id,
    status: proof.status,
    createdAt: proof.createdAt,
  };
  if (proof.label !== undefined) { fields.label = proof.label; }
  if (proof.command !== undefined) { fields.command = proof.command; }
  if (proof.url !== undefined) { fields.url = proof.url; }
  if (proof.note !== undefined) { fields.note = proof.note; }
  return fields;
}

function artifactFields(artifact: WorkboardCard["artifacts"][number]): CanonicalSourceFields {
  const fields: CanonicalSourceFields = { id: artifact.id, createdAt: artifact.createdAt };
  if (artifact.label !== undefined) { fields.label = artifact.label; }
  if (artifact.url !== undefined) { fields.url = artifact.url; }
  if (artifact.path !== undefined) { fields.path = artifact.path; }
  if (artifact.mimeType !== undefined) { fields.mimeType = artifact.mimeType; }
  return fields;
}

function evidenceRef(
  input: EvidenceInput,
  kind: EvidenceRef["kind"],
  sourceId: string,
  sourceKind: "proof" | "artifact",
  canonicalSourceFields: CanonicalSourceFields,
): EvidenceRef {
  const sourceDigest = digest("openclaw:workboard-evidence:v1", {
    cardId: input.card.id,
    cardCreatedAt: input.card.createdAt,
    currentBoardId: input.card.boardId,
    sourceKind,
    sourceId,
    canonicalSourceFields,
  });
  return {
    id: digest("openclaw:outcome-evidence-ref:v1", {
      criterionId: input.criterionId,
      generation: input.planGeneration,
      cardId: input.card.id,
      cardCreatedAt: input.card.createdAt,
      kind,
      sourceId,
      sourceDigest,
    }),
    criterionId: input.criterionId,
    planGeneration: input.planGeneration,
    workRef: input.workRef,
    kind,
    sourceId,
    sourceDigest,
    observedAt: input.observedAt,
  };
}

/**
 * Builds the single P-02 evidence representation from authorized Workboard
 * source material. It never fetches URL/path content or executes commands.
 */
export function extractWorkboardEvidence(input: EvidenceInput): EvidenceRef[] {
  if (
    input.workRef.cardId !== input.card.id ||
    input.workRef.cardCreatedAt !== input.card.createdAt
  ) {
    throw new Error("Workboard evidence card identity does not match its linked ref");
  }
  if (!Number.isInteger(input.planGeneration) || input.planGeneration < 0) {
    throw new Error("Workboard evidence plan generation must be a non-negative integer");
  }
  if (!Number.isFinite(input.observedAt)) {
    throw new Error("Workboard evidence observation time must be finite");
  }

  return [
    ...input.card.proofs.map((proof) =>
      evidenceRef(input, "workboard-proof", proof.id, "proof", proofFields(proof)),
    ),
    ...input.card.artifacts.map((artifact) =>
      evidenceRef(input, "workboard-artifact", artifact.id, "artifact", artifactFields(artifact)),
    ),
  ].toSorted(
    (left, right) =>
      (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0) ||
      (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0) ||
      (left.sourceDigest < right.sourceDigest
        ? -1
        : left.sourceDigest > right.sourceDigest
          ? 1
          : 0),
  );
}
