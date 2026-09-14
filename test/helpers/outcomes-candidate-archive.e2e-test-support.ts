// Candidate archive compatibility gate for the Outcomes plugin's real restore proof.
import { spawnSync } from "node:child_process";
import { cp, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { buildBackupArchivePath } from "../../src/commands/backup-shared.js";
import { createOpenClawTestInstance, type OpenClawTestInstance } from "./openclaw-test-instance.ts";
import {
  clearPersistedOutcomeEntries,
  parseBackupCreateCliResult,
  parseBackupRestoreCliResult,
  readOutcomeArchiveSha256,
  readPersistedOutcomeEntries,
  seedPersistedOutcomeEntry,
} from "./outcomes-real-gateway.e2e-test-support.ts";

export type CandidateOutcomeArchiveSummary = {
  allowContinue: boolean;
  archiveSha256: string;
  candidateSha: string;
  compatible: boolean;
  errorCategory?:
    | "archive-digest-mismatch"
    | "candidate-mismatch"
    | "decoder-rejected"
    | "empty-collection"
    | "entry-count-mismatch"
    | "process-failed"
    | "restored-state-mismatch";
  recordsChecked: number;
};

type CandidateOutcomeArchiveCheck = {
  archivePath: string;
  candidateCheckoutDir: string;
  candidateDecoderUrl: string;
  candidateSha: string;
  candidateSourcePath: string;
  checkStateDir: string;
  env: NodeJS.ProcessEnv;
  expectedArchiveSha256: string;
  expectedEntries: Awaited<ReturnType<typeof readPersistedOutcomeEntries>>;
  restoredStateDir: string;
};

type CandidateArchiveFixtureParams = {
  candidateCheckoutDir: string;
  candidateDecoderUrl: string;
  candidateSha: string;
  candidateSourcePath: string;
  env: Record<string, string | undefined>;
  empty?: boolean;
  fixtureName: string;
  record?: Record<string, unknown>;
};

export function resolveCandidateCheckoutSha(
  candidateCheckoutDir: string,
  candidateSourcePath: string,
): string {
  const status = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", candidateSourcePath],
    { cwd: candidateCheckoutDir, encoding: "utf8" },
  );
  const checkout = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: candidateCheckoutDir,
    encoding: "utf8",
  });
  const candidateSha = checkout.stdout.trim();
  if (
    status.error ||
    status.signal ||
    status.status !== 0 ||
    status.stdout.trim() !== "" ||
    checkout.error ||
    checkout.signal ||
    checkout.status !== 0 ||
    !/^[a-f0-9]{40}$/u.test(candidateSha)
  ) {
    throw new Error("Candidate checkout SHA is unavailable; leave the plugin disabled");
  }
  return candidateSha;
}

function parseCandidateOutcomeArchiveSummary(
  stdout: string,
): Omit<CandidateOutcomeArchiveSummary, "archiveSha256"> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      !isRecord(parsed) ||
      typeof parsed.candidateSha !== "string" ||
      typeof parsed.compatible !== "boolean" ||
      typeof parsed.allowContinue !== "boolean" ||
      typeof parsed.recordsChecked !== "number" ||
      !Number.isSafeInteger(parsed.recordsChecked) ||
      parsed.recordsChecked < 0
    ) {
      return undefined;
    }
    const errorCategory = parsed.errorCategory;
    if (
      errorCategory !== undefined &&
      errorCategory !== "decoder-rejected" &&
      errorCategory !== "empty-collection"
    ) {
      return undefined;
    }
    const failed = errorCategory !== undefined;
    if (
      (failed && (parsed.compatible || parsed.allowContinue)) ||
      (!failed && (!parsed.compatible || !parsed.allowContinue || parsed.recordsChecked === 0)) ||
      (errorCategory === "empty-collection" && parsed.recordsChecked !== 0)
    ) {
      return undefined;
    }
    return {
      allowContinue: parsed.allowContinue,
      candidateSha: parsed.candidateSha,
      compatible: parsed.compatible,
      ...(errorCategory === undefined ? {} : { errorCategory }),
      recordsChecked: parsed.recordsChecked,
    };
  } catch {
    return undefined;
  }
}

/**
 * Runs the plugin-owned candidate archive assertion in a separate process on
 * a disposable restored-state copy. It never activates the plugin or Gateway.
 */
export async function checkCandidateOutcomeArchive(
  params: CandidateOutcomeArchiveCheck,
): Promise<CandidateOutcomeArchiveSummary> {
  const archiveSha256 = await readOutcomeArchiveSha256(params.archivePath);
  if (archiveSha256 !== params.expectedArchiveSha256) {
    return {
      allowContinue: false,
      archiveSha256,
      candidateSha: params.candidateSha,
      compatible: false,
      errorCategory: "archive-digest-mismatch",
      recordsChecked: 0,
    };
  }
  const candidateCheckoutDir = await realpath(params.candidateCheckoutDir);
  const candidateSourceDir = path.resolve(candidateCheckoutDir, params.candidateSourcePath);
  const candidateDecoderPath = await realpath(fileURLToPath(params.candidateDecoderUrl));
  if (
    path.relative(candidateCheckoutDir, candidateDecoderPath).startsWith("..") ||
    path.relative(candidateSourceDir, candidateDecoderPath).startsWith("..")
  ) {
    return {
      allowContinue: false,
      archiveSha256,
      candidateSha: params.candidateSha,
      compatible: false,
      errorCategory: "candidate-mismatch",
      recordsChecked: 0,
    };
  }
  await cp(params.restoredStateDir, params.checkStateDir, { recursive: true });
  const checkEnv = { ...params.env, OPENCLAW_STATE_DIR: params.checkStateDir };
  const before = await readPersistedOutcomeEntries(checkEnv);
  if (!isDeepStrictEqual(before, params.expectedEntries)) {
    return {
      allowContinue: false,
      archiveSha256,
      candidateSha: params.candidateSha,
      compatible: false,
      errorCategory: "restored-state-mismatch",
      recordsChecked: 0,
    };
  }
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "--eval",
      `
        import { spawnSync } from "node:child_process";
        import {
          createPluginStateKeyedStoreForTests,
        } from "openclaw/plugin-sdk/plugin-state-test-runtime";
        import {
          assertCandidateOutcomeArchiveRecord,
        } from ${JSON.stringify(params.candidateDecoderUrl)};
        const checkout = spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: process.cwd(),
          encoding: "utf8",
        });
        const candidateSha = checkout.stdout.trim();
        if (
          checkout.error ||
          checkout.signal ||
          checkout.status !== 0 ||
          !/^[a-f0-9]{40}$/u.test(candidateSha)
        ) {
          process.stdout.write(
            JSON.stringify({
              candidateSha: "",
              compatible: false,
              allowContinue: false,
              recordsChecked: 0,
              errorCategory: "process-failed",
            }),
          );
          process.exit(0);
        }
        const result = {
          candidateSha,
          compatible: false,
          allowContinue: false,
          recordsChecked: 0,
        };
        let entries;
        try {
          entries = await createPluginStateKeyedStoreForTests("outcomes", {
            namespace: "outcomes-v1",
            maxEntries: 500,
            overflowPolicy: "reject-new",
            env: process.env,
          }).entries();
        } catch {
          process.stdout.write(JSON.stringify({ ...result, errorCategory: "process-failed" }));
          process.exit(0);
        }
        if (entries.length === 0) {
          process.stdout.write(JSON.stringify({ ...result, errorCategory: "empty-collection" }));
          process.exit(0);
        }
        for (const entry of entries) {
          try {
            assertCandidateOutcomeArchiveRecord(entry.value);
            result.recordsChecked += 1;
          } catch {
            process.stdout.write(JSON.stringify({ ...result, errorCategory: "decoder-rejected" }));
            process.exit(0);
          }
        }
        process.stdout.write(JSON.stringify({ ...result, compatible: true, allowContinue: true }));
      `,
    ],
    { cwd: candidateCheckoutDir, encoding: "utf8", env: checkEnv, timeout: 30_000 },
  );
  const after = await readPersistedOutcomeEntries(checkEnv);
  expect(after).toEqual(before);
  const archiveSha256After = await readOutcomeArchiveSha256(params.archivePath);
  if (archiveSha256After !== params.expectedArchiveSha256) {
    return {
      allowContinue: false,
      archiveSha256,
      candidateSha: params.candidateSha,
      compatible: false,
      errorCategory: "archive-digest-mismatch",
      recordsChecked: 0,
    };
  }
  const summary = parseCandidateOutcomeArchiveSummary(child.stdout);
  if (child.error || child.signal || child.status !== 0 || !summary) {
    return {
      allowContinue: false,
      archiveSha256,
      candidateSha: params.candidateSha,
      compatible: false,
      errorCategory: "process-failed",
      recordsChecked: 0,
    };
  }
  if (summary.candidateSha !== params.candidateSha) {
    return {
      allowContinue: false,
      archiveSha256,
      candidateSha: params.candidateSha,
      compatible: false,
      errorCategory: "candidate-mismatch",
      recordsChecked: 0,
    };
  }
  if (!summary.compatible || !summary.allowContinue) {
    return { ...summary, archiveSha256 };
  }
  if (summary.recordsChecked !== params.expectedEntries.length) {
    return {
      allowContinue: false,
      archiveSha256,
      candidateSha: params.candidateSha,
      compatible: false,
      errorCategory: "entry-count-mismatch",
      recordsChecked: 0,
    };
  }
  return { ...summary, archiveSha256 };
}

async function checkCandidateArchiveFixture(
  params: CandidateArchiveFixtureParams,
): Promise<CandidateOutcomeArchiveSummary> {
  const fixture = await createOpenClawTestInstance({
    name: params.fixtureName,
    env: params.env,
  });
  try {
    if (params.empty) {
      await seedPersistedOutcomeEntry(fixture.env, "empty-candidate-outcome", {});
      await clearPersistedOutcomeEntries(fixture.env);
    } else if (params.record) {
      await seedPersistedOutcomeEntry(fixture.env, "candidate-outcome", params.record);
    }
    const before = await readPersistedOutcomeEntries(fixture.env);
    const configBefore = await readFile(fixture.configPath);
    const archivePath = fixture.state.path("candidate-outcome-backup.tar.gz");
    const created = await fixture.cli(
      ["backup", "create", "--output", archivePath, "--no-include-workspace", "--verify", "--json"],
      { timeoutMs: 120_000 },
    );
    expect(created.code, created.stderr).toBe(0);
    const backup = parseBackupCreateCliResult(created.stdout);
    const sourceState = backup.assets.find((asset) => asset.kind === "state");
    if (!sourceState) {
      throw new Error("Candidate Outcome backup CLI output omitted its state asset");
    }
    const restoredCommand = await fixture.cli(
      [
        "backup",
        "restore",
        backup.archivePath,
        "--target",
        fixture.state.path("restore"),
        "--json",
      ],
      { timeoutMs: 120_000 },
    );
    expect(restoredCommand.code, restoredCommand.stderr).toBe(0);
    const restored = parseBackupRestoreCliResult(restoredCommand.stdout);
    const summary = await checkCandidateOutcomeArchive({
      archivePath: backup.archivePath,
      candidateCheckoutDir: params.candidateCheckoutDir,
      candidateDecoderUrl: params.candidateDecoderUrl,
      candidateSha: params.candidateSha,
      candidateSourcePath: params.candidateSourcePath,
      checkStateDir: fixture.state.path("candidate-check-copy"),
      env: fixture.env,
      expectedArchiveSha256: await readOutcomeArchiveSha256(backup.archivePath),
      expectedEntries: before,
      restoredStateDir: path.join(
        restored.targetPath,
        buildBackupArchivePath(backup.archiveRoot, sourceState.sourcePath),
      ),
    });
    expect(await readPersistedOutcomeEntries(fixture.env)).toEqual(before);
    expect(await readFile(fixture.configPath)).toEqual(configBefore);
    return summary;
  } finally {
    await fixture.cleanup();
  }
}

export async function verifyCandidateOutcomeArchiveGate(params: {
  archivePath: string;
  candidateCheckoutDir: string;
  candidateDecoderUrl: string;
  candidateEntrypointUrl: string;
  candidateSourcePath: string;
  expectedArchiveSha256: string;
  faultEnv: Record<string, string | undefined>;
  record: Record<string, unknown>;
  restoredStateDir: string;
  sourceEntries: Awaited<ReturnType<typeof readPersistedOutcomeEntries>>;
  sourceInstance: OpenClawTestInstance;
}): Promise<void> {
  const candidateSha = resolveCandidateCheckoutSha(
    params.candidateCheckoutDir,
    params.candidateSourcePath,
  );
  const candidateArchive = await checkCandidateOutcomeArchive({
    archivePath: params.archivePath,
    candidateCheckoutDir: params.candidateCheckoutDir,
    candidateDecoderUrl: params.candidateDecoderUrl,
    candidateSha,
    candidateSourcePath: params.candidateSourcePath,
    checkStateDir: params.sourceInstance.state.path("accepted-outcome-candidate-check-copy"),
    env: params.sourceInstance.env,
    expectedArchiveSha256: params.expectedArchiveSha256,
    expectedEntries: params.sourceEntries,
    restoredStateDir: params.restoredStateDir,
  });
  expect(candidateArchive).toMatchObject({
    allowContinue: true,
    archiveSha256: params.expectedArchiveSha256,
    candidateSha,
    compatible: true,
    recordsChecked: params.sourceEntries.length,
  });
  const candidateShaMismatch = await checkCandidateOutcomeArchive({
    archivePath: params.archivePath,
    candidateCheckoutDir: params.candidateCheckoutDir,
    candidateDecoderUrl: params.candidateDecoderUrl,
    candidateSha: "0".repeat(40),
    candidateSourcePath: params.candidateSourcePath,
    checkStateDir: params.sourceInstance.state.path("candidate-sha-mismatch-check-copy"),
    env: params.sourceInstance.env,
    expectedArchiveSha256: params.expectedArchiveSha256,
    expectedEntries: params.sourceEntries,
    restoredStateDir: params.restoredStateDir,
  });
  expect(candidateSha).not.toBe("0".repeat(40));
  expect(candidateShaMismatch).toMatchObject({
    allowContinue: false,
    archiveSha256: params.expectedArchiveSha256,
    candidateSha: "0".repeat(40),
    compatible: false,
    errorCategory: "candidate-mismatch",
    recordsChecked: 0,
  });
  expect(await readPersistedOutcomeEntries(params.sourceInstance.env)).toEqual(
    params.sourceEntries,
  );
  const digestMismatch = await checkCandidateOutcomeArchive({
    archivePath: params.archivePath,
    candidateCheckoutDir: params.candidateCheckoutDir,
    candidateDecoderUrl: params.candidateDecoderUrl,
    candidateSha,
    candidateSourcePath: params.candidateSourcePath,
    checkStateDir: params.sourceInstance.state.path("digest-mismatch-check-copy"),
    env: params.sourceInstance.env,
    expectedArchiveSha256: "0".repeat(64),
    expectedEntries: params.sourceEntries,
    restoredStateDir: params.restoredStateDir,
  });
  expect(digestMismatch).toMatchObject({
    allowContinue: false,
    candidateSha,
    compatible: false,
    errorCategory: "archive-digest-mismatch",
    recordsChecked: 0,
  });
  const processFailure = await checkCandidateOutcomeArchive({
    archivePath: params.archivePath,
    candidateCheckoutDir: params.candidateCheckoutDir,
    candidateDecoderUrl: params.candidateEntrypointUrl,
    candidateSha,
    candidateSourcePath: params.candidateSourcePath,
    checkStateDir: params.sourceInstance.state.path("process-failure-check-copy"),
    env: params.sourceInstance.env,
    expectedArchiveSha256: params.expectedArchiveSha256,
    expectedEntries: params.sourceEntries,
    restoredStateDir: params.restoredStateDir,
  });
  expect(processFailure).toMatchObject({
    allowContinue: false,
    candidateSha,
    compatible: false,
    errorCategory: "process-failed",
    recordsChecked: 0,
  });
  const incompatibleCandidateArchive = await checkCandidateArchiveFixture({
    candidateCheckoutDir: params.candidateCheckoutDir,
    candidateDecoderUrl: params.candidateDecoderUrl,
    candidateSha,
    candidateSourcePath: params.candidateSourcePath,
    env: params.faultEnv,
    fixtureName: "outcomes-candidate-incompatible-archive",
    record: { ...params.record, schemaVersion: 2 },
  });
  expect(incompatibleCandidateArchive).toMatchObject({
    allowContinue: false,
    archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    candidateSha,
    compatible: false,
    errorCategory: "decoder-rejected",
    recordsChecked: 0,
  });
  const emptyCandidateArchive = await checkCandidateArchiveFixture({
    candidateCheckoutDir: params.candidateCheckoutDir,
    candidateDecoderUrl: params.candidateDecoderUrl,
    candidateSha,
    candidateSourcePath: params.candidateSourcePath,
    env: params.faultEnv,
    empty: true,
    fixtureName: "outcomes-candidate-empty-archive",
  });
  expect(emptyCandidateArchive).toMatchObject({
    allowContinue: false,
    archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    candidateSha,
    compatible: false,
    errorCategory: "empty-collection",
    recordsChecked: 0,
  });
}
