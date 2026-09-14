import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { backupRestoreCommand } from "../../../../src/commands/backup-restore.js";
import { buildBackupArchivePath } from "../../../../src/commands/backup-shared.js";
import { createBackupArchive } from "../../../../src/infra/backup-create.js";
import type { RuntimeEnv } from "../../../../src/runtime.js";
import { planHash, workboardProjectionFingerprint } from "../domain/schema.js";
import type { OutcomeRecord } from "../domain/types.js";
import { createOutcomeRepository } from "./plugin-state-repository.js";

const OUTCOME_STORE = {
  namespace: "outcomes-v1",
  maxEntries: 500,
  overflowPolicy: "reject-new",
} as const;

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function restoredStateDir(archiveRoot: string, stateDir: string, targetPath: string): string {
  return path.join(targetPath, buildBackupArchivePath(archiveRoot, stateDir));
}

function activeRecord(): OutcomeRecord {
  const ref = {
    owner: "workboard" as const,
    cardId: "card-1",
    cardCreatedAt: 1,
    boardIdAtLink: "board-1",
  };
  const criteria = [
    { id: "criterion-1", text: "Complete the approved work", required: true, workRefs: [ref] },
  ];
  const planGeneration = 1;
  const currentPlanHash = planHash({
    outcomeId: "backup-outcome",
    objective: "Preserve the recovered contract",
    contractRevision: 1,
    planGeneration,
    criteria,
  });
  const projection = {
    ref,
    availability: "available" as const,
    currentBoardId: "board-1",
    status: "done",
    observedAt: 10,
    lastSuccessfulAt: 10,
    sourceUpdatedAt: 10,
    proofs: [{ sourceId: "proof-1", digest: "proof-digest-1" }],
    artifacts: [],
    sourceFingerprint: workboardProjectionFingerprint({
      ref,
      currentBoardId: "board-1",
      status: "done",
      sourceUpdatedAt: 10,
      proofs: [{ sourceId: "proof-1", digest: "proof-digest-1" }],
      artifacts: [],
    }),
  };
  return {
    schemaVersion: 1,
    id: "backup-outcome",
    createRequestHash: "a".repeat(64),
    managerProfileId: "alice",
    title: "Recover Outcome state",
    objective: "Preserve the recovered contract",
    phase: "active",
    revision: 2,
    contractRevision: 1,
    planGeneration,
    planHash: currentPlanHash,
    criteria,
    projections: [projection],
    evidence: [
      {
        id: "evidence-1",
        criterionId: "criterion-1",
        planGeneration,
        workRef: ref,
        kind: "workboard-proof",
        sourceId: "proof-1",
        sourceDigest: "proof-digest-1",
        observedAt: 10,
      },
    ],
    decisions: [],
    operations: [],
    acceptances: [],
    createdAt: 1,
    updatedAt: 10,
  };
}

describe("Outcome host backup and isolated restore", () => {
  it("preserves a versioned Outcome record and linked Workboard projection in a fresh restored state", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const initial = activeRecord();
      const sourceStore = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        ...OUTCOME_STORE,
        env: state.env,
      });
      await expect(createOutcomeRepository(sourceStore).create(initial)).resolves.toEqual({
        created: true,
      });
      resetPluginStateStoreForTests();

      const backup = await createBackupArchive({
        output: state.path("outcomes-backup.tar.gz"),
        includeWorkspace: false,
        nowMs: Date.UTC(2026, 8, 13, 0, 0, 0),
      });
      const restored = await backupRestoreCommand(createRuntime(), {
        archive: backup.archivePath,
        target: state.path("restored"),
      });
      const restoredStore = createPluginStateKeyedStoreForTests<OutcomeRecord>("outcomes", {
        ...OUTCOME_STORE,
        env: {
          ...state.env,
          OPENCLAW_STATE_DIR: restoredStateDir(
            backup.archiveRoot,
            state.stateDir,
            restored.targetPath,
          ),
        },
      });

      await expect(createOutcomeRepository(restoredStore).get(initial.id)).resolves.toEqual(
        initial,
      );
    });
  });
});
