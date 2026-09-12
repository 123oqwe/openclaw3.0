import { readFileSync } from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { registerOutcomeGatewayMethods } from "../../runtime-api.js";
import type { OutcomeRecord } from "../domain/types.js";

type GatewayCall = {
  client: { authenticatedUserProfile?: { profileId: string } };
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
};
type RegisteredHandler = (call: GatewayCall) => Promise<void>;

const fixture = JSON.parse(
  readFileSync(new URL("../adapters/fixtures/workboard-list.v1.json", import.meta.url), "utf8"),
);
const outcomeId = "123e4567-e89b-42d3-a456-426614174020";
const criterionId = "123e4567-e89b-42d3-a456-426614174021";
const owner = { authenticatedUserProfile: { profileId: "manager-a" } };

function createBundledGatewayHarness() {
  const records = new Map<string, OutcomeRecord>();
  const handlers = new Map<string, RegisteredHandler>();
  const publicWorkboardRequest = vi.fn(async (method: string, params: unknown) => {
    if (method !== "workboard.cards.list" || params === null || typeof params !== "object") {
      throw new Error("unexpected public Gateway request");
    }
    return fixture;
  });
  const state = {
    registerIfAbsent: async (id: string, record: OutcomeRecord) => {
      if (records.has(id)) {
        return false;
      }
      records.set(id, record);
      return true;
    },
    lookup: async (id: string) => records.get(id),
    entries: async () => [...records].map(([key, value]) => ({ key, value, createdAt: 0 })),
    update: async (
      id: string,
      decide: (current: OutcomeRecord | undefined) => OutcomeRecord | undefined,
    ) => {
      const next = decide(records.get(id));
      if (next === undefined) {
        return false;
      }
      records.set(id, next);
      return true;
    },
    deleteIf: async () => false,
  };
  const api = createTestPluginApi({
    id: "outcomes",
    runtime: {
      state: { openKeyedStore: () => state },
      gateway: { request: publicWorkboardRequest },
    } as never,
    registerGatewayMethod(method, handler) {
      handlers.set(method, handler as RegisteredHandler);
    },
  });
  registerOutcomeGatewayMethods(api);
  async function call(method: string, params: Record<string, unknown>) {
    const respond = vi.fn();
    const handler = handlers.get(method);
    if (!handler) {
      throw new Error(`missing bundled handler: ${method}`);
    }
    await handler({ client: owner, params, respond });
    return respond.mock.calls[0];
  }
  return { call, publicWorkboardRequest, records };
}

describe("Outcome bundled Workboard Gateway integration", () => {
  it("reads the frozen public cards.list response through the registered runtime seam", async () => {
    const harness = createBundledGatewayHarness();
    await harness.call("outcomes.create", {
      id: outcomeId,
      title: "Publish fixture",
      objective: "Verify public Workboard integration",
      criteria: [{ id: criterionId, text: "Hosted proof is available", required: true }],
    });
    await harness.call("outcomes.linkWorkboard", {
      id: outcomeId,
      expectedRevision: 1,
      criterionId,
      cardId: "card-proof-artifact",
    });
    harness.publicWorkboardRequest.mockClear();

    expect(
      await harness.call("outcomes.refresh", { id: outcomeId, expectedRevision: 2 }),
    ).toMatchObject([
      true,
      {
        outcome: {
          work: [{ currentBoardId: "release-board", status: "done" }],
          evidence: [
            { sourceId: "proof-1", proofStatus: "passed", label: "Hosted test" },
            { sourceId: "artifact-1", label: "Hosted report", mimeType: "application/json" },
          ],
        },
        refresh: { status: "available" },
      },
    ]);
    expect(harness.publicWorkboardRequest).toHaveBeenCalledExactlyOnceWith(
      "workboard.cards.list",
      {},
      { scopes: ["operator.read"], requireAuthenticatedRequest: true, timeoutMs: 10_000 },
    );
    expect(harness.records.get(outcomeId)?.projections).toMatchObject([
      { availability: "available", currentBoardId: "release-board", status: "done" },
    ]);
  });
});
