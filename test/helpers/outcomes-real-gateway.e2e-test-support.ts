import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { Page } from "playwright";
import { expect } from "vitest";
import { buildBackupArchivePath } from "../../src/commands/backup-shared.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";
import { GATEWAY_CLIENT_NAMES } from "../../src/utils/message-channel.ts";
import type { ControlUiE2eSuite } from "../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { waitForControlUiGatewayReady } from "../../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./openclaw-test-instance.ts";

const outcomeStoreOptions = {
  namespace: "outcomes-v1",
  maxEntries: 500,
  overflowPolicy: "reject-new" as const,
};

export type GatewayCallResult = Record<string, unknown>;

type BackupCliAsset = {
  kind: string;
  sourcePath: string;
};

export type BackupCreateCliResult = {
  archivePath: string;
  archiveRoot: string;
  assets: BackupCliAsset[];
  verified: boolean;
};

export type BackupRestoreCliResult = {
  archivePath: string;
  archiveRoot: string;
  targetPath: string;
};

export type RefreshResponseSummary = {
  errorCode?: string;
  ok: boolean;
  refreshReason?: string;
  refreshStatus?: string;
  revision?: number;
  sourceIssueReasons: string[];
};

export function isGatewayCallResult(value: unknown): value is GatewayCallResult {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseBackupCliPayload(stdout: string, command: string): GatewayCallResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${command} emitted invalid JSON`);
  }
  if (!isGatewayCallResult(parsed)) {
    throw new Error(`${command} emitted an invalid JSON object`);
  }
  return parsed;
}

export function parseBackupCreateCliResult(stdout: string): BackupCreateCliResult {
  const parsed = parseBackupCliPayload(stdout, "backup create");
  if (
    typeof parsed.archivePath !== "string" ||
    typeof parsed.archiveRoot !== "string" ||
    parsed.verified !== true ||
    !Array.isArray(parsed.assets) ||
    !parsed.assets.every(
      (asset) =>
        isGatewayCallResult(asset) &&
        typeof asset.kind === "string" &&
        typeof asset.sourcePath === "string",
    )
  ) {
    throw new Error("backup create JSON omitted its verified archive identity or assets");
  }
  return parsed as BackupCreateCliResult;
}

export function parseBackupRestoreCliResult(stdout: string): BackupRestoreCliResult {
  const parsed = parseBackupCliPayload(stdout, "backup restore");
  if (
    typeof parsed.archivePath !== "string" ||
    typeof parsed.archiveRoot !== "string" ||
    typeof parsed.targetPath !== "string"
  ) {
    throw new Error("backup restore JSON omitted its archive or staging identity");
  }
  return parsed as BackupRestoreCliResult;
}

export async function readPersistedOutcomeEntries(env: NodeJS.ProcessEnv) {
  const store = createPluginStateKeyedStoreForTests<Record<string, unknown>>("outcomes", {
    ...outcomeStoreOptions,
    env,
  });
  const entries = await store.entries();
  return entries
    .map(({ key, value }) => ({ key, value }))
    .toSorted((left, right) => left.key.localeCompare(right.key));
}

/** Seeds a raw archive record only into an isolated test state; it is not an import surface. */
export async function seedPersistedOutcomeEntry(
  env: NodeJS.ProcessEnv,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  const store = createPluginStateKeyedStoreForTests<Record<string, unknown>>("outcomes", {
    ...outcomeStoreOptions,
    env,
  });
  expect(await store.registerIfAbsent(key, value)).toBe(true);
}

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

export function resolveCandidateCheckoutSha(
  candidateCheckoutDir: string,
  candidateSourcePath: string,
): string {
  const status = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", candidateSourcePath],
    {
      cwd: candidateCheckoutDir,
      encoding: "utf8",
    },
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

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function readOutcomeArchiveSha256(archivePath: string): Promise<string> {
  return sha256(await readFile(archivePath));
}

function parseCandidateOutcomeArchiveSummary(
  stdout: string,
): Omit<CandidateOutcomeArchiveSummary, "archiveSha256"> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      !isGatewayCallResult(parsed) ||
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
 * Runs a candidate's real persistence decoder in a separate process against a
 * disposable restored-state copy. It neither activates a plugin nor starts a
 * Gateway. The bounded return value is suitable for an operator gate only.
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
        import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
        import { parseOutcomeRecord } from ${JSON.stringify(params.candidateDecoderUrl)};
        const checkout = spawnSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" });
        const candidateSha = checkout.stdout.trim();
        if (checkout.error || checkout.signal || checkout.status !== 0 || !/^[a-f0-9]{40}$/u.test(candidateSha)) {
          process.stdout.write(JSON.stringify({ candidateSha: "", compatible: false, allowContinue: false, recordsChecked: 0, errorCategory: "process-failed" }));
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
            parseOutcomeRecord(entry.value);
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

export async function checkCandidateRejectsIncompatibleOutcomeArchive(params: {
  candidateCheckoutDir: string;
  candidateDecoderUrl: string;
  candidateSha: string;
  candidateSourcePath: string;
  env: Record<string, string | undefined>;
  record: Record<string, unknown>;
}): Promise<CandidateOutcomeArchiveSummary> {
  const fixture = await createOpenClawTestInstance({
    name: "outcomes-candidate-incompatible-archive",
    env: params.env,
  });
  try {
    await seedPersistedOutcomeEntry(fixture.env, "incompatible-outcome", {
      ...params.record,
      schemaVersion: 2,
    });
    const before = await readPersistedOutcomeEntries(fixture.env);
    const configBefore = await readFile(fixture.configPath);
    const archivePath = fixture.state.path("incompatible-outcome-backup.tar.gz");
    const created = await fixture.cli(
      ["backup", "create", "--output", archivePath, "--no-include-workspace", "--verify", "--json"],
      { timeoutMs: 120_000 },
    );
    expect(created.code, created.stderr).toBe(0);
    const backup = parseBackupCreateCliResult(created.stdout);
    const expectedArchiveSha256 = await readOutcomeArchiveSha256(backup.archivePath);
    const sourceState = backup.assets.find((asset) => asset.kind === "state");
    if (!sourceState) {
      throw new Error("Incompatible Outcome backup CLI output omitted its state asset");
    }
    const restoreTarget = fixture.state.path("incompatible-outcome-restore");
    const restoredCommand = await fixture.cli(
      ["backup", "restore", backup.archivePath, "--target", restoreTarget, "--json"],
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
      checkStateDir: fixture.state.path("incompatible-outcome-check-copy"),
      env: fixture.env,
      expectedArchiveSha256,
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
    archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    candidateSha,
    compatible: true,
    recordsChecked: params.sourceEntries.length,
  });
  expect(await readPersistedOutcomeEntries(params.sourceInstance.env)).toEqual(params.sourceEntries);
  const incompatibleCandidateArchive = await checkCandidateRejectsIncompatibleOutcomeArchive({
    candidateCheckoutDir: params.candidateCheckoutDir,
    candidateDecoderUrl: params.candidateDecoderUrl,
    candidateSha,
    candidateSourcePath: params.candidateSourcePath,
    env: params.faultEnv,
    record: params.record,
  });
  expect(incompatibleCandidateArchive).toMatchObject({
    allowContinue: false,
    archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    candidateSha,
    compatible: false,
    errorCategory: "decoder-rejected",
    recordsChecked: 0,
  });
}

export function gatewayFrame(payload: { toString(): string }): GatewayCallResult | undefined {
  try {
    const parsed: unknown = JSON.parse(payload.toString());
    return isGatewayCallResult(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function gatewayFailureCode(stdout: string): string {
  const frame = gatewayFrame({ toString: () => stdout });
  const error = frame && isGatewayCallResult(frame.error) ? frame.error : undefined;
  const code = error?.code;
  // A Gateway error code is safe, bounded diagnostic context for a hosted
  // failure. Do not print the response body: it can contain params or records.
  return typeof code === "string" && /^[A-Z_]{1,64}$/u.test(code) ? code : "UNAVAILABLE";
}

export function refreshResponseSummary(frame: GatewayCallResult): RefreshResponseSummary {
  const error = isGatewayCallResult(frame.error) ? frame.error : undefined;
  const payload = isGatewayCallResult(frame.payload) ? frame.payload : undefined;
  const refresh = payload && isGatewayCallResult(payload.refresh) ? payload.refresh : undefined;
  const outcome = payload && isGatewayCallResult(payload.outcome) ? payload.outcome : undefined;
  const sourceIssueReasons = Array.isArray(outcome?.sourceIssues)
    ? outcome.sourceIssues.flatMap((issue) => {
        if (!isGatewayCallResult(issue) || typeof issue.reason !== "string") {
          return [];
        }
        return [issue.reason];
      })
    : [];
  return {
    ok: frame.ok === true,
    sourceIssueReasons,
    ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
    ...(typeof refresh?.reason === "string" ? { refreshReason: refresh.reason } : {}),
    ...(typeof refresh?.status === "string" ? { refreshStatus: refresh.status } : {}),
    ...(typeof outcome?.revision === "number" ? { revision: outcome.revision } : {}),
  };
}

async function listPairedDevices(instance: OpenClawTestInstance): Promise<GatewayCallResult[]> {
  const result = await instance.cli([
    "--no-color",
    "devices",
    "list",
    "--url",
    instance.url,
    "--token",
    instance.gatewayToken,
    "--json",
  ]);
  expect(result.code, result.stderr).toBe(0);
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isGatewayCallResult(parsed) || !Array.isArray(parsed.paired)) {
    throw new Error("Device inventory omitted paired devices");
  }
  return parsed.paired.filter(isGatewayCallResult);
}

async function revokeOperatorToken(
  instance: OpenClawTestInstance,
  deviceId: string,
): Promise<void> {
  const client = await connectGatewayClient({
    url: instance.url,
    token: instance.gatewayToken,
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    deviceIdentity: loadOrCreateDeviceIdentity({
      path: path.join(instance.stateDir, "outcomes-revocation-admin.sqlite"),
    }),
    requestTimeoutMs: 10_000,
    timeoutMs: 10_000,
  });
  try {
    await client.request("device.token.revoke", { deviceId, role: "operator" });
  } finally {
    await disconnectGatewayClient(client);
  }
}

function requireNewBrowserDeviceId(
  paired: GatewayCallResult[],
  existingDeviceIds: ReadonlySet<string>,
): string {
  const candidates = paired.filter(
    (device) =>
      typeof device.deviceId === "string" &&
      !existingDeviceIds.has(device.deviceId) &&
      device.clientId === GATEWAY_CLIENT_NAMES.CONTROL_UI &&
      (device.role === "operator" ||
        (Array.isArray(device.roles) && device.roles.includes("operator"))),
  );
  expect(candidates).toHaveLength(1);
  const deviceId = candidates[0]?.deviceId;
  if (typeof deviceId !== "string") {
    throw new Error("New browser device omitted its ID");
  }
  return deviceId;
}

export async function revokeNewControlUiOperator(
  instance: OpenClawTestInstance,
  existingDeviceIds: ReadonlySet<string>,
): Promise<void> {
  const deviceId = requireNewBrowserDeviceId(await listPairedDevices(instance), existingDeviceIds);
  await revokeOperatorToken(instance, deviceId);
}

export async function listControlUiDeviceIds(
  instance: OpenClawTestInstance,
): Promise<ReadonlySet<string>> {
  return new Set(
    (await listPairedDevices(instance))
      .map((device) => device.deviceId)
      .filter((deviceId): deviceId is string => typeof deviceId === "string"),
  );
}

export async function outcomesUrlFor(owner: OpenClawTestInstance): Promise<string> {
  const result = await owner.cli(["--no-color", "dashboard", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isGatewayCallResult(parsed)) {
    throw new Error("Gateway dashboard handoff was invalid");
  }
  const browserUrl = parsed.browserUrl;
  if (typeof browserUrl !== "string") {
    throw new Error("Gateway dashboard handoff omitted its browser URL");
  }
  const issued = new URL(browserUrl);
  const target = new URL("outcomes", issued);
  target.hash = issued.hash;
  return target.toString();
}

export function requireCardId(payload: GatewayCallResult): string {
  const card = payload.card;
  if (!isGatewayCallResult(card)) {
    throw new Error("Workboard create omitted its card");
  }
  const id = card.id;
  if (typeof id !== "string") {
    throw new Error("Workboard create omitted its card ID");
  }
  return id;
}

export function requireProofId(payload: GatewayCallResult): string {
  const card = payload.card;
  if (!isGatewayCallResult(card) || !isGatewayCallResult(card.metadata)) {
    throw new Error("Workboard proof response omitted card metadata");
  }
  const proofs = card.metadata.proof;
  const proof = Array.isArray(proofs) ? proofs.at(-1) : undefined;
  if (!isGatewayCallResult(proof)) {
    throw new Error("Workboard proof response omitted its persisted proof");
  }
  const proofId = proof.id;
  if (typeof proofId !== "string") {
    throw new Error("Workboard proof response omitted its proof ID");
  }
  return proofId;
}

export function outcomeGatewayConfig(
  owner: OpenClawTestInstance,
  options: { outcomesEnabled: boolean; workboardEnabled: boolean },
) {
  return {
    gateway: {
      auth: { mode: "token", token: owner.gatewayToken },
      controlUi: { enabled: true },
      port: owner.port,
    },
    hooks: { enabled: true, path: "/hooks", token: owner.hookToken },
    plugins: {
      enabled: true,
      allow: ["outcomes", "workboard"],
      entries: {
        outcomes: { enabled: options.outcomesEnabled },
        workboard: { enabled: options.workboardEnabled },
      },
    },
  };
}

export async function verifyOutcomeMobileKeyboardFlow(
  suite: ControlUiE2eSuite,
  outcomesUrl: () => Promise<string>,
) {
  await suite.withPage(
    {
      locale: "en-US",
      reducedMotion: "reduce",
      serviceWorkers: "block",
      viewport: { height: 852, width: 393 },
    },
    async ({ page }) => {
      await page.goto(await outcomesUrl());
      await waitForControlUiGatewayReady(page);
      const titleText = "x".repeat(160);
      const create = page.locator('[data-outcome-action="create"]');
      await expect
        .poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches))
        .toBe(true);
      expect(
        await create.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      expect(
        await page
          .locator("openclaw-outcomes-page")
          .evaluate((element) => element.getAnimations({ subtree: true }).length),
      ).toBe(0);
      await create.focus();
      await page.keyboard.press("Enter");
      const form = page.locator("[data-outcome-create-form]");
      await form.waitFor({ state: "visible" });
      const title = form.locator('input[name="title"]');
      await expect
        .poll(() =>
          title.evaluate(
            (element) => element === document.activeElement && element.matches(":focus-visible"),
          ),
        )
        .toBe(true);
      await page.keyboard.type(titleText);
      const objective = form.locator('textarea[name="objective"]');
      await page.keyboard.press("Tab");
      await expect
        .poll(() =>
          objective.evaluate(
            (element) => element === document.activeElement && element.matches(":focus-visible"),
          ),
        )
        .toBe(true);
      await page.keyboard.press("Shift+Tab");
      await expect
        .poll(() =>
          title.evaluate(
            (element) => element === document.activeElement && element.matches(":focus-visible"),
          ),
        )
        .toBe(true);
      await page.keyboard.press("Tab");
      await expect
        .poll(() =>
          objective.evaluate(
            (element) => element === document.activeElement && element.matches(":focus-visible"),
          ),
        )
        .toBe(true);
      await page.keyboard.type("Prove the narrow-screen keyboard flow");
      const criterion = form.locator('input[name="criterion"]');
      await page.keyboard.press("Tab");
      await expect
        .poll(() =>
          criterion.evaluate(
            (element) => element === document.activeElement && element.matches(":focus-visible"),
          ),
        )
        .toBe(true);
      await page.keyboard.type("A required criterion is recorded");
      const confirm = form.locator("[data-outcome-confirm-create]");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect
        .poll(() =>
          confirm.evaluate(
            (element) => element === document.activeElement && element.matches(":focus-visible"),
          ),
        )
        .toBe(true);
      expect(
        await confirm.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      await page.keyboard.press("Enter");
      await page.locator(".outcome-summary", { hasText: titleText }).waitFor({ state: "visible" });
      await expect
        .poll(() => create.evaluate((element) => element === document.activeElement))
        .toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const summary = page.locator(".outcome-summary", { hasText: titleText });
      expect(
        await summary
          .locator("[data-outcome-select]")
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      await summary.locator("[data-outcome-select]").click();
      const detail = page.locator("[data-outcome-detail-id]");
      await detail.waitFor({ state: "visible" });
      expect(
        await detail
          .locator(".outcome-detail__back")
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      expect(
        await page
          .locator(".outcomes-list-panel")
          .evaluate((element) => getComputedStyle(element).display),
      ).toBe("none");
      await detail.locator(".outcome-detail__back").click();
      await expect
        .poll(() =>
          summary
            .locator("[data-outcome-select]")
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      await create.focus();
      await page.keyboard.press("Enter");
      await form.waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await expect.poll(() => form.count()).toBe(0);
      await expect
        .poll(() => create.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.screenshot({
        fullPage: true,
        path: path.join(suite.artifactDir, "outcomes-mobile-keyboard-create.png"),
      });
    },
  );
}

export async function verifyOutcomeRevocation(
  suite: ControlUiE2eSuite,
  instance: OpenClawTestInstance,
  outcomesUrl: () => Promise<string>,
) {
  const existingDeviceIds = new Set(
    (await listPairedDevices(instance))
      .map((device) => device.deviceId)
      .filter((id): id is string => typeof id === "string"),
  );
  await suite.withPage(
    {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    },
    async ({ page }) => {
      await page.goto(await outcomesUrl());
      await waitForControlUiGatewayReady(page);
      await page.locator('[data-outcome-action="create"]').click();
      const createForm = page.locator("[data-outcome-create-form]");
      await createForm.locator('input[name="title"]').fill("Revoked browser Outcome");
      await createForm
        .locator('textarea[name="objective"]')
        .fill("This must disappear on revocation");
      await createForm
        .locator('input[name="criterion"]')
        .fill("The browser can no longer read this");
      await createForm.locator("[data-outcome-confirm-create]").click();
      const summary = page.locator(".outcome-summary", { hasText: "Revoked browser Outcome" });
      await summary.waitFor({ state: "visible" });
      await summary.locator("[data-outcome-select]").click();
      const detail = page.locator("[data-outcome-detail-id]");
      await detail.waitFor({ state: "visible" });
      await detail
        .getByText("This must disappear on revocation", { exact: true })
        .waitFor({ state: "visible" });
      const browserDeviceId = requireNewBrowserDeviceId(
        await listPairedDevices(instance),
        existingDeviceIds,
      );
      await revokeOperatorToken(instance, browserDeviceId);
      await expect.poll(() => detail.count()).toBe(0);
      await expect
        .poll(() => page.getByText("This must disappear on revocation", { exact: true }).count())
        .toBe(0);
      await expect.poll(() => page.locator('[data-outcome-action="create"]').count()).toBe(0);
      await page.screenshot({
        fullPage: true,
        path: path.join(suite.artifactDir, "outcomes-authorization-revoked.png"),
      });
      await page.reload();
      await expect.poll(() => detail.count()).toBe(0);
      await expect
        .poll(() => page.getByText("Revoked browser Outcome", { exact: true }).count())
        .toBe(0);
    },
  );
}

export async function verifyUnavailableOutcomeState(
  suite: ControlUiE2eSuite,
  instance: OpenClawTestInstance,
) {
  await suite.withPage(
    {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    },
    async ({ page }) => {
      await page.goto(await outcomesUrlFor(instance));
      await waitForControlUiGatewayReady(page);
      await page
        .getByText("Outcome access unavailable", { exact: true })
        .waitFor({ state: "visible" });
      await expect.poll(() => page.locator(".outcomes-list").count()).toBe(0);
      await page.screenshot({
        fullPage: true,
        path: path.join(suite.artifactDir, "outcomes-access-unavailable.png"),
      });
    },
  );
}

type BrowserOutcomeReply = {
  frame: GatewayCallResult;
  method: "outcomes.get" | "outcomes.refresh";
  outcomeId: string;
  phase: string;
};

export function captureBrowserOutcomeReplies(page: Page) {
  const outcomeReplies: BrowserOutcomeReply[] = [];
  let browserPhase = "source";
  page.on("websocket", (socket) => {
    const pendingOutcomeRequests = new Map<string, Omit<BrowserOutcomeReply, "frame">>();
    socket.on("close", () => pendingOutcomeRequests.clear());
    socket.on("framesent", ({ payload }) => {
      const frame = gatewayFrame(payload);
      const params = frame && isGatewayCallResult(frame.params) ? frame.params : undefined;
      const outcomeId = params && typeof params.id === "string" ? params.id : undefined;
      if (
        frame?.type === "req" &&
        (frame.method === "outcomes.get" || frame.method === "outcomes.refresh") &&
        typeof frame.id === "string" &&
        outcomeId
      ) {
        pendingOutcomeRequests.set(frame.id, {
          method: frame.method,
          outcomeId,
          phase: browserPhase,
        });
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = gatewayFrame(payload);
      if (frame?.type !== "res" || typeof frame.id !== "string") {
        return;
      }
      const request = pendingOutcomeRequests.get(frame.id);
      if (!request) {
        return;
      }
      pendingOutcomeRequests.delete(frame.id);
      if (frame.ok === true) {
        outcomeReplies.push({ ...request, frame });
      }
    });
  });
  return {
    setPhase(phase: string) {
      browserPhase = phase;
    },
    async reply(
      phase: string,
      method: BrowserOutcomeReply["method"],
      outcomeId: string,
    ): Promise<GatewayCallResult> {
      await expect
        .poll(() =>
          outcomeReplies.some(
            (reply) =>
              reply.phase === phase &&
              reply.method === method &&
              reply.outcomeId === outcomeId &&
              isGatewayCallResult(reply.frame.payload) &&
              isGatewayCallResult(reply.frame.payload.outcome) &&
              reply.frame.payload.outcome.id === outcomeId,
          ),
        )
        .toBe(true);
      const reply = outcomeReplies.findLast(
        (candidate) =>
          candidate.phase === phase &&
          candidate.method === method &&
          candidate.outcomeId === outcomeId &&
          isGatewayCallResult(candidate.frame.payload) &&
          isGatewayCallResult(candidate.frame.payload.outcome) &&
          candidate.frame.payload.outcome.id === outcomeId,
      );
      if (!reply) {
        throw new Error(`Owner-authenticated browser ${method} reply was not captured`);
      }
      return reply.frame;
    },
  };
}
