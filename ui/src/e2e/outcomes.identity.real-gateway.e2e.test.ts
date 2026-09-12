// Real same-page trusted-proxy identity-switch proof for the Outcome Center.
// The proxy is a test-only transport: it injects the configured upstream
// identity, then closes the browser transport so the Control UI must perform
// its normal reconnect/hello lifecycle under the next identity.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { HelloOk } from "../../../packages/gateway-protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/index.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const aliceIdentity = "alice@outcomes.example.invalid";
const bobIdentity = "bob@outcomes.example.invalid";
const operatorScopes = ["operator.read", "operator.write"];
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

type JsonRecord = Record<string, unknown>;
type ProxyPrincipal = typeof aliceIdentity | typeof bobIdentity;
type ProxyRoute = "browser" | "probe";

type ProxyConnectionEvidence = {
  helloSelfUserId: string | null;
  principal: ProxyPrincipal;
  route: ProxyRoute;
};

type ProxiedGatewayResponse = {
  error?: JsonRecord;
  hello: HelloOk;
  ok: boolean;
  payload?: JsonRecord;
  selfUserId: string | null;
};

type TransportPair = {
  browser: WebSocket;
  route: ProxyRoute;
  upstream: WebSocket;
};

type IdentityProxy = {
  browserUrl: string;
  close: () => Promise<void>;
  connections: readonly ProxyConnectionEvidence[];
  disconnectBrowserConnections: () => void;
  probeUrl: (principal: ProxyPrincipal) => string;
  setBrowserPrincipal: (principal: ProxyPrincipal) => void;
};

const realGatewayPluginEnv = {
  ANTHROPIC_API_KEY: undefined,
  CODEX_HOME: undefined,
  NODE_ENV: undefined,
  OPENAI_API_KEY: undefined,
  OPENCLAW_BUILD_PRIVATE_QA: "1",
  OPENCLAW_GATEWAY_PASSWORD: undefined,
  OPENCLAW_GATEWAY_TOKEN: undefined,
  OPENCLAW_SKIP_CHANNELS: undefined,
  OPENCLAW_SKIP_PROVIDERS: undefined,
  OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
  VITEST: undefined,
  VITEST_POOL_ID: undefined,
  VITEST_WORKER_ID: undefined,
} as const;

let instance: OpenClawTestInstance | undefined;
let proxy: IdentityProxy | undefined;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseFrame(data: RawData): JsonRecord | undefined {
  try {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString("utf8")
        : data.toString("utf8");
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function helloSelfUserId(payload: JsonRecord, instanceId: string | null): string | null {
  const snapshot = asRecord(payload.snapshot);
  const presence = Array.isArray(snapshot?.presence) ? snapshot.presence : [];
  for (const entry of presence) {
    const candidate = asRecord(entry);
    if (candidate?.instanceId !== instanceId || candidate.reason === "disconnect") {
      continue;
    }
    const user = asRecord(candidate.user);
    const id = stringValue(user?.id);
    if (id) {
      return id;
    }
  }
  return null;
}

function startProxyConnection(
  request: IncomingMessage,
  browser: WebSocket,
  gatewayUrl: string,
  principal: ProxyPrincipal,
  route: ProxyRoute,
  evidence: ProxyConnectionEvidence[],
  pairs: Set<TransportPair>,
): void {
  const upstream = new WebSocket(gatewayUrl, {
    headers: {
      "x-forwarded-for": "192.0.2.10",
      "x-forwarded-proto": "http",
      "x-forwarded-user": principal,
    },
    origin: request.headers.origin,
  });
  const pair = { browser, route, upstream };
  pairs.add(pair);
  const pendingBrowserFrames: Array<{ data: RawData; isBinary: boolean }> = [];
  let connectRequestId: string | null = null;
  let browserInstanceId: string | null = null;

  browser.on("message", (data, isBinary) => {
    const frame = parseFrame(data);
    if (frame?.type === "req" && frame.method === "connect") {
      connectRequestId = stringValue(frame.id);
      const params = asRecord(frame.params);
      browserInstanceId = stringValue(asRecord(params?.client)?.instanceId);
    }
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    } else {
      pendingBrowserFrames.push({ data, isBinary });
    }
  });
  upstream.on("open", () => {
    for (const frame of pendingBrowserFrames.splice(0)) {
      upstream.send(frame.data, { binary: frame.isBinary });
    }
  });
  upstream.on("message", (data, isBinary) => {
    const frame = parseFrame(data);
    if (
      frame?.type === "res" &&
      frame.id === connectRequestId &&
      frame.ok === true &&
      asRecord(frame.payload)?.type === "hello-ok"
    ) {
      evidence.push({
        helloSelfUserId: helloSelfUserId(asRecord(frame.payload)!, browserInstanceId),
        principal,
        route,
      });
    }
    if (browser.readyState === WebSocket.OPEN) {
      browser.send(data, { binary: isBinary });
    }
  });
  const closePair = () => {
    pairs.delete(pair);
    if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) {
      browser.close();
    }
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  };
  upstream.on("close", closePair);
  upstream.on("error", closePair);
  browser.on("close", closePair);
  browser.on("error", closePair);
}

async function startIdentityProxy(gatewayUrl: string): Promise<IdentityProxy> {
  let browserPrincipal: ProxyPrincipal = aliceIdentity;
  const connections: ProxyConnectionEvidence[] = [];
  const pairs = new Set<TransportPair>();
  const websocketServer = new WebSocketServer({ noServer: true });
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = url.pathname === "/browser" ? "browser" : url.pathname === "/probe" ? "probe" : null;
    const principal =
      route === "browser"
        ? browserPrincipal
        : url.searchParams.get("principal") === bobIdentity
          ? bobIdentity
          : url.searchParams.get("principal") === aliceIdentity
            ? aliceIdentity
            : null;
    if (!route || !principal) {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (browser) => {
      startProxyConnection(request, browser, gatewayUrl, principal, route, connections, pairs);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Outcome identity proxy did not bind a TCP port");
  }
  const baseUrl = `ws://localhost:${address.port}`;
  return {
    browserUrl: `${baseUrl}/browser`,
    close: async () => {
      for (const pair of pairs) {
        pair.browser.terminate();
        pair.upstream.terminate();
      }
      pairs.clear();
      await new Promise<void>((resolve, reject) => {
        websocketServer.close(() => server.close((error) => (error ? reject(error) : resolve())));
      });
    },
    connections,
    disconnectBrowserConnections: () => {
      for (const pair of pairs) {
        if (pair.route === "browser") {
          pair.browser.terminate();
          pair.upstream.terminate();
        }
      }
    },
    probeUrl: (principal) => `${baseUrl}/probe?principal=${encodeURIComponent(principal)}`,
    setBrowserPrincipal: (principal) => {
      browserPrincipal = principal;
    },
  };
}

async function proxyGatewayCall(
  proxyUrl: string,
  method: string,
  params: JsonRecord,
): Promise<ProxiedGatewayResponse> {
  const socket = new WebSocket(proxyUrl);
  const probeInstanceId = `outcome-identity-probe-${randomUUID()}`;
  return await new Promise<ProxiedGatewayResponse>((resolve, reject) => {
    let hello: HelloOk | undefined;
    let settled = false;
    const finish = (outcome: { value: ProxiedGatewayResponse } | { error: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if ("error" in outcome) {
        reject(outcome.error);
      } else {
        resolve(outcome.value);
      }
    };
    const requestId = randomUUID();
    const connectId = randomUUID();
    const timer = setTimeout(
      () => finish({ error: new Error(`${method} through trusted proxy timed out`) }),
      30_000,
    );
    socket.on("message", (data) => {
      const frame = parseFrame(data);
      if (!frame) {
        return;
      }
      if (frame.event === "connect.challenge") {
        socket.send(
          JSON.stringify({
            type: "req",
            id: connectId,
            method: "connect",
            params: {
              client: {
                id: "openclaw-control-ui",
                instanceId: probeInstanceId,
                mode: "webchat",
                platform: "test",
                version: "dev",
              },
              maxProtocol: PROTOCOL_VERSION,
              minProtocol: PROTOCOL_VERSION,
              role: "operator",
              scopes: operatorScopes,
            },
          }),
        );
        return;
      }
      if (frame.type !== "res") {
        return;
      }
      if (frame.id === connectId) {
        if (frame.ok !== true || !asRecord(frame.payload)) {
          finish({ error: new Error("trusted-proxy probe was not admitted") });
          return;
        }
        hello = frame.payload as unknown as HelloOk;
        socket.send(JSON.stringify({ type: "req", id: requestId, method, params }));
        return;
      }
      if (frame.id === requestId && hello) {
        finish({
          value: {
            ...(asRecord(frame.error) ? { error: asRecord(frame.error) } : {}),
            hello,
            ok: frame.ok === true,
            ...(asRecord(frame.payload) ? { payload: asRecord(frame.payload) } : {}),
            selfUserId: helloSelfUserId(hello as unknown as JsonRecord, probeInstanceId),
          },
        });
      }
    });
    socket.once("error", (error) => finish({ error }));
    socket.once("close", () => {
      if (!settled) {
        finish({ error: new Error("trusted-proxy probe closed before response") });
      }
    });
  });
}

function requireObject(payload: JsonRecord | undefined, field: string): JsonRecord {
  const value = asRecord(payload?.[field]);
  if (!value) {
    throw new Error(`Gateway response omitted ${field}`);
  }
  return value;
}

function requireString(payload: JsonRecord | undefined, field: string): string {
  const value = stringValue(payload?.[field]);
  if (!value) {
    throw new Error(`Gateway response omitted ${field}`);
  }
  return value;
}

async function connectPageToIdentityGateway(baseUrl: string) {
  if (!proxy) {
    throw new Error("Outcome identity proxy was not started");
  }
  const connection = new URL("settings/connection", baseUrl);
  connection.searchParams.set("gatewayUrl", proxy.browserUrl);
  return connection.toString();
}

const identitySuite = createControlUiE2eSuite({
  name: "Control UI Outcomes trusted-proxy identity switch",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-outcomes-identity-switch",
      startTimeoutMs: 120_000,
      env: realGatewayPluginEnv,
      config: {
        gateway: {
          auth: {
            identityScopes: {
              [aliceIdentity]: operatorScopes,
              [bobIdentity]: operatorScopes,
            },
            mode: "trusted-proxy",
            trustedProxy: {
              allowLoopback: true,
              allowUsers: [aliceIdentity, bobIdentity],
              deviceAutoApprove: {
                enabled: true,
                scopes: operatorScopes,
              },
              requiredHeaders: ["x-forwarded-proto"],
              userHeader: "x-forwarded-user",
            },
          },
          controlUi: { enabled: true },
          trustedProxies: ["127.0.0.1", "::1"],
        },
        plugins: {
          allow: ["outcomes", "workboard"],
          enabled: true,
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
      proxy = await startIdentityProxy(owner.url);
      return {
        baseUrl: `http://127.0.0.1:${owner.port}/`,
        close: async () => {
          await runQaGatewayFixture(
            async () => {
              await proxy?.close();
            },
            () => owner.cleanup(),
          );
          proxy = undefined;
          instance = undefined;
        },
      };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          await proxy?.close();
        },
        () => owner.cleanup(),
      );
      proxy = undefined;
      instance = undefined;
      throw error;
    }
  },
});

identitySuite.define(() => {
  it("clears A data on real same-page trusted-proxy reauthentication and restores it only for A", async () => {
    if (!instance || !proxy) {
      throw new Error("Outcome identity-switch fixture was not started");
    }
    const owner = instance;
    const identityProxy = proxy;
    const aliceCard = await proxyGatewayCall(identityProxy.probeUrl(aliceIdentity), "workboard.cards.create", {
      priority: "normal",
      title: "Identity-isolated Outcome card",
    });
    expect(aliceCard.ok).toBe(true);
    const cardId = requireString(requireObject(aliceCard.payload, "card"), "id");
    const aliceSelf = await proxyGatewayCall(identityProxy.probeUrl(aliceIdentity), "users.self", {});
    expect(aliceSelf.ok).toBe(true);
    const aliceProfileId = requireString(requireObject(aliceSelf.payload, "profile"), "id");
    const bobSelf = await proxyGatewayCall(identityProxy.probeUrl(bobIdentity), "users.self", {});
    expect(bobSelf.ok).toBe(true);
    const bobProfileId = requireString(requireObject(bobSelf.payload, "profile"), "id");
    expect(aliceSelf.selfUserId).toBe(aliceProfileId);
    expect(bobSelf.selfUserId).toBe(bobProfileId);
    expect(aliceProfileId).not.toBe(bobProfileId);

    await identitySuite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        await page.goto(await connectPageToIdentityGateway(`http://127.0.0.1:${owner.port}/`));
        const confirmation = page.locator("openclaw-gateway-url-confirmation");
        await confirmation.waitFor();
        await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
        await waitForControlUiGatewayReady(page);
        await page.goto(new URL("outcomes", `http://127.0.0.1:${owner.port}/`).toString());
        await waitForControlUiGatewayReady(page);
        await page.locator('[data-outcome-action="create"]').click();
        const form = page.locator("[data-outcome-create-form]");
        await form.locator('input[name="title"]').fill("Alice private Outcome");
        await form.locator('textarea[name="objective"]').fill("Must not leak after B reauth");
        await form.locator('input[name="criterion"]').fill("Alice card proof remains private");
        await form.locator("[data-outcome-confirm-create]").click();
        const summary = page.locator(".outcome-summary", { hasText: "Alice private Outcome" });
        await summary.waitFor({ state: "visible" });
        await summary.locator("[data-outcome-select]").click();
        const detail = page.locator("[data-outcome-detail-id]");
        await detail.waitFor({ state: "visible" });
        const outcomeId = await detail.getAttribute("data-outcome-detail-id");
        if (!outcomeId) {
          throw new Error("Alice Outcome detail omitted its ID");
        }
        await detail.locator('[data-outcome-action="link-work"]').click();
        const linkForm = page.locator("[data-outcome-link-form]");
        const card = linkForm.locator('select[name="card"]');
        await card.focus();
        await page.keyboard.press("ArrowDown");
        await expect.poll(() => card.inputValue()).toBe(cardId);
        await linkForm.locator("[data-outcome-confirm-link]").click();
        await detail.locator(`[data-outcome-work-card="${cardId}"]`).waitFor({ state: "visible" });
        await detail.locator('[data-outcome-action="activate"]').click();
        await detail.locator('[data-outcome-phase="active"]').waitFor({ state: "visible" });
        const proof = await proxyGatewayCall(identityProxy.probeUrl(aliceIdentity), "workboard.cards.proof", {
          id: cardId,
          label: "Alice identity proof",
          status: "passed",
        });
        expect(proof.ok).toBe(true);
        await detail.locator('[data-outcome-action="refresh"]').click();
        await detail.getByText("Proof: Alice identity proof", { exact: true }).waitFor({ state: "visible" });
        if (captureUiProofEnabled) {
          await page.screenshot({
            fullPage: true,
            path: `${identitySuite.artifactDir}/outcomes-identity-alice.png`,
          });
        }

        identityProxy.setBrowserPrincipal(bobIdentity);
        identityProxy.disconnectBrowserConnections();
        await expect
          .poll(() =>
            identityProxy.connections.some(
              (connection) =>
                connection.route === "browser" &&
                connection.principal === bobIdentity &&
                connection.helloSelfUserId === bobProfileId,
            ),
          )
          .toBe(true);
        await waitForControlUiGatewayReady(page);
        await expect.poll(() => page.locator(".outcome-summary").count()).toBe(0);
        await expect.poll(() => detail.count()).toBe(0);
        await expect.poll(() => page.getByText("Alice private Outcome", { exact: true }).count()).toBe(0);
        await expect
          .poll(() => page.getByText("Must not leak after B reauth", { exact: true }).count())
          .toBe(0);
        await expect.poll(() => page.locator(`[data-outcome-work-card="${cardId}"]`).count()).toBe(0);
        await expect.poll(() => page.getByText("Proof: Alice identity proof", { exact: true }).count()).toBe(0);
        if (captureUiProofEnabled) {
          await page.screenshot({
            fullPage: true,
            path: `${identitySuite.artifactDir}/outcomes-identity-bob.png`,
          });
        }

        const bobGet = await proxyGatewayCall(identityProxy.probeUrl(bobIdentity), "outcomes.get", {
          id: outcomeId,
        });
        expect(bobGet.selfUserId).toBe(bobProfileId);
        expect(bobGet.ok).toBe(false);
        expect(stringValue(bobGet.error?.code)).toBe("OUTCOME_NOT_FOUND");

        identityProxy.setBrowserPrincipal(aliceIdentity);
        identityProxy.disconnectBrowserConnections();
        await expect
          .poll(() =>
            identityProxy.connections.some(
              (connection) =>
                connection.route === "browser" &&
                connection.principal === aliceIdentity &&
                connection.helloSelfUserId === aliceProfileId,
            ),
          )
          .toBe(true);
        await waitForControlUiGatewayReady(page);
        await page.locator(".outcome-summary", { hasText: "Alice private Outcome" }).waitFor({
          state: "visible",
        });
        await page.locator(".outcome-summary", { hasText: "Alice private Outcome" }).locator("[data-outcome-select]").click();
        await page.locator(`[data-outcome-detail-id="${outcomeId}"]`).waitFor({ state: "visible" });
        await page.locator(`[data-outcome-work-card="${cardId}"]`).waitFor({ state: "visible" });
        await page.getByText("Proof: Alice identity proof", { exact: true }).waitFor({ state: "visible" });
      },
    );
  });
});
