import { afterEach, describe, expect, it } from "vitest";
import { createQaLiveLaneGateway } from "../qa-lab/runtime-api.js";
import { stopQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";

describe("Outcome health with the real Workboard plugin", () => {
  const owners: Array<ReturnType<typeof createQaLiveLaneGateway>> = [];

  afterEach(async () => {
    for (const owner of owners.splice(0)) {
      await stopQaGatewayFixture(owner);
    }
  });

  it.each([true, false])("reports Workboard availability=%s", async (enabled) => {
    const owner = createQaLiveLaneGateway();
    owners.push(owner);
    const harness = await owner.start({
      repoRoot: process.cwd(),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna",
      transport: {
        requiredPluginIds: ["outcomes", "workboard"],
        createGatewayConfig: () => ({}),
      },
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      mutateConfig: (config) => ({
        ...config,
        plugins: {
          ...config.plugins,
          allow: [...new Set([...(config.plugins?.allow ?? []), "outcomes", "workboard"])],
          entries: {
            ...config.plugins?.entries,
            outcomes: { enabled: true },
            workboard: { enabled },
          },
        },
      }),
    });

    const health = (await harness.gateway.call("outcomes.health", {}, {
      scopes: ["operator.read"],
    })) as { workboard?: { available?: boolean } };
    expect(health.workboard?.available).toBe(enabled);
  });
});
