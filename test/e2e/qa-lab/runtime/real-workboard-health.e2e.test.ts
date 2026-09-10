import { describe, expect, it } from "vitest";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  createSkillLibraryWireInstance,
  SKILL_LIBRARY_BOB,
  SkillLibraryWireClient,
} from "./skill-library-wire-fixture.js";

describe("Outcome health with the real Workboard plugin", () => {
  it.each([true, false])("reports Workboard availability=%s", async (enabled) => {
    const instance = await createSkillLibraryWireInstance();
    const clients: SkillLibraryWireClient[] = [];
    await runQaGatewayFixture(
      async () => {
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
            controlUi: {
              enabled: false,
              allowedOrigins: [`http://127.0.0.1:${instance.port}`],
            },
          },
          agents: { defaults: { workspace: instance.state.workspaceDir } },
          plugins: {
            enabled: true,
            allow: ["outcomes", "workboard"],
            entries: { outcomes: { enabled: true }, workboard: { enabled } },
          },
        });
        await instance.startGateway();
        const bootstrap = await SkillLibraryWireClient.connect(instance);
        clients.push(bootstrap.client);
        const connected = await SkillLibraryWireClient.connect(instance, {
          email: SKILL_LIBRARY_BOB,
          scopes: ["operator.read"],
          buildId: bootstrap.hello.server.buildId,
        });
        clients.push(connected.client);
        const client = connected.client;
        expect(connected.hello.auth?.scopes).toEqual(["operator.read"]);
        const self = await client.request<{ profile: { id: string } }>("users.self", {});
        expect(self.profile.id).toEqual(expect.any(String));
        const health = await client.request<{
          gateway?: { available?: boolean; requestScoped?: boolean };
          workboard?: { available?: boolean };
        }>("outcomes.health", {});
        expect(health.gateway?.available).toBe(true);
        expect(health.gateway?.requestScoped).toBe(true);
        expect(health.workboard?.available).toBe(enabled);
      },
      async () => {
        for (const client of clients) {
          await client.close();
        }
      },
      () => instance.cleanup(),
    );
  });
});
