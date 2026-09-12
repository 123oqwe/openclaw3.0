import { Value } from "typebox/value";
import type { OpenClawPluginApi } from "../../api.js";
import type { OutcomeHealthResult } from "@openclaw/outcomes-contract";
import { fail } from "./method-helpers.js";
import { outcomeHealthParamsSchema } from "./schemas.js";

const CAPABILITY_STORE_OPTIONS = {
  namespace: "outcomes-capability-v1",
  maxEntries: 2,
  overflowPolicy: "reject-new" as const,
};

/** Registers only the independent capability probe. */
export function registerOutcomeHealthMethod(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    "outcomes.health",
    async ({ params, respond }) => {
      if (!Value.Check(outcomeHealthParamsSchema, params)) {
        return fail(respond, "INVALID_REQUEST");
      }
      let store: ReturnType<typeof api.runtime.state.openKeyedStore> | undefined;
      try {
        store = api.runtime.state.openKeyedStore(CAPABILITY_STORE_OPTIONS);
      } catch {
        store = undefined;
      }

      const requestScoped = await api.runtime.gateway.isAvailable().catch(() => false);
      let workboardAvailable = false;
      if (requestScoped) {
        try {
          await api.runtime.gateway.request(
            "workboard.cards.list",
            {},
            {
              scopes: ["operator.read"],
              requireAuthenticatedRequest: true,
            },
          );
          workboardAvailable = true;
        } catch {
          workboardAvailable = false;
        }
      }

      const result: OutcomeHealthResult = {
        plugin: "outcomes",
        schemaVersion: 1,
        state: {
          available: Boolean(store),
          atomicUpdate: typeof store?.update === "function",
          atomicDelete: typeof store?.deleteIf === "function",
        },
        gateway: {
          available: requestScoped,
          requestScoped,
        },
        workboard: { available: workboardAvailable },
      };
      respond(true, result);
    },
    { scope: "operator.read" },
  );
}
