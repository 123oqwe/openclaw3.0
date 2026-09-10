import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { OutcomeRecord, OutcomeRepository } from "./outcome-repository.js";


export function createOutcomeRepository(
  store: Pick<PluginStateKeyedStore<OutcomeRecord>, "registerIfAbsent" | "lookup" | "update">,
): OutcomeRepository {
  if (typeof store.update !== "function") {
    throw new Error("Outcome repository requires atomic keyed-store update");
  }
  return {
    create: async (record) => ({ created: await store.registerIfAbsent(record.id, record) }),
    get: (id) => store.lookup(id),
    transact: async <T>(id: string, decide: (current: OutcomeRecord | undefined) => { result: T; next?: OutcomeRecord }) => {
      let result!: T;
      await store.update!(id, (current) => {
        const decision = decide(current);
        result = decision.result;
        return decision.next;
      });
      return result;
    },
  };
}
