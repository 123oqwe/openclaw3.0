import { randomUUID } from "node:crypto";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it } from "vitest";
import { OUTCOME_MAX_ENTRIES } from "../domain/constants.js";
import {
  createRequestHash,
  workboardProjectionFingerprint,
} from "../domain/schema.js";
import type { OutcomeRecord } from "../domain/types.js";
import { createOutcomeRepository } from "./plugin-state-repository.js";

function draftRecord(id: string): OutcomeRecord {
  const criteria = [{ id: "c-1", text: "criterion", required: true, workRefs: [] }];
  return {
    schemaVersion: 1,
    id,
    createRequestHash: createRequestHash({ id, title: "same", objective: "objective", criteria }),
    managerProfileId: "alice",
    title: "same",
    objective: "objective",
    phase: "draft",
    revision: 1,
    contractRevision: 1,
    planGeneration: 0,
    planHash: null,
    criteria,
    projections: [],
    evidence: [],
    decisions: [],
    operations: [],
    acceptances: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function oversizedAvailableProjection(digest: string): OutcomeRecord["projections"][number] {
  const ref = {
    owner: "workboard" as const,
    cardId: "c",
    cardCreatedAt: 1,
    boardIdAtLink: "b",
  };
  const proofs = [{ sourceId: "s", digest }];
  const artifacts: Array<{ sourceId: string; digest: string }> = [];
  return {
    ref,
    availability: "available",
    currentBoardId: "board-current",
    status: "done",
    observedAt: 1,
    sourceUpdatedAt: 1,
    proofs,
    artifacts,
    sourceFingerprint: workboardProjectionFingerprint({
      ref,
      proofs,
      artifacts,
      currentBoardId: "board-current",
      status: "done",
      sourceUpdatedAt: 1,
    }),
  };
}

afterEach(() => resetPluginStateStoreForTests());

describe("Outcome repository capacity and create races", () => {
  it("commits one record when identical owner creates race", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-create-race", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: OUTCOME_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        const repository = createOutcomeRepository(store);
        const record = { ...draftRecord("race"), createRequestHash: "c".repeat(64) };
        const results = await Promise.all([
          repository.createOwned("alice", record),
          repository.createOwned("alice", record),
        ]);
        expect(results.filter((result) => result.created)).toHaveLength(1);
        expect(results.filter((result) => result.replayed)).toHaveLength(1);
        await expect(repository.get(record.id)).resolves.toEqual(record);
      },
    );
  });

  it("rejects oversized aggregates before create or update", async () => {
    await withOpenClawTestState(
      { label: "outcome-repository-size", applyEnv: false },
      async (state) => {
        const store = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
          namespace: `outcomes-v1-${randomUUID()}`,
          maxEntries: OUTCOME_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          env: state.env,
        });
        const repository = createOutcomeRepository(store);
        const oversized = {
          ...draftRecord("large"),
          projections: [oversizedAvailableProjection("x".repeat(140_000))],
        };
        await expect(repository.create(oversized)).rejects.toMatchObject({
          code: "outcome-capacity-exceeded",
        });
        await expect(repository.get(oversized.id)).resolves.toBeUndefined();

        const existing = draftRecord("small");
        await repository.create(existing);
        await expect(
          repository.transact(existing.id, (current) => ({
            result: "updated",
            next: {
              ...current!,
              projections: [oversizedAvailableProjection("x".repeat(140_000))],
            },
          })),
        ).rejects.toMatchObject({ code: "outcome-capacity-exceeded" });
        await expect(repository.get(existing.id)).resolves.toEqual(existing);
      },
    );
  });
});
