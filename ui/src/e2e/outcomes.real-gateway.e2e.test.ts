// Real Gateway proof for the Outcome Center's persisted public workflow.
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gateway dashboard handoff was invalid");
  }
  const browserUrl = (parsed as Record<string, unknown>).browserUrl;
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
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw new Error("Workboard create omitted its card");
  }
  const id = (card as Record<string, unknown>).id;
  if (typeof id !== "string") {
    throw new Error("Workboard create omitted its card ID");
  }
  return id;
}

suite.define(() => {
  it("creates, links, starts, refreshes, and reloads an Outcome through the real Gateway", async () => {
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
        await detail.locator('[data-outcome-action="link-work"]').click();
        const linkForm = page.locator("[data-outcome-link-form]");
        await linkForm.locator('select[name="card"]').selectOption(cardId);
        await linkForm.locator("[data-outcome-confirm-link]").click();
        await expect(detail.getByText(`Card ${cardId}`, { exact: true })).toBeVisible();

        await detail.locator('[data-outcome-action="activate"]').click();
        await detail.locator('[data-outcome-action="refresh"]').click();

        if (!instance) {
          throw new Error("Outcome Gateway fixture was not started");
        }
        await instance.stopGateway();
        await instance.startGateway();
        await waitForControlUiGatewayReady(page);
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await expect(page.locator(".outcome-summary", { hasText: "Release Outcome E2E" })).toBeVisible();
      },
    );
  });
});
