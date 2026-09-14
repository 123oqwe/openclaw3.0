// Real Gateway proof for the Outcome Center's persisted public workflow.
import { cp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { backupRestoreCommand } from "../../../src/commands/backup-restore.js";
import { buildBackupArchivePath } from "../../../src/commands/backup-shared.js";
import { createBackupArchive } from "../../../src/infra/backup-create.js";
import { withEnvAsync } from "../../../src/test-utils/env.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  createBackupRuntime,
  captureBrowserOutcomeReplies,
  gatewayFrame,
  gatewayFailureCode,
  isGatewayCallResult,
  outcomeStoreOptions,
  outcomeGatewayConfig,
  outcomesUrlFor,
  readPersistedOutcomeEntries,
  refreshResponseSummary,
  requireCardId,
  requireProofId,
  verifyOutcomeMobileKeyboardFlow,
  verifyOutcomeRevocation,
  verifyUnavailableOutcomeState,
  type GatewayCallResult,
  type RefreshResponseSummary,
} from "../../../test/helpers/outcomes-real-gateway.e2e-test-support.ts";

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const twentyFourHoursMs = 24 * 60 * 60 * 1000;
// The isolated-instance helper defaults to a minimal Gateway and therefore does
// not load configured plugins. This proof must load the real Outcomes and
// Workboard entries from the fixture config.
const realGatewayPluginEnv = {
  OPENCLAW_GATEWAY_TOKEN: undefined,
  OPENCLAW_GATEWAY_PASSWORD: undefined,
  OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
  OPENCLAW_SKIP_CHANNELS: undefined,
  OPENCLAW_SKIP_PROVIDERS: undefined,
  VITEST: undefined,
  VITEST_POOL_ID: undefined,
  VITEST_WORKER_ID: undefined,
  NODE_ENV: undefined,
  CODEX_HOME: undefined,
  OPENAI_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
  OPENCLAW_BUILD_PRIVATE_QA: "1",
} as const;

const suite = createControlUiE2eSuite({
  name: "Control UI Outcomes with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-outcomes",
      startTimeoutMs: 120_000,
      env: realGatewayPluginEnv,
      config: {
        gateway: { controlUi: { enabled: true } },
        plugins: {
          enabled: true,
          allow: ["outcomes", "workboard"],
          entries: {
            outcomes: { enabled: true },
            workboard: { enabled: true },
          },
        },
      },
    });
    instance = owner;
    try {
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
      throw error;
    }
  },
});

let instance: OpenClawTestInstance | undefined;

const unavailableSuite = createControlUiE2eSuite({
  name: "Control UI Outcomes without advertised access",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-outcomes-unavailable",
      startTimeoutMs: 120_000,
      env: realGatewayPluginEnv,
      config: {
        gateway: { controlUi: { enabled: true } },
        plugins: {
          enabled: true,
          allow: ["outcomes", "workboard"],
          entries: {
            outcomes: { enabled: false },
            workboard: { enabled: true },
          },
        },
      },
    });
    unavailableInstance = owner;
    try {
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
      throw error;
    }
  },
});

let unavailableInstance: OpenClawTestInstance | undefined;

async function callGateway(
  method: string,
  params: Record<string, unknown>,
): Promise<GatewayCallResult> {
  if (!instance) {
    throw new Error("Outcome Gateway fixture was not started");
  }
  return await callGatewayFor(instance, method, params);
}

async function callGatewayFor(
  owner: OpenClawTestInstance,
  method: string,
  params: Record<string, unknown>,
): Promise<GatewayCallResult> {
  const result = await owner.cli([
    "--no-color",
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify(params),
    "--json",
  ]);
  expect(
    result.code,
    `${method} failed: exit=${result.code} signal=${result.signal ?? "none"} gatewayError=${gatewayFailureCode(result.stdout)}`,
  ).toBe(0);
  expect(result.signal).toBeNull();
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isGatewayCallResult(parsed)) {
    throw new Error(`${method} returned an invalid Gateway payload`);
  }
  return parsed;
}

async function outcomesUrl(): Promise<string> {
  if (!instance) {
    throw new Error("Outcome Gateway fixture was not started");
  }
  return outcomesUrlFor(instance);
}

suite.define(() => {
  it("creates, links, activates, refreshes, and reloads an Outcome through the real Gateway", async () => {
    const cardId = requireCardId(
      await callGateway("workboard.cards.create", {
        priority: "normal",
        title: "Publish real Outcome evidence",
      }),
    );
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await page.clock.install();
        const refreshRequestIds = new Set<string>();
        const refreshReplies = new Map<string, RefreshResponseSummary>();
        const gatewayHelloMethods: string[][] = [];
        let gatewayWebSocketCloseCount = 0;
        page.on("websocket", (socket) => {
          socket.on("close", () => {
            gatewayWebSocketCloseCount += 1;
          });
          socket.on("framesent", ({ payload }) => {
            const frame = gatewayFrame(payload);
            if (
              frame?.type === "req" &&
              frame.method === "outcomes.refresh" &&
              typeof frame.id === "string"
            ) {
              refreshRequestIds.add(frame.id);
            }
          });
          socket.on("framereceived", ({ payload }) => {
            const frame = gatewayFrame(payload);
            const hello = isGatewayCallResult(frame?.payload) ? frame.payload : undefined;
            const features =
              hello && isGatewayCallResult(hello.features) ? hello.features : undefined;
            if (
              frame?.type === "res" &&
              frame.ok === true &&
              hello?.type === "hello-ok" &&
              Array.isArray(features?.methods)
            ) {
              gatewayHelloMethods.push(
                features.methods.filter((method): method is string => typeof method === "string"),
              );
            }
            if (
              frame?.type === "res" &&
              typeof frame.id === "string" &&
              refreshRequestIds.has(frame.id)
            ) {
              refreshReplies.set(frame.id, refreshResponseSummary(frame));
            }
          });
        });
        const handoffUrl = await outcomesUrl();
        const bootstrapToken = new URLSearchParams(new URL(handoffUrl).hash.slice(1)).get(
          "bootstrapToken",
        );
        if (!bootstrapToken) {
          throw new Error("Outcome dashboard handoff omitted its bootstrap token");
        }
        await page.goto(handoffUrl);
        await waitForControlUiGatewayReady(page);
        await expect
          .poll(() =>
            gatewayHelloMethods.some((methods) => methods.includes("workboard.cards.list")),
          )
          .toBe(true);
        expect(
          await page.evaluate(
            (secret) => ({
              body: document.body.textContent?.includes(secret) ?? false,
              url: location.href.includes(secret),
            }),
            bootstrapToken,
          ),
        ).toEqual({ body: false, url: false });

        await page.locator('[data-outcome-action="create"]').click();
        const createForm = page.locator("[data-outcome-create-form]");
        await createForm.locator('input[name="title"]').fill("Release Outcome E2E");
        await createForm
          .locator('textarea[name="objective"]')
          .fill("Prove the public Outcome flow");
        await createForm.locator('input[name="criterion"]').fill("A real Workboard card is linked");
        await createForm.locator("[data-outcome-confirm-create]").click();

        const summary = page.locator(".outcome-summary", { hasText: "Release Outcome E2E" });
        await summary.waitFor({ state: "visible" });
        const selectOutcome = summary.locator("[data-outcome-select]");
        await selectOutcome.focus();
        await page.keyboard.press("Enter");

        const detail = page.locator("[data-outcome-detail-id]");
        await detail.waitFor({ state: "visible" });
        const outcomeId = await detail.getAttribute("data-outcome-detail-id");
        if (!outcomeId) {
          throw new Error("Outcome detail omitted its ID");
        }
        const linkWork = detail.locator('[data-outcome-action="link-work"]');
        await linkWork.focus();
        await page.keyboard.press("Enter");
        const linkForm = page.locator("[data-outcome-link-form]");
        const linkedCard = linkForm.locator('select[name="card"]');
        await linkedCard.focus();
        await page.keyboard.press("ArrowDown");
        await expect.poll(() => linkedCard.inputValue()).toBe(cardId);
        const confirmLink = linkForm.locator("[data-outcome-confirm-link]");
        await confirmLink.focus();
        await page.keyboard.press("Enter");
        await detail.locator(`[data-outcome-work-card="${cardId}"]`).waitFor({ state: "visible" });
        await detail
          .locator(`[data-outcome-unlink-card="${cardId}"]`)
          .waitFor({ state: "visible" });

        const proofId = requireProofId(
          await callGateway("workboard.cards.proof", {
            id: cardId,
            label: "Outcome E2E verification",
            status: "passed",
          }),
        );
        const activate = detail.locator('[data-outcome-action="activate"]');
        await activate.focus();
        await page.keyboard.press("Enter");
        await detail.locator('[data-outcome-phase="active"]').waitFor({ state: "visible" });
        await expect.poll(() => detail.locator('[data-outcome-action="activate"]').count()).toBe(0);

        const refresh = detail.locator('[data-outcome-action="refresh"]');
        const refreshRequestCount = refreshRequestIds.size;
        await refresh.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => refreshRequestIds.size).toBe(refreshRequestCount + 1);
        const refreshRequestId = Array.from(refreshRequestIds).at(-1);
        if (!refreshRequestId) {
          throw new Error("Outcome refresh did not emit a Gateway request ID");
        }
        await expect.poll(() => refreshReplies.has(refreshRequestId)).toBe(true);
        expect(refreshReplies.get(refreshRequestId)).toMatchObject({ ok: true });
        const evidence = detail.locator(`[data-outcome-evidence="${proofId}"]`);
        await evidence.waitFor({ state: "visible" });
        await expect
          .poll(async () => await evidence.textContent())
          .toContain("Proof: Outcome E2E verification");
        await expect
          .poll(async () => await evidence.textContent())
          .toContain("Proof status: passed");
        if (captureUiProofEnabled) {
          await writeFile(
            path.join(suite.artifactDir, "outcomes-desktop-accessibility.yml"),
            await page.locator("body").ariaSnapshot(),
          );
          await page.screenshot({
            fullPage: true,
            path: path.join(suite.artifactDir, "outcomes-desktop-current.png"),
          });
        }

        const freshnessClockBeforeExpiry = await page.evaluate(() => performance.now());
        const gatewayConnectionRevisionBeforeExpiry = await page.evaluate(() => {
          const app = document.querySelector("openclaw-app") as
            | (HTMLElement & {
                runtime?: { context?: { gateway?: { connectionRevision?: number } } };
              })
            | null;
          return app?.runtime?.context?.gateway?.connectionRevision ?? null;
        });
        expect(Number.isFinite(gatewayConnectionRevisionBeforeExpiry)).toBe(true);
        const gatewayWebSocketCloseCountBeforeExpiry = gatewayWebSocketCloseCount;
        // Keep Gateway's wall-clock silence checks at the current time while
        // still advancing the page's monotonic freshness timer.
        await page.clock.setFixedTime(await page.evaluate(() => Date.now()));
        await page.clock.fastForward(twentyFourHoursMs + 1);
        // Playwright advances due timers during fastForward, then a short run
        // lets the reactive render scheduled by the freshness callback settle.
        await page.clock.runFor(100);
        const freshnessClockAfterExpiry = await page.evaluate(() => performance.now());
        expect(freshnessClockAfterExpiry - freshnessClockBeforeExpiry).toBeGreaterThanOrEqual(
          twentyFourHoursMs,
        );
        await detail.locator('[data-outcome-readiness="stale"]').waitFor({ state: "visible" });
        expect(gatewayWebSocketCloseCount).toBe(gatewayWebSocketCloseCountBeforeExpiry);
        await expect
          .poll(() =>
            page.evaluate(() => {
              const app = document.querySelector("openclaw-app") as
                | (HTMLElement & {
                    runtime?: { context?: { gateway?: { connectionRevision?: number } } };
                  })
                | null;
              return app?.runtime?.context?.gateway?.connectionRevision ?? null;
            }),
          )
          .toBe(gatewayConnectionRevisionBeforeExpiry);
        await page.screenshot({
          fullPage: true,
          path: path.join(suite.artifactDir, "outcomes-stale-observation.png"),
        });

        await callGateway("workboard.cards.claim", { id: cardId, ownerId: "outcome-e2e" });
        await callGateway("workboard.cards.block", {
          id: cardId,
          reason: "Outcome E2E needs operator attention",
        });
        await refresh.focus();
        await page.keyboard.press("Enter");
        await detail
          .getByText("A linked card is blocked", { exact: true })
          .waitFor({ state: "visible" });
        await page.screenshot({
          fullPage: true,
          path: path.join(suite.artifactDir, "outcomes-blocked-linked-work.png"),
        });

        const gatewayHelloCountBeforeWorkboardDisabled = gatewayHelloMethods.length;
        if (!instance) {
          throw new Error("Outcome Gateway fixture was not started");
        }
        await instance.stopGateway();
        await page
          .getByText("Outcome connection unavailable", { exact: true })
          .waitFor({ state: "visible" });
        await expect.poll(() => detail.count()).toBe(0);
        if (captureUiProofEnabled) {
          await page.screenshot({
            fullPage: true,
            path: path.join(suite.artifactDir, "outcomes-disconnected.png"),
          });
        }
        await instance.state.writeConfig(
          outcomeGatewayConfig(instance, { outcomesEnabled: true, workboardEnabled: false }),
        );
        await instance.startGateway();
        await waitForControlUiGatewayReady(page);
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await expect
          .poll(() =>
            gatewayHelloMethods
              .slice(gatewayHelloCountBeforeWorkboardDisabled)
              .some((methods) => !methods.includes("workboard.cards.list")),
          )
          .toBe(true);
        await page
          .locator(".outcome-summary", { hasText: "Release Outcome E2E" })
          .waitFor({ state: "visible" });
        await page.locator("[data-outcome-select]").click();
        const disabledRefreshRequestCount = refreshRequestIds.size;
        await detail.locator('[data-outcome-action="refresh"]').click();
        await expect.poll(() => refreshRequestIds.size).toBe(disabledRefreshRequestCount + 1);
        const disabledRefreshRequestId = Array.from(refreshRequestIds).at(-1);
        if (!disabledRefreshRequestId) {
          throw new Error("Disabled Workboard refresh did not emit a Gateway request ID");
        }
        await expect.poll(() => refreshReplies.has(disabledRefreshRequestId)).toBe(true);
        const disabledRefresh = refreshReplies.get(disabledRefreshRequestId);
        expect(disabledRefresh?.ok).toBe(true);
        expect(disabledRefresh?.refreshReason).toBe("forbidden");
        expect(disabledRefresh?.refreshStatus).toBe("unavailable");
        expect(disabledRefresh?.revision).toEqual(expect.any(Number));
        expect(disabledRefresh?.sourceIssueReasons).toContain("forbidden");
        await page
          .getByText("Linked source unavailable", { exact: true })
          .waitFor({ state: "visible" });
        await expect
          .poll(() => detail.locator(`[data-outcome-work-card="${cardId}"]`).count())
          .toBe(0);
        await expect
          .poll(() => detail.locator(`[data-outcome-evidence="${proofId}"]`).count())
          .toBe(0);
        await page.screenshot({
          fullPage: true,
          path: path.join(suite.artifactDir, "outcomes-workboard-unavailable.png"),
        });

        const gatewayHelloCountBeforeWorkboardEnabled = gatewayHelloMethods.length;
        await instance.stopGateway();
        await page
          .getByText("Outcome connection unavailable", { exact: true })
          .waitFor({ state: "visible" });
        await instance.state.writeConfig(
          outcomeGatewayConfig(instance, { outcomesEnabled: true, workboardEnabled: true }),
        );
        await instance.startGateway();
        await waitForControlUiGatewayReady(page);
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await expect
          .poll(() =>
            gatewayHelloMethods
              .slice(gatewayHelloCountBeforeWorkboardEnabled)
              .some((methods) => methods.includes("workboard.cards.list")),
          )
          .toBe(true);
        await page
          .locator(".outcome-summary", { hasText: "Release Outcome E2E" })
          .waitFor({ state: "visible" });
        await page.locator("[data-outcome-select]").click();
        await expect
          .poll(() =>
            page.locator("[data-outcome-detail-id]").getAttribute("data-outcome-detail-id"),
          )
          .toBe(outcomeId);
        const restoredDetail = page.locator("[data-outcome-detail-id]");
        await restoredDetail.locator(`[data-outcome-work-card="${cardId}"]`).waitFor({
          state: "visible",
        });
        const restoredEvidence = restoredDetail.locator(`[data-outcome-evidence="${proofId}"]`);
        await restoredEvidence.waitFor({ state: "visible" });
        await expect
          .poll(async () => await restoredEvidence.textContent())
          .toContain("Proof: Outcome E2E verification");
        await expect
          .poll(async () => await restoredEvidence.textContent())
          .toContain("Proof status: passed");

        const gatewayHelloCountBeforeOutcomesDisabled = gatewayHelloMethods.length;
        await instance.stopGateway();
        await page
          .getByText("Outcome connection unavailable", { exact: true })
          .waitFor({ state: "visible" });
        await instance.state.writeConfig(
          outcomeGatewayConfig(instance, { outcomesEnabled: false, workboardEnabled: true }),
        );
        await instance.startGateway();
        await waitForControlUiGatewayReady(page);
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await expect
          .poll(() =>
            gatewayHelloMethods
              .slice(gatewayHelloCountBeforeOutcomesDisabled)
              .some((methods) => !methods.includes("outcomes.list")),
          )
          .toBe(true);
        await page.getByText("Outcome access unavailable", { exact: true }).waitFor({
          state: "visible",
        });
        await expect.poll(() => page.locator(".outcomes-list").count()).toBe(0);

        const gatewayHelloCountBeforeOutcomesEnabled = gatewayHelloMethods.length;
        await instance.stopGateway();
        await page
          .getByText("Outcome connection unavailable", { exact: true })
          .waitFor({ state: "visible" });
        await instance.state.writeConfig(
          outcomeGatewayConfig(instance, { outcomesEnabled: true, workboardEnabled: true }),
        );
        await instance.startGateway();
        await waitForControlUiGatewayReady(page);
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await expect
          .poll(() =>
            gatewayHelloMethods
              .slice(gatewayHelloCountBeforeOutcomesEnabled)
              .some((methods) => methods.includes("outcomes.list")),
          )
          .toBe(true);
        await page
          .locator(".outcome-summary", { hasText: "Release Outcome E2E" })
          .waitFor({ state: "visible" });
        await page.locator("[data-outcome-select]").click();
        await expect
          .poll(() =>
            page.locator("[data-outcome-detail-id]").getAttribute("data-outcome-detail-id"),
          )
          .toBe(outcomeId);
        await restoredDetail.locator(`[data-outcome-work-card="${cardId}"]`).waitFor({
          state: "visible",
        });
        await restoredDetail.locator(`[data-outcome-evidence="${proofId}"]`).waitFor({
          state: "visible",
        });
        const cancel = restoredDetail.locator('[data-outcome-action="cancel"]');
        await cancel.focus();
        await page.keyboard.press("Enter");
        const cancelDialog = page.locator(".outcome-cancel-dialog");
        await cancelDialog.waitFor({ state: "visible" });
        await restoredDetail.locator('[data-outcome-phase="active"]').waitFor({ state: "visible" });
        const confirmCancel = cancelDialog.locator("[data-outcome-confirm-cancel]");
        await confirmCancel.focus();
        await page.keyboard.press("Enter");
        await restoredDetail
          .locator('[data-outcome-phase="cancelled"]')
          .waitFor({ state: "visible" });
      },
    );
  });

  it("records a verified decision and accepts its current closure through the real Gateway", async () => {
    const cardId = requireCardId(
      await callGateway("workboard.cards.create", {
        priority: "normal",
        title: "Accept real Outcome evidence",
      }),
    );
    const proofId = requireProofId(
      await callGateway("workboard.cards.proof", {
        id: cardId,
        label: "Outcome acceptance verification",
        status: "passed",
      }),
    );
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const browserOutcomeReplies = captureBrowserOutcomeReplies(page);
        await page.goto(await outcomesUrl());
        await waitForControlUiGatewayReady(page);
        await page.locator('[data-outcome-action="create"]').click();
        const createForm = page.locator("[data-outcome-create-form]");
        await createForm.locator('input[name="title"]').fill("Accept Outcome E2E");
        await createForm.locator('textarea[name="objective"]').fill("Prove human acceptance");
        await createForm.locator('input[name="criterion"]').fill("Proof is reviewed");
        await createForm.locator("[data-outcome-confirm-create]").click();

        const summary = page.locator(".outcome-summary", { hasText: "Accept Outcome E2E" });
        await summary.locator("[data-outcome-select]").click();
        const detail = page.locator("[data-outcome-detail-id]");
        await detail.waitFor({ state: "visible" });
        await detail.locator('[data-outcome-action="link-work"]').click();
        const linkForm = page.locator("[data-outcome-link-form]");
        await linkForm.locator('select[name="card"]').selectOption(cardId);
        await linkForm.locator("[data-outcome-confirm-link]").click();
        await detail.locator(`[data-outcome-work-card="${cardId}"]`).waitFor({ state: "visible" });
        await detail.locator('[data-outcome-action="activate"]').click();
        await detail.locator('[data-outcome-phase="active"]').waitFor({ state: "visible" });
        await detail.locator('[data-outcome-action="refresh"]').click();
        await detail.locator(`[data-outcome-evidence="${proofId}"]`).waitFor({ state: "visible" });

        await detail.locator('[data-outcome-action="review-evidence"]').click();
        const verificationForm = page.locator("[data-outcome-verification-form]");
        await verificationForm.waitFor({ state: "visible" });
        await verificationForm.locator("[data-outcome-confirm-verification]").click();
        await detail
          .locator("[data-outcome-decision]")
          .getByText("Verified", { exact: true })
          .waitFor({
            state: "visible",
          });
        const firstDecision = detail.locator("[data-outcome-decision]").first();
        const firstDecisionDetails = firstDecision.locator("details");
        await firstDecision.locator("summary").focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => firstDecisionDetails.getAttribute("open")).toBe("");
        await firstDecision
          .locator(".outcome-detail__historical-plan > p")
          .getByText("Objective: Prove human acceptance", { exact: true })
          .waitFor({ state: "visible" });
        await firstDecision.getByText("Proof is reviewed", { exact: true }).waitFor({
          state: "visible",
        });
        await page.keyboard.press("Space");
        await expect.poll(() => firstDecisionDetails.getAttribute("open")).toBeNull();
        await detail.locator('[data-outcome-action="accept"]').click();
        await detail.locator('[data-outcome-phase="accepted"]').waitFor({ state: "visible" });
        await detail.locator("[data-outcome-acceptance-history]").waitFor({ state: "visible" });
        const acceptedOutcomeId = await detail.getAttribute("data-outcome-detail-id");
        if (!acceptedOutcomeId) {
          throw new Error("Accepted Outcome detail omitted its ID");
        }
        if (!instance) {
          throw new Error("Outcome Gateway fixture was not started");
        }
        const sourceInstance = instance;
        browserOutcomeReplies.setPhase("source-accepted");
        await page.goto(await outcomesUrlFor(sourceInstance));
        await waitForControlUiGatewayReady(page);
        await page
          .locator(".outcome-summary", { hasText: "Accept Outcome E2E" })
          .locator("[data-outcome-select]")
          .click();
        const sourceDetail = await browserOutcomeReplies.reply(
          "source-accepted",
          "outcomes.get",
          acceptedOutcomeId,
        );
        const sourcePayload = isGatewayCallResult(sourceDetail.payload)
          ? sourceDetail.payload
          : undefined;
        const sourceOutcome =
          sourcePayload && isGatewayCallResult(sourcePayload.outcome)
            ? sourcePayload.outcome
            : undefined;
        if (!sourceOutcome) {
          throw new Error("Accepted Outcome source detail omitted its public state");
        }
        expect(sourceOutcome.planHash).toMatch(/^[a-f0-9]{64}$/u);
        expect(sourceOutcome.closureHash).toMatch(/^[a-f0-9]{64}$/u);
        const sourceCards = await callGatewayFor(sourceInstance, "workboard.cards.list", {});
        let restoredInstance: OpenClawTestInstance | undefined;
        let sourceStopped = false;
        try {
          // A stopped source makes this an archive/restore test, rather than a read from the
          // running source. The target has its own port, token, and isolated state root.
          await sourceInstance.stopGateway();
          sourceStopped = true;
          const sourcePersistedEntries = await readPersistedOutcomeEntries(sourceInstance.env);
          const acceptedPersistedEntry = sourcePersistedEntries.find(
            ({ key }) => key === acceptedOutcomeId,
          );
          expect(acceptedPersistedEntry?.value).toMatchObject({
            phase: "accepted",
            planHash: sourceOutcome.planHash,
            evidence: expect.any(Array),
            decisions: expect.any(Array),
            acceptances: expect.any(Array),
          });
          const backup = await withEnvAsync(
            sourceInstance.env,
            async () =>
              await createBackupArchive({
                output: sourceInstance.state.path("accepted-outcome-backup.tar.gz"),
                includeWorkspace: false,
              }),
          );
          const restored = await backupRestoreCommand(createBackupRuntime(), {
            archive: backup.archivePath,
            target: sourceInstance.state.path("accepted-outcome-restore"),
          });
          const sourceState = backup.assets.find((asset) => asset.kind === "state");
          if (!sourceState) {
            throw new Error("Accepted Outcome backup omitted its state asset");
          }
          const restoredStateDir = path.join(
            restored.targetPath,
            buildBackupArchivePath(backup.archiveRoot, sourceState.sourcePath),
          );
          restoredInstance = await createOpenClawTestInstance({
            name: "control-ui-outcomes-restore",
            startTimeoutMs: 120_000,
            env: realGatewayPluginEnv,
            config: {
              gateway: { controlUi: { enabled: true } },
              plugins: {
                enabled: true,
                allow: ["outcomes", "workboard"],
                entries: {
                  outcomes: { enabled: true },
                  workboard: { enabled: false },
                },
              },
            },
          });
          // The archive is intentionally restored to staging. Activation is explicit, so place
          // its verified state asset in the target instance before its first Gateway startup.
          await rm(restoredInstance.stateDir, { recursive: true, force: true });
          await cp(restoredStateDir, restoredInstance.stateDir, { recursive: true });
          await restoredInstance.state.writeConfig(
            outcomeGatewayConfig(restoredInstance, {
              outcomesEnabled: true,
              workboardEnabled: false,
            }),
          );
          expect(await readPersistedOutcomeEntries(restoredInstance.env)).toEqual(
            sourcePersistedEntries,
          );
          await restoredInstance.startGateway();

          // Use the Control UI's owner-authenticated transport for both reads.
          // The shared-token CLI deliberately has no profile identity, and is
          // therefore not a valid reader for owner-scoped Outcome records.
          browserOutcomeReplies.setPhase("restored-unrechecked");
          await page.goto(await outcomesUrlFor(restoredInstance));
          await waitForControlUiGatewayReady(page);
          await page
            .locator(".outcome-summary", { hasText: "Accept Outcome E2E" })
            .locator("[data-outcome-select]")
            .click();
          const unrecheckedDetail = page.locator(`[data-outcome-detail-id="${acceptedOutcomeId}"]`);
          await unrecheckedDetail.locator('[data-outcome-phase="accepted"]').waitFor({
            state: "visible",
          });
          await unrecheckedDetail
            .locator('[data-outcome-acceptance="needs-review"]')
            .waitFor({ state: "visible" });
          await unrecheckedDetail
            .locator("[data-outcome-decision]")
            .getByText("Verified", { exact: true })
            .waitFor({ state: "visible" });
          const restoredAcceptance = unrecheckedDetail
            .locator("[data-outcome-acceptance-history]")
            .first();
          await restoredAcceptance.locator("summary").click();
          await restoredAcceptance
            .locator(".outcome-detail__historical-plan > p")
            .getByText("Objective: Prove human acceptance", { exact: true })
            .waitFor({ state: "visible" });
          await restoredAcceptance.getByText("Proof is reviewed", { exact: true }).waitFor({
            state: "visible",
          });
          const unrechecked = await browserOutcomeReplies.reply(
            "restored-unrechecked",
            "outcomes.get",
            acceptedOutcomeId,
          );
          const unrecheckedPayload = isGatewayCallResult(unrechecked.payload)
            ? unrechecked.payload
            : undefined;
          const unrecheckedOutcome =
            unrecheckedPayload && isGatewayCallResult(unrecheckedPayload.outcome)
              ? unrecheckedPayload.outcome
              : undefined;
          if (!unrecheckedOutcome) {
            throw new Error("Restored Outcome detail omitted its public state");
          }
          expect(unrecheckedOutcome).toMatchObject({
            id: acceptedOutcomeId,
            phase: "accepted",
            acceptance: { acceptanceValidity: "needs-review", reason: "not-rechecked" },
            criteria: [{ sourcesVisibility: "restricted", workRefs: [] }],
            evidence: [],
            decisions: [
              { status: "verified", decidedPlan: { objective: "Prove human acceptance" } },
            ],
            acceptances: [{ acceptedPlan: { objective: "Prove human acceptance" } }],
          });

          await restoredInstance.stopGateway();
          await restoredInstance.state.writeConfig(
            outcomeGatewayConfig(restoredInstance, {
              outcomesEnabled: true,
              workboardEnabled: true,
            }),
          );
          await restoredInstance.startGateway();
          browserOutcomeReplies.setPhase("restored-rechecked");
          await page.goto(await outcomesUrlFor(restoredInstance));
          await waitForControlUiGatewayReady(page);
          await page
            .locator(".outcome-summary", { hasText: "Accept Outcome E2E" })
            .locator("[data-outcome-select]")
            .click();
          const recheckedDetail = page.locator(`[data-outcome-detail-id="${acceptedOutcomeId}"]`);
          const restoredCards = await callGatewayFor(restoredInstance, "workboard.cards.list", {});
          expect(restoredCards).toEqual(sourceCards);
          await recheckedDetail.locator(`[data-outcome-work-card="${cardId}"]`).waitFor({
            state: "visible",
          });
          await recheckedDetail.locator('[data-outcome-action="refresh"]').click();
          await recheckedDetail.locator('[data-outcome-acceptance="current"]').waitFor({
            state: "visible",
          });
          await recheckedDetail.locator(`[data-outcome-evidence="${proofId}"]`).waitFor({
            state: "visible",
          });
          const rechecked = await browserOutcomeReplies.reply(
            "restored-rechecked",
            "outcomes.refresh",
            acceptedOutcomeId,
          );
          const recheckedPayload = isGatewayCallResult(rechecked.payload)
            ? rechecked.payload
            : undefined;
          const recheckedOutcome =
            recheckedPayload && isGatewayCallResult(recheckedPayload.outcome)
              ? recheckedPayload.outcome
              : undefined;
          if (!recheckedOutcome) {
            throw new Error("Rechecked Outcome detail omitted its public state");
          }
          expect(recheckedOutcome).toMatchObject({
            id: acceptedOutcomeId,
            acceptance: { acceptanceValidity: "current" },
          });
          expect({
            acceptances: recheckedOutcome.acceptances,
            closureHash: recheckedOutcome.closureHash,
            criteria: recheckedOutcome.criteria,
            decisions: recheckedOutcome.decisions,
            planHash: recheckedOutcome.planHash,
          }).toEqual({
            acceptances: sourceOutcome.acceptances,
            closureHash: sourceOutcome.closureHash,
            criteria: sourceOutcome.criteria,
            decisions: sourceOutcome.decisions,
            planHash: sourceOutcome.planHash,
          });
        } finally {
          try {
            await restoredInstance?.cleanup();
          } finally {
            if (sourceStopped) {
              await sourceInstance.state.writeConfig(
                outcomeGatewayConfig(sourceInstance, {
                  outcomesEnabled: true,
                  workboardEnabled: true,
                }),
              );
              await sourceInstance.startGateway();
              browserOutcomeReplies.setPhase("source-resumed");
              await page.goto(await outcomesUrlFor(sourceInstance));
              await waitForControlUiGatewayReady(page);
              await page
                .locator(".outcome-summary", { hasText: "Accept Outcome E2E" })
                .locator("[data-outcome-select]")
                .click();
            }
          }
        }
        await callGateway("workboard.cards.proof", {
          id: cardId,
          label: "Outcome acceptance evidence changed",
          status: "passed",
        });
        await detail.locator('[data-outcome-action="refresh"]').click();
        await detail
          .locator('[data-outcome-acceptance="needs-review"]')
          .waitFor({ state: "visible" });
        await expect.poll(() => detail.locator('[data-outcome-action="accept"]').count()).toBe(0);
        await detail.locator('[data-outcome-action="review-evidence"]').click();
        await verificationForm.locator('select[name="status"]').selectOption("rejected");
        await verificationForm.locator('textarea[name="note"]').fill("The new proof needs review");
        await verificationForm.locator("[data-outcome-confirm-verification]").click();
        await expect.poll(() => detail.locator("[data-outcome-decision]").count()).toBe(2);
        await detail
          .locator("[data-outcome-decision]")
          .getByText("Rejected", { exact: true })
          .waitFor({
            state: "visible",
          });
        await detail.locator('[data-outcome-action="review-evidence"]').click();
        await verificationForm.locator("[data-outcome-confirm-verification]").click();
        await expect.poll(() => detail.locator("[data-outcome-decision]").count()).toBe(3);
        await detail.locator('[data-outcome-action="accept"]').click();
        await detail.locator('[data-outcome-acceptance="current"]').waitFor({ state: "visible" });

        if (!instance) {
          throw new Error("Outcome Gateway fixture was not started");
        }
        const outcomeInstance = instance;
        try {
          await outcomeInstance.stopGateway();
          await page
            .getByText("Outcome connection unavailable", { exact: true })
            .waitFor({ state: "visible" });
          await outcomeInstance.state.writeConfig(
            outcomeGatewayConfig(outcomeInstance, {
              outcomesEnabled: true,
              workboardEnabled: false,
            }),
          );
          await outcomeInstance.startGateway();
          await waitForControlUiGatewayReady(page);
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await page
            .locator(".outcome-summary", { hasText: "Accept Outcome E2E" })
            .locator("[data-outcome-select]")
            .click();
          const unavailableDetail = page.locator("[data-outcome-detail-id]");
          await unavailableDetail.locator('[data-outcome-acceptance="needs-review"]').waitFor({
            state: "visible",
          });
          await expect
            .poll(() => unavailableDetail.locator('[data-outcome-action="accept"]').count())
            .toBe(0);
          await expect
            .poll(() => unavailableDetail.locator(`[data-outcome-evidence="${proofId}"]`).count())
            .toBe(0);
        } finally {
          await outcomeInstance.stopGateway();
          await outcomeInstance.state.writeConfig(
            outcomeGatewayConfig(outcomeInstance, {
              outcomesEnabled: true,
              workboardEnabled: true,
            }),
          );
          await outcomeInstance.startGateway();
          await waitForControlUiGatewayReady(page);
          await page.reload();
          await waitForControlUiGatewayReady(page);
        }
        await page
          .locator(".outcome-summary", { hasText: "Accept Outcome E2E" })
          .locator("[data-outcome-select]")
          .click();
        const restoredDetail = page.locator("[data-outcome-detail-id]");
        await restoredDetail
          .locator('[data-outcome-acceptance="current"]')
          .waitFor({ state: "visible" });
        await restoredDetail.locator('[data-outcome-action="edit-contract"]').click();
        const editForm = page.locator("[data-outcome-edit-form]");
        await editForm.locator('textarea[name="objective"]').fill("Revised accepted objective");
        await editForm.locator("[data-outcome-confirm-edit]").click();
        await restoredDetail.getByText("Revised accepted objective", { exact: true }).waitFor({
          state: "visible",
        });
        await restoredDetail.locator('[data-outcome-phase="active"]').waitFor({ state: "visible" });
        await restoredDetail.locator('[data-outcome-acceptance="needs-review"]').waitFor({
          state: "visible",
        });
        const firstAcceptance = restoredDetail.locator("[data-outcome-acceptance-history]").first();
        await firstAcceptance.locator("summary").click();
        await firstAcceptance
          .locator(".outcome-detail__historical-plan > p")
          .getByText("Objective: Prove human acceptance", { exact: true })
          .waitFor({ state: "visible" });
        await firstAcceptance.getByText("Proof is reviewed", { exact: true }).waitFor({
          state: "visible",
        });
      },
    );
  });

  it("keeps the keyboard create flow usable without horizontal overflow on a narrow screen", async () => {
    await verifyOutcomeMobileKeyboardFlow(suite, outcomesUrl);
  });

  it("hides Outcome content after the browser operator token is revoked", async () => {
    if (!instance) {
      throw new Error("Outcome Gateway fixture was not started");
    }
    await verifyOutcomeRevocation(suite, instance, outcomesUrl);
  });
});

unavailableSuite.define(() => {
  it("renders the unavailable Outcome state when the real Gateway does not advertise Outcome access", async () => {
    if (!unavailableInstance) {
      throw new Error("Unavailable Outcome Gateway fixture was not started");
    }
    await verifyUnavailableOutcomeState(unavailableSuite, unavailableInstance);
  });
});
