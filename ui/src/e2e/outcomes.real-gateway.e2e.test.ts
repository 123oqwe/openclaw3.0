// Real Gateway proof for the Outcome Center's persisted public workflow.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../../../src/infra/device-identity.js";
import { GATEWAY_CLIENT_NAMES } from "../../../src/utils/message-channel.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

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

type GatewayCallResult = Record<string, unknown>;

function isGatewayCallResult(value: unknown): value is GatewayCallResult {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function gatewayFrame(payload: { toString(): string }): GatewayCallResult | undefined {
  try {
    const parsed: unknown = JSON.parse(payload.toString());
    return isGatewayCallResult(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function callGateway(
  method: string,
  params: Record<string, unknown>,
): Promise<GatewayCallResult> {
  if (!instance) {
    throw new Error("Outcome Gateway fixture was not started");
  }
  const result = await instance.cli([
    "--no-color",
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify(params),
    "--json",
  ]);
  expect(result.code, `${method} failed: ${result.stderr}`).toBe(0);
  expect(result.signal).toBeNull();
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isGatewayCallResult(parsed)) {
    throw new Error(`${method} returned an invalid Gateway payload`);
  }
  return parsed;
}

async function listPairedDevices(): Promise<GatewayCallResult[]> {
  if (!instance) {
    throw new Error("Outcome Gateway fixture was not started");
  }
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

async function revokeOperatorToken(deviceId: string): Promise<void> {
  if (!instance) {
    throw new Error("Outcome Gateway fixture was not started");
  }
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

async function outcomesUrlFor(owner: OpenClawTestInstance): Promise<string> {
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

async function outcomesUrl(): Promise<string> {
  if (!instance) {
    throw new Error("Outcome Gateway fixture was not started");
  }
  return outcomesUrlFor(instance);
}

function requireCardId(payload: GatewayCallResult): string {
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

function requireProofId(payload: GatewayCallResult): string {
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

function outcomeGatewayConfig(owner: OpenClawTestInstance, workboardEnabled: boolean) {
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
        outcomes: { enabled: true },
        workboard: { enabled: workboardEnabled },
      },
    },
  };
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
        const refreshReplies = new Map<string, boolean>();
        page.on("websocket", (socket) => {
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
            if (
              frame?.type === "res" &&
              typeof frame.id === "string" &&
              refreshRequestIds.has(frame.id)
            ) {
              refreshReplies.set(frame.id, frame.ok === true);
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
        expect(refreshReplies.get(refreshRequestId)).toBe(true);
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
        await page.clock.fastForward(twentyFourHoursMs + 1);
        const freshnessClockAfterExpiry = await page.evaluate(() => performance.now());
        expect(freshnessClockAfterExpiry - freshnessClockBeforeExpiry).toBeGreaterThanOrEqual(
          twentyFourHoursMs,
        );
        await detail.locator('[data-outcome-readiness="stale"]').waitFor({ state: "visible" });
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
        await instance.state.writeConfig(outcomeGatewayConfig(instance, false));
        await instance.startGateway();
        await waitForControlUiGatewayReady(page);
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await page
          .locator(".outcome-summary", { hasText: "Release Outcome E2E" })
          .waitFor({ state: "visible" });
        await page.locator("[data-outcome-select]").click();
        await page.getByText("Workboard disabled", { exact: true }).waitFor({ state: "visible" });
        await page.screenshot({
          fullPage: true,
          path: path.join(suite.artifactDir, "outcomes-workboard-disabled.png"),
        });

        await instance.stopGateway();
        await page
          .getByText("Outcome connection unavailable", { exact: true })
          .waitFor({ state: "visible" });
        await instance.state.writeConfig(outcomeGatewayConfig(instance, true));
        await instance.startGateway();
        await waitForControlUiGatewayReady(page);
        await page.reload();
        await waitForControlUiGatewayReady(page);
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

  it("keeps the keyboard create flow usable without horizontal overflow on a narrow screen", async () => {
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
        await title.focus();
        await page.keyboard.type(titleText);
        const objective = form.locator('textarea[name="objective"]');
        await objective.focus();
        await page.keyboard.type("Prove the narrow-screen keyboard flow");
        const criterion = form.locator('input[name="criterion"]');
        await criterion.focus();
        await page.keyboard.type("A required criterion is recorded");
        const confirm = form.locator("[data-outcome-confirm-create]");
        await confirm.focus();
        await page.keyboard.press("Enter");

        await page
          .locator(".outcome-summary", { hasText: titleText })
          .waitFor({ state: "visible" });
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
  });

  it("hides Outcome content after the browser operator token is revoked", async () => {
    const existingDeviceIds = new Set(
      (await listPairedDevices())
        .map((device) => device.deviceId)
        .filter((deviceId): deviceId is string => typeof deviceId === "string"),
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
          await listPairedDevices(),
          existingDeviceIds,
        );
        await revokeOperatorToken(browserDeviceId);

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
  });
});

unavailableSuite.define(() => {
  it("renders the unavailable Outcome state when the real Gateway does not advertise Outcome access", async () => {
    if (!unavailableInstance) {
      throw new Error("Unavailable Outcome Gateway fixture was not started");
    }
    const instance = unavailableInstance;
    await unavailableSuite.withPage(
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
          path: path.join(unavailableSuite.artifactDir, "outcomes-access-unavailable.png"),
        });
      },
    );
  });
});
