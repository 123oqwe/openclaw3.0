import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state";

export type OutcomeRecord = {
  id: string;
  revision: number;
  [key: string]: unknown;
};

export type OutcomeRepository = {
  create(record: OutcomeRecord): Promise<{ created: boolean }>;
  get(id: string): Promise<OutcomeRecord | undefined>;
};

export function createOutcomeRepository(
  store: Pick<PluginStateKeyedStore<OutcomeRecord>, "registerIfAbsent" | "lookup">,
): OutcomeRepository {
  return {
    create: async (record) => ({
      created: await store.registerIfAbsent(record.id, record),
    }),
    get: (id) => store.lookup(id),
  };
}
