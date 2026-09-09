import type { OpenClawPluginApi } from "../../api.js";

const CAPABILITY_STORE_OPTIONS = {
  namespace: "outcomes-capability-v1",
  maxEntries: 2,
  overflowPolicy: "reject-new" as const,
};

export function registerOutcomeGatewayMethods(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    "outcomes.health",
    async ({ respond }) => {
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

      respond(true, {
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
      });
    },
    { scope: "operator.read" },
  );
}
