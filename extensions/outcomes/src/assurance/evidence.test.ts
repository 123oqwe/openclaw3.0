import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readWorkboardCards } from "../adapters/workboard-adapter.js";
import { extractWorkboardEvidence } from "./evidence.js";

const fixture = JSON.parse(
  readFileSync(new URL("../adapters/fixtures/workboard-list.v1.json", import.meta.url), "utf8"),
);

describe("Workboard evidence extraction", () => {
  const card = readWorkboardCards(fixture)[0]!;
  const input = {
    criterionId: "criterion-1",
    planGeneration: 2,
    observedAt: 1_700_000_003_000,
    workRef: {
      owner: "workboard" as const,
      cardId: card.id,
      cardCreatedAt: card.createdAt,
      boardIdAtLink: "release-board",
    },
    card,
  };

  it("hashes only canonical proof/artifact source fields and has stable IDs", () => {
    const evidence = extractWorkboardEvidence(input);
    expect(evidence).toHaveLength(2);
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workboard-proof", sourceId: "proof-1" }),
        expect.objectContaining({ kind: "workboard-artifact", sourceId: "artifact-1" }),
      ]),
    );
    expect(evidence.every((item) => /^[0-9a-f]{64}$/.test(item.id))).toBe(true);
    expect(evidence.every((item) => /^[0-9a-f]{64}$/.test(item.sourceDigest))).toBe(true);

    const reordered = extractWorkboardEvidence({
      ...input,
      card: { ...card, proofs: card.proofs.toReversed(), artifacts: card.artifacts.toReversed() },
    });
    expect(reordered).toEqual(evidence);
  });

  it("changes a source digest and evidence ID when canonical source material or generation changes", () => {
    const original = extractWorkboardEvidence(input).find((item) => item.kind === "workboard-proof")!;
    const changed = extractWorkboardEvidence({
      ...input,
      card: { ...card, proofs: [{ ...card.proofs[0]!, note: "changed claim" }] },
    }).find((item) => item.kind === "workboard-proof")!;
    const nextGeneration = extractWorkboardEvidence({ ...input, planGeneration: 3 }).find(
      (item) => item.kind === "workboard-proof",
    )!;
    expect(changed.sourceDigest).not.toBe(original.sourceDigest);
    expect(changed.id).not.toBe(original.id);
    expect(nextGeneration.sourceDigest).toBe(original.sourceDigest);
    expect(nextGeneration.id).not.toBe(original.id);
  });

  it("fails closed when the owner card does not match the linked identity", () => {
    expect(() =>
      extractWorkboardEvidence({ ...input, workRef: { ...input.workRef, cardCreatedAt: card.createdAt + 1 } }),
    ).toThrow(/identity/i);
  });
});
