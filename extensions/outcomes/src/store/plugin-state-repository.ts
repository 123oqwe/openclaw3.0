import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { OutcomeRecord, OutcomeRepository } from "./outcome-repository.js";
import { assertOutcomeRecordSize } from "../domain/schema.js";

export function createOutcomeRepository(
  store: Pick<
    PluginStateKeyedStore<OutcomeRecord>,
    "registerIfAbsent" | "lookup" | "entries" | "update" | "deleteIf"
  >,
): OutcomeRepository {
  const requireManager = (managerProfileId: string) => {
    if (!managerProfileId.trim()) {
      throw new Error("managerProfileId must be non-empty");
    }
  };
  if (typeof store.update !== "function") {
    throw new Error("Outcome repository requires atomic keyed-store update");
  }
  return {
    create: async (record) => {
      assertOutcomeRecordSize(record);
      return { created: await store.registerIfAbsent(record.id, record) };
    },
    createOwned: async (managerProfileId, record) => {
      requireManager(managerProfileId);
      if (record.managerProfileId !== managerProfileId) {
        throw new Error("Outcome manager profile does not match authenticated owner");
      }
      assertOutcomeRecordSize(record);
      const created = await store.registerIfAbsent(record.id, record);
      if (created) {
        return { created: true, replayed: false, record };
      }
      const existing = await store.lookup(record.id);
      if (!existing || existing.managerProfileId !== managerProfileId) {
        throw new Error("Outcome is not owned by the requested manager");
      }
      if (existing.createRequestHash !== record.createRequestHash) {
        throw new Error("Outcome create request conflicts with existing record");
      }
      return { created: false, replayed: true, record: existing };
    },
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
        if (decision.next) {
          assertOutcomeRecordSize(decision.next);
        }
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
    getOwned: async (managerProfileId, id) => {
      requireManager(managerProfileId);
      const record = await store.lookup(id);
      return record?.managerProfileId === managerProfileId ? record : undefined;
    },
    listOwned: async (managerProfileId) => {
      requireManager(managerProfileId);
      return (await store.entries())
        .map((entry) => entry.value)
        .filter((record) => record.managerProfileId === managerProfileId);
    },
    transactOwned: async <T>(
      managerProfileId: string,
      id: string,
      decide: (current: OutcomeRecord) => { result: T; next?: OutcomeRecord },
    ) => {
      requireManager(managerProfileId);
      let result!: T;
      await store.update!(id, (current) => {
        if (!current || current.managerProfileId !== managerProfileId) {
          throw new Error("Outcome is not owned by the requested manager");
        }
        const decision = decide(current);
        result = decision.result;
        if (decision.next) {
          assertOutcomeRecordSize(decision.next);
        }
        return decision.next;
      });
      return result;
    },
    deleteOwnedIf: async (managerProfileId, id, predicate) => {
      requireManager(managerProfileId);
      if (typeof store.deleteIf !== "function") {
        throw new Error("Outcome repository requires atomic keyed-store deleteIf");
      }
      return store.deleteIf(
        id,
        (current) => current.managerProfileId === managerProfileId && predicate(current),
      );
    },
  };
}
