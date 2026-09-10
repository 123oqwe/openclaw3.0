import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { OutcomeRecord, OutcomeRepository } from "./outcome-repository.js";


export function createOutcomeRepository(
  store: Pick<PluginStateKeyedStore<OutcomeRecord>, "registerIfAbsent" | "lookup">,
): OutcomeRepository {
  return {
    create: async (record) => ({ created: await store.registerIfAbsent(record.id, record) }),
    get: (id) => store.lookup(id),
  };
}
