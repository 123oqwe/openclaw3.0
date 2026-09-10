import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { OutcomeRecord, OutcomeRepository } from "./outcome-repository.js";
import { assertOutcomeRecordSize, parseOutcomeRecord } from "../domain/schema.js";

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

/** Strict storage boundary for production records; rejects sparse or corrupt persisted values. */
export function createStrictOutcomeRepository(
  store: Pick<PluginStateKeyedStore<OutcomeRecord>, "registerIfAbsent" | "lookup" | "entries" | "update" | "deleteIf">,
): OutcomeRepository {
  const base = createOutcomeRepository(store);
  const strict = (value: OutcomeRecord | undefined) => (value === undefined ? undefined : parseOutcomeRecord(value));
  return {
    ...base,
    create: async (record) => base.create(parseOutcomeRecord(record)),
    createOwned: async (owner, record) => {
      const parsed = parseOutcomeRecord(record);
      const created = await store.registerIfAbsent(parsed.id, parsed);
      if (created) return { created: true, replayed: false, record: parsed };
      const existing = parseOutcomeRecord(await store.lookup(parsed.id));
      if (existing.managerProfileId !== owner) throw new Error("Outcome is not owned by the requested manager");
      if (existing.createRequestHash !== parsed.createRequestHash) throw new Error("Outcome create request conflicts with existing record");
      return { created: false, replayed: true, record: existing };
    },
    get: async (id) => strict(await base.get(id)),
    list: async () => (await base.list()).map(parseOutcomeRecord),
    getOwned: async (owner, id) => strict(await base.getOwned(owner, id)),
    listOwned: async (owner) => (await base.listOwned(owner)).map(parseOutcomeRecord),
    transact: async <T>(id: string, decide: (current: OutcomeRecord | undefined) => { result: T; next?: OutcomeRecord }) => base.transact(id, (current) => {
      const decision = decide(strict(current));
      return { result: decision.result, next: decision.next === undefined ? undefined : parseOutcomeRecord(decision.next) };
    }),
    transactOwned: async <T>(owner: string, id: string, decide: (current: OutcomeRecord) => { result: T; next?: OutcomeRecord }) => base.transactOwned(owner, id, (current) => {
      const decision = decide(parseOutcomeRecord(current));
      return { result: decision.result, next: decision.next === undefined ? undefined : parseOutcomeRecord(decision.next) };
    }),
    deleteIf: async (id, predicate) => store.deleteIf(id, (current) => {
      const parsed = parseOutcomeRecord(current);
      return predicate(parsed);
    }),
    deleteOwnedIf: async (owner, id, predicate) => store.deleteIf(id, (current) => {
      const parsed = parseOutcomeRecord(current);
      return parsed.managerProfileId === owner && predicate(parsed);
    }),
  };
}
