import { describe, expect, it } from "vitest";
import {
  createSkillLibraryWireInstance,
  SKILL_LIBRARY_BOB,
  SkillLibraryWireClient,
} from "./skill-library-wire-fixture.js";

describe("Outcome health with the real Workboard plugin", () => {
  it.each([true, false])("reports Workboard availability=%s", async (enabled) => {
    const instance = await createSkillLibraryWireInstance();
    const connected = await (async () => {
      await instance.state.writeConfig({
        gateway: {
          mode: "local",
          bind: "loopback",
          port: instance.port,
          trustedProxies: ["127.0.0.1", "::1"],
          auth: {
            mode: "trusted-proxy",
            password: instance.gatewayToken,
            identityScopes: { [SKILL_LIBRARY_BOB]: ["operator.read", "operator.write"] },
            trustedProxy: {
              userHeader: "x-forwarded-user",
              allowLoopback: true,
              requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
              allowUsers: [SKILL_LIBRARY_BOB],
            },
          },
          controlUi: { enabled: false },
        },
        agents: { defaults: { workspace: instance.state.workspaceDir } },
        plugins: {
          enabled: true,
          allow: ["outcomes", "workboard"],
          entries: { outcomes: { enabled: true }, workboard: { enabled } },
        },
      });
      await instance.startGateway();
      return await SkillLibraryWireClient.connect(instance, {
        email: SKILL_LIBRARY_BOB,
        scopes: ["operator.read"],
      });
    })();
    const client = connected.client;
    try {
      expect(connected.hello.auth?.scopes).toContain("operator.read");
      const health = await client.request<{ workboard?: { available?: boolean } }>(
        "outcomes.health",
        {},
      );
      expect(health.workboard?.available).toBe(enabled);
    } finally {
      await client.close();
      await instance.cleanup();
    }
  });
});
