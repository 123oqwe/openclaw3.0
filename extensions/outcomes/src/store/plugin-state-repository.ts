import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { OutcomeRecord, OutcomeRepository } from "./outcome-repository.js";

export function createOutcomeRepository(
  store: Pick<
    PluginStateKeyedStore<OutcomeRecord>,
    "registerIfAbsent" | "lookup" | "entries" | "update" | "deleteIf"
  >,
): OutcomeRepository {
  if (typeof store.update !== "function") {
    throw new Error("Outcome repository requires atomic keyed-store update");
  }
  return {
    create: async (record) => ({ created: await store.registerIfAbsent(record.id, record) }),
    get: (id) => store.lookup(id),
    list: async () => (await store.entries()).map((entry) => entry.value),
    transact: async <T>(
      id: string,
      decide: (current: OutcomeRecord | undefined) => { result: T; next?: OutcomeRecord },
    ) => {
      let result!: T;
      await store.update!(id, (current) => {
        const decision = decide(current);
        result = decision.result;
        return decision.next;
      });
      return result;
    },
    deleteIf: async (id, predicate) => {
      if (typeof store.deleteIf !== "function") {
        throw new Error("Outcome repository requires atomic keyed-store deleteIf");
      }
      return store.deleteIf(id, predicate);
    },
  };
}
