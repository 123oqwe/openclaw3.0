/**
 * Regression tests for plugin-registered gateway RPC dispatch (#94127).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { WRITE_SCOPE } from "./operator-scopes.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

describe("handleGatewayRequest plugin gateway dispatch", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("dispatches plugin methods registered after the startup method registry snapshot", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      respond(true, { ok: true, ts: 42 });
    });
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.gatewayHandlers["demo.ping"] = handler;
    activeRegistry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "demo",
        name: "demo.ping",
        handler,
        scope: WRITE_SCOPE,
      }),
    );
    setActivePluginRegistry(activeRegistry);

    const staleStartupRegistry = createGatewayMethodRegistry([]);
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "proof-94127",
        method: "demo.ping",
        params: { hello: "world" },
      },
      respond,
      client: {
        connId: "conn-proof",
        connect: {
          role: "operator",
          scopes: [WRITE_SCOPE],
          client: {
            id: "cli",
            version: "test",
            platform: "linux",
            mode: "cli",
          },
          minProtocol: 1,
          maxProtocol: 1,
        },
      },
      isWebchatConnect: () => false,
      context: {
        logGateway: { warn: vi.fn() },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      methodRegistry: staleStartupRegistry,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, ts: 42 });
  });

  it("dispatches a method owned by the caller-attached registry even when global state lacks it (#94343)", async () => {
    const attachedPluginRegistry = createEmptyPluginRegistry();
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      expect(requireActivePluginRegistry()).toBe(attachedPluginRegistry);
      respond(true, { ok: true, source: "attached" });
    });
    // Active plugin registry does NOT carry the method; only the caller-attached
    // snapshot owns it, so dispatch must prefer the attached registry.
    setActivePluginRegistry(createEmptyPluginRegistry());
    const attachedRegistry = createGatewayMethodRegistry(
      [
        createPluginGatewayMethodDescriptor({
          pluginId: "demo",
          name: "demo.attached",
          handler,
          scope: WRITE_SCOPE,
        }),
      ],
      attachedPluginRegistry,
    );
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: "proof-94343", method: "demo.attached", params: {} },
      respond,
      client: {
        connId: "conn-proof",
        connect: {
          role: "operator",
          scopes: [WRITE_SCOPE],
          client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      },
      isWebchatConnect: () => false,
      context: {
        logGateway: { warn: vi.fn() },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      methodRegistry: attachedRegistry,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, source: "attached" });
  });

  it("fails closed when neither the attached snapshot nor the live registry owns the method", async () => {
    const handler = vi.fn<GatewayRequestHandler>();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: "proof-unknown", method: "demo.does-not-exist", params: {} },
      respond,
      client: {
        connId: "conn-proof",
        connect: {
          role: "operator",
          scopes: [WRITE_SCOPE],
          client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      },
      isWebchatConnect: () => false,
      context: {
        logGateway: { warn: vi.fn() },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      methodRegistry: createGatewayMethodRegistry([]),
    });

    expect(handler).not.toHaveBeenCalled();
    const [ok] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(false);
  });

  it.each(["success", "failure"] as const)(
    "expires authenticated request authority after host request envelope %s",
    async (completion) => {
      type AuthenticatedRequestAuthority = {
        profileId: string;
        signal: AbortSignal;
        assertCurrent: () => void;
      };
      let authority: AuthenticatedRequestAuthority | undefined;
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
        authority = (
          getPluginRuntimeGatewayRequestScope() as
            | { authenticatedRequestAuthority?: AuthenticatedRequestAuthority }
            | undefined
        )?.authenticatedRequestAuthority;
        authority?.assertCurrent();
        if (completion === "failure") {
          throw new Error("handler failed after authority capture");
        }
        respond(true, { ok: true });
      });
      const activeRegistry = createEmptyPluginRegistry();
      activeRegistry.gatewayHandlers["demo.authenticated"] = handler;
      activeRegistry.gatewayMethodDescriptors.push(
        createPluginGatewayMethodDescriptor({
          pluginId: "demo",
          name: "demo.authenticated",
          handler,
          scope: WRITE_SCOPE,
        }),
      );
      setActivePluginRegistry(activeRegistry);
      const respond = vi.fn();

      const request = handleGatewayRequest({
        req: { type: "req", id: "proof-authenticated-lifetime", method: "demo.authenticated" },
        respond,
        client: {
          connId: "conn-authenticated-lifetime",
          authenticatedUserProfile: {
            profileId: "profile-outcomes-owner",
            displayName: "Outcome Owner",
            hasAvatar: false,
            updatedAt: 1,
          },
          connect: {
            role: "operator",
            scopes: [WRITE_SCOPE],
            client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
            minProtocol: 1,
            maxProtocol: 1,
          },
        },
        isWebchatConnect: () => false,
        context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
          typeof handleGatewayRequest
        >[0]["context"],
      });

      if (completion === "failure") {
        await expect(request).rejects.toThrow("handler failed after authority capture");
      } else {
        await expect(request).resolves.toBeUndefined();
      }

      expect(authority).toBeDefined();
      expect(authority?.profileId).toBe("profile-outcomes-owner");
      expect(authority?.signal.aborted).toBe(true);
      expect(() => authority?.assertCurrent()).toThrow("authenticated gateway request expired");
    },
  );

  it("composes host cancellation into authenticated request authority", async () => {
    type AuthenticatedRequestAuthority = {
      signal: AbortSignal;
      assertCurrent: () => void;
    };
    const hostLifetime = new AbortController();
    let authority: AuthenticatedRequestAuthority | undefined;
    let observedAborted = false;
    let observedCurrentError: unknown;
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      authority = (
        getPluginRuntimeGatewayRequestScope() as
          | { authenticatedRequestAuthority?: AuthenticatedRequestAuthority }
          | undefined
      )?.authenticatedRequestAuthority;
      hostLifetime.abort(new Error("host request cancelled"));
      observedAborted = authority?.signal.aborted === true;
      try {
        authority?.assertCurrent();
      } catch (error) {
        observedCurrentError = error;
      }
      respond(true, { ok: true });
    });
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.gatewayHandlers["demo.cancelled"] = handler;
    activeRegistry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "demo",
        name: "demo.cancelled",
        handler,
        scope: WRITE_SCOPE,
      }),
    );
    setActivePluginRegistry(activeRegistry);

    const outcome = await handleGatewayRequest({
      req: { type: "req", id: "proof-authenticated-cancellation", method: "demo.cancelled" },
      respond: vi.fn(),
      client: {
        connId: "conn-authenticated-cancellation",
        authenticatedUserProfile: {
          profileId: "profile-outcomes-owner",
          displayName: "Outcome Owner",
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: {
          role: "operator",
          scopes: [WRITE_SCOPE],
          client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      },
      isWebchatConnect: () => false,
      context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
        typeof handleGatewayRequest
      >[0]["context"],
      signal: hostLifetime.signal,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(observedAborted).toBe(true);
    expect(observedCurrentError).toMatchObject({ message: "host request cancelled" });
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({ message: "host request cancelled" });
    }
  });

  it("does not mint authenticated request authority for a profile-bearing synthetic client", async () => {
    let observedAuthority: unknown;
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      observedAuthority = getPluginRuntimeGatewayRequestScope()?.authenticatedRequestAuthority;
      respond(true, { ok: true });
    });
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.gatewayHandlers["demo.synthetic"] = handler;
    activeRegistry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "demo",
        name: "demo.synthetic",
        handler,
        scope: WRITE_SCOPE,
      }),
    );
    setActivePluginRegistry(activeRegistry);

    await handleGatewayRequest({
      req: { type: "req", id: "proof-synthetic-no-mint", method: "demo.synthetic" },
      respond: vi.fn(),
      client: {
        connId: "conn-synthetic-no-mint",
        authenticatedUserProfile: {
          profileId: "synthetic-profile",
          displayName: "Synthetic Profile",
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: {
          role: "operator",
          scopes: [WRITE_SCOPE],
          client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
          minProtocol: 1,
          maxProtocol: 1,
        },
        internal: { syntheticClient: true },
      },
      isWebchatConnect: () => false,
      context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
        typeof handleGatewayRequest
      >[0]["context"],
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(observedAuthority).toBeUndefined();
  });
});
