import path from "node:path";
import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI browser bootstrap" });

suite.define(() => {
  it("recovers a bare HTTPS deep link and reuses the paired browser credential on reload", async () => {
    const artifactDir = suite.artifactDir;
    const video = await suite.withPage(
      {
        viewport: { width: 1440, height: 1000 },
        locale: "en-US",
        serviceWorkers: "block",
        recordVideo: { dir: artifactDir, size: { width: 1440, height: 1000 } },
      },
      async ({ page }) => {
        const origin = "https://gateway.example";
        const sessionKey = "agent:main:browser-bootstrap-proof";
        const deepLink = `${controlUiSessionUrl(`${origin}/`, sessionKey)}?keep=yes#section`;
        const bootstrapToken = "synthetic-owner-bootstrap";
        const deviceToken = "synthetic-paired-browser";
        let helperCalls = 0;
        let diagnosticSequence = 0;
        let broadRequestId = 0;
        const activeBroadRequests = new Set<number>();
        const trace = (stage: string, routePath?: string) => {
          diagnosticSequence += 1;
          console.info(
            `[browser-bootstrap-diagnostic] seq=${diagnosticSequence} stage=${stage} path=${routePath ?? "none"}`,
          );
        };
        let releaseHandoff!: () => void;
        const handoffReady = new Promise<void>((resolve) => {
          releaseHandoff = resolve;
        });

        await runQaGatewayFixture(
          async () => {
            // Exercise secure-origin browser behavior while serving only this test's local bundle.
            await page.route(`${origin}/**`, async (route) => {
              const requested = new URL(route.request().url());
              const requestId = ++broadRequestId;
              activeBroadRequests.add(requestId);
              trace("broad-enter", `${requestId}:${requested.pathname}`);
              try {
              const isDiagnosticPath =
                requested.pathname === "/avatar/main" ||
                requested.pathname === "/.well-known/openclaw/browser-bootstrap";
              if (isDiagnosticPath) {
                trace("broad-diagnostic", `${requestId}:${requested.pathname}`);
              }
              if (requested.pathname === "/.well-known/openclaw/browser-bootstrap") {
                trace("broad-fallback", `${requestId}:${requested.pathname}`);
                await route.fallback();
                return;
              }
              if (requested.pathname === "/avatar/main") {
                trace("avatar-fulfill-before", `${requestId}:${requested.pathname}`);
                await route.fulfill({ status: 404, body: "" });
                trace("avatar-fulfill-after", `${requestId}:${requested.pathname}`);
                return;
              }
              const upstream = new URL(
                `${requested.pathname}${requested.search}`,
                suite.server.baseUrl,
              );
              trace("broad-fetch-before", `${requestId}:${requested.pathname}`);
              const response = await route.fetch({ url: upstream.href });
              trace("broad-fetch-complete", `${requestId}:${requested.pathname}`);
              trace("broad-fulfill-before", `${requestId}:${requested.pathname}`);
              await route.fulfill({ response });
              trace("broad-fulfill-after", `${requestId}:${requested.pathname}`);
              } catch (error) {
                trace("broad-error", `${requestId}:${requested.pathname}`);
                throw error;
              } finally {
                activeBroadRequests.delete(requestId);
              }
            });
            const gateway = await installMockGateway(page, {
              sessionKey,
              deviceToken,
              heldMethods: ["connect"],
              historyMessages: [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: "Your browser is connected. This is synthetic proof data.",
                    },
                  ],
                },
              ],
            });
            await page.route(`${origin}/.well-known/openclaw/browser-bootstrap`, async (route) => {
              trace("bootstrap-enter", "/.well-known/openclaw/browser-bootstrap");
              helperCalls += 1;
              expect(route.request().method()).toBe("GET");
              expect(route.request().headers().authorization).toBeUndefined();
              await handoffReady;
              trace("bootstrap-fulfill-before", "/.well-known/openclaw/browser-bootstrap");
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                headers: { "Cache-Control": "no-store" },
                body: JSON.stringify({ bootstrapToken, bootstrapProfile: "owner" }),
              });
              trace("bootstrap-fulfill-after", "/.well-known/openclaw/browser-bootstrap");
            });

            trace("goto-before", "/");
            await page.goto(deepLink);
            trace("goto-after", "/");
            const initialConnect = await gateway.waitForRequest("connect");
            expect(initialConnect.params).not.toHaveProperty("auth.bootstrapToken");
            expect(initialConnect.params).not.toHaveProperty("auth.deviceToken");
            await gateway.rejectDeferred("connect", {
              code: "INVALID_REQUEST",
              message: "The Gateway needs a matching token or password.",
              details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
            });
            await page.getByText("Auth required", { exact: true }).waitFor();
            await expect.poll(() => helperCalls).toBe(1);
            await page.screenshot({ path: path.join(artifactDir, "1-auth-required.png") });

            await gateway.deferNext("connect");
            releaseHandoff();
            const recoveredConnect = await gateway.waitForRequest("connect", { after: 1 });
            expect(recoveredConnect.params).toMatchObject({
              auth: { bootstrapToken },
              device: { id: expect.any(String), signature: expect.any(String) },
            });
            await gateway.resolveDeferred("connect");
            await waitForControlUiGatewayReady(page);
            await page
              .getByText("Your browser is connected. This is synthetic proof data.", {
                exact: true,
              })
              .waitFor();
            expect(page.url()).toBe(deepLink);
            await page.screenshot({ path: path.join(artifactDir, "2-connected.png") });

            // Navigation is sufficient here; readiness is asserted by the connect
            // handshake and control-ui text below.
            trace("reload-before", "/");
            await page.reload({ waitUntil: "domcontentloaded" });
            trace("reload-after", "/");
            const reloadConnect = await gateway.waitForRequest("connect");
            expect(reloadConnect.params).toMatchObject({ auth: { deviceToken } });
            expect(reloadConnect.params).not.toHaveProperty("auth.bootstrapToken");
            await gateway.resolveDeferred("connect");
            await waitForControlUiGatewayReady(page);
            await page
              .getByText("Your browser is connected. This is synthetic proof data.", {
                exact: true,
              })
              .waitFor();
            expect(helperCalls).toBe(1);
            expect(page.url()).toBe(deepLink);
            await page.screenshot({ path: path.join(artifactDir, "3-reloaded.png") });
          },
          () => {
            trace("cleanup-before-release", "none");
            releaseHandoff();
            trace("cleanup-after-release", "none");
          },
          // Drain active interception handlers before withPage closes the context.
          async () => {
            trace("cleanup-before-unroute", `active=${[...activeBroadRequests].join(",") || "none"}`);
            await page.unrouteAll({ behavior: "wait" });
            trace("cleanup-after-unroute", "none");
          },
        );
        return page.video();
      },
    );
    await video?.saveAs(path.join(artifactDir, "browser-bootstrap.webm"));
  });
});
