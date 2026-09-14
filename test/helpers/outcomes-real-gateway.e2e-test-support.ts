import path from "node:path";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { Page } from "playwright";
import { expect } from "vitest";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";
import type { RuntimeEnv } from "../../src/runtime.js";
import { GATEWAY_CLIENT_NAMES } from "../../src/utils/message-channel.ts";
import {
  waitForControlUiGatewayReady,
} from "../../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import type { ControlUiE2eSuite } from "../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import type { OpenClawTestInstance } from "./openclaw-test-instance.ts";

export const outcomeStoreOptions = {
  namespace: "outcomes-v1",
  maxEntries: 500,
  overflowPolicy: "reject-new" as const,
};

export type GatewayCallResult = Record<string, unknown>;

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

export function createBackupRuntime(): RuntimeEnv {
  return {
    log: () => undefined,
    error: () => undefined,
    exit: () => undefined,
  };
}

export async function listPairedDevices(
  instance: OpenClawTestInstance,
): Promise<GatewayCallResult[]> {
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

export async function revokeOperatorToken(
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

export function requireNewBrowserDeviceId(
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
