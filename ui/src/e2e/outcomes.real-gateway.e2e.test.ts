// Real Gateway proof for the Outcome Center's persisted public workflow.
import path from "node:path";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Outcomes with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-outcomes",
      config: {
        gateway: { controlUi: { enabled: true } },
        plugins: {
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

type GatewayCallResult = Record<string, unknown>;

function isGatewayCallResult(value: unknown): value is GatewayCallResult {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function callGateway(method: string, params: Record<string, unknown>): Promise<GatewayCallResult> {
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
  ]);
  expect(result.code, `${method} failed: ${result.stderr}`).toBe(0);
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
  const result = await instance.cli(["--no-color", "dashboard", "--json"]);
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

function requireOutcome(payload: GatewayCallResult): GatewayCallResult {
  const outcome = payload.outcome;
  if (!isGatewayCallResult(outcome)) {
    throw new Error("Outcome Gateway response omitted its outcome");
  }
  return outcome;
}

function requireNumber(payload: GatewayCallResult, key: string): number {
  const value = payload[key];
  if (typeof value !== "number") {
    throw new Error(`Outcome Gateway response omitted numeric ${key}`);
  }
  return value;
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
        await page.goto(await outcomesUrl());
        await waitForControlUiGatewayReady(page);

        await page.locator('[data-outcome-action="create"]').click();
        const createForm = page.locator("[data-outcome-create-form]");
        await createForm.locator('input[name="title"]').fill("Release Outcome E2E");
        await createForm.locator('textarea[name="objective"]').fill("Prove the public Outcome flow");
        await createForm.locator('input[name="criterion"]').fill("A real Workboard card is linked");
        await createForm.locator("[data-outcome-confirm-create]").click();

        const summary = page.locator(".outcome-summary", { hasText: "Release Outcome E2E" });
        await summary.waitFor({ state: "visible" });
        await summary.locator("[data-outcome-select]").click();

        const detail = page.locator("[data-outcome-detail-id]");
        await detail.waitFor({ state: "visible" });
        const outcomeId = await detail.getAttribute("data-outcome-detail-id");
        if (!outcomeId) {
          throw new Error("Outcome detail omitted its ID");
        }
        await detail.locator('[data-outcome-action="link-work"]').click();
        const linkForm = page.locator("[data-outcome-link-form]");
        await linkForm.locator('select[name="card"]').selectOption(cardId);
        await linkForm.locator("[data-outcome-confirm-link]").click();
        await detail.getByText(`Card ${cardId}`, { exact: true }).waitFor({ state: "visible" });

        await callGateway("workboard.cards.proof", {
          id: cardId,
          label: "Outcome E2E verification",
          status: "passed",
        });
        await detail.locator('[data-outcome-action="activate"]').click();
        await detail.locator('[data-outcome-phase="active"]').waitFor({ state: "visible" });
        await expect.poll(() => detail.locator('[data-outcome-action="activate"]').count()).toBe(0);
        const activated = requireOutcome(await callGateway("outcomes.get", { id: outcomeId }));
        expect(activated.phase).toBe("active");
        const activatedRevision = requireNumber(activated, "revision");

        await detail.locator('[data-outcome-action="refresh"]').click();
        await expect
          .poll(() => detail.locator('[data-outcome-action="refresh"]').isEnabled())
          .toBe(true);
        await detail
          .getByText("Proof: Outcome E2E verification", { exact: true })
          .waitFor({ state: "visible" });
        const refreshed = requireOutcome(await callGateway("outcomes.get", { id: outcomeId }));
        expect(requireNumber(refreshed, "revision")).toBeGreaterThan(activatedRevision);
        expect(refreshed.evidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ label: "Outcome E2E verification", proofStatus: "passed" }),
          ]),
        );

        if (!instance) {
          throw new Error("Outcome Gateway fixture was not started");
        }
        await instance.stopGateway();
        await page.getByText("Outcome connection unavailable", { exact: true }).waitFor({ state: "visible" });
        await expect.poll(() => detail.count()).toBe(0);
        await instance.startGateway();
        await waitForControlUiGatewayReady(page);
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await page
          .locator(".outcome-summary", { hasText: "Release Outcome E2E" })
          .waitFor({ state: "visible" });
        await page.locator('[data-outcome-select]').click();
        await expect
          .poll(() => page.locator('[data-outcome-detail-id]').getAttribute("data-outcome-detail-id"))
          .toBe(outcomeId);
      },
    );
  });

  it("keeps the keyboard create flow usable without horizontal overflow on a narrow screen", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 852, width: 393 },
      },
      async ({ page }) => {
        await page.goto(await outcomesUrl());
        await waitForControlUiGatewayReady(page);

        const create = page.locator('[data-outcome-action="create"]');
        await create.focus();
        await page.keyboard.press("Enter");
        const form = page.locator("[data-outcome-create-form]");
        await form.waitFor({ state: "visible" });
        const title = form.locator('input[name="title"]');
        await title.focus();
        await page.keyboard.type("Mobile keyboard Outcome");
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
          .locator(".outcome-summary", { hasText: "Mobile keyboard Outcome" })
          .waitFor({ state: "visible" });
        await expect
          .poll(() => create.evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          fullPage: true,
          path: path.join(suite.artifactDir, "outcomes-mobile-keyboard-create.png"),
        });
      },
    );
  });
});
