import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { assertOutcomeRecordSize, parseOutcomeRecord } from "../domain/schema.js";
import type { OutcomeRecord, OutcomeRepository } from "./outcome-repository.js";

export class OutcomeRepositoryCapacityError extends Error {
  readonly code = "outcome-capacity-exceeded" as const;

  constructor() {
    super("Outcome repository capacity exceeded");
    this.name = "OutcomeRepositoryCapacityError";
  }
}

export class OutcomeRepositoryConflictError extends Error {
  readonly code = "outcome-create-conflict" as const;

  constructor() {
    super("Outcome create request conflicts with existing record");
    this.name = "OutcomeRepositoryConflictError";
  }
}

function createLegacyOutcomeRepository(
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
      if (!existing) {
        throw new Error("Outcome is not owned by the requested manager");
      }
      if (existing.managerProfileId !== managerProfileId) {
        throw new Error("Outcome is not owned by the requested manager");
      }
      if (existing.createRequestHash !== record.createRequestHash) {
        throw new OutcomeRepositoryConflictError();
      }
      return { created: false, replayed: true, record: existing };
    },
    get: (id) => store.lookup(id),
    list: async () =>
      (await store.entries())
        .map((entry) => entry.value)
        .toSorted((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
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
        .filter((record) => record.managerProfileId === managerProfileId)
        .toSorted((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
function createStrictOutcomeRepository(
  store: Pick<
    PluginStateKeyedStore<OutcomeRecord>,
    "registerIfAbsent" | "lookup" | "entries" | "update" | "deleteIf"
  >,
): OutcomeRepository {
  if (typeof store.deleteIf !== "function") {
    throw new Error("Outcome repository requires atomic keyed-store deleteIf");
  }
  const deleteIf = store.deleteIf;
  const base = createLegacyOutcomeRepository(store);
  const strict = (value: OutcomeRecord | undefined) =>
    value === undefined ? undefined : parseOutcomeRecord(value);
  return {
    ...base,
    create: async (record) => {
      try {
        return await base.create(parseOutcomeRecord(record));
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "PLUGIN_STATE_LIMIT_EXCEEDED"
        ) {
          throw new OutcomeRepositoryCapacityError();
        }
        throw error;
      }
    },
    createOwned: async (owner, record) => {
      if (!owner.trim() || record.managerProfileId !== owner) {
        throw new Error("Outcome manager profile does not match authenticated owner");
      }
      const parsed = parseOutcomeRecord(record);
      let created: boolean;
      try {
        created = await store.registerIfAbsent(parsed.id, parsed);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "PLUGIN_STATE_LIMIT_EXCEEDED"
        ) {
          throw new OutcomeRepositoryCapacityError();
        }
        throw error;
      }
      if (created) {
        return { created: true, replayed: false, record: parsed };
      }
      const rawExisting = await store.lookup(parsed.id);
      if (!rawExisting) {
        throw new Error("Outcome create lost its registration race");
      }
      const existing = parseOutcomeRecord(rawExisting);
      if (existing.managerProfileId !== owner) {
        throw new Error("Outcome is not owned by the requested manager");
      }
      if (existing.createRequestHash !== parsed.createRequestHash) {
        throw new OutcomeRepositoryConflictError();
      }
      return { created: false, replayed: true, record: existing };
    },
    get: async (id) => strict(await base.get(id)),
    list: async () => (await base.list()).map(parseOutcomeRecord),
    getOwned: async (owner, id) => strict(await base.getOwned(owner, id)),
    listOwned: async (owner) => (await base.listOwned(owner)).map(parseOutcomeRecord),
    transact: async <T>(
      id: string,
      decide: (current: OutcomeRecord | undefined) => { result: T; next?: OutcomeRecord },
    ) =>
      base.transact(id, (current) => {
        const decision = decide(strict(current));
        return {
          result: decision.result,
          next: decision.next === undefined ? undefined : parseOutcomeRecord(decision.next),
        };
      }),
    transactOwned: async <T>(
      owner: string,
      id: string,
      decide: (current: OutcomeRecord) => { result: T; next?: OutcomeRecord },
    ) =>
      base.transactOwned(owner, id, (current) => {
        const decision = decide(parseOutcomeRecord(current));
        return {
          result: decision.result,
          next: decision.next === undefined ? undefined : parseOutcomeRecord(decision.next),
        };
      }),
    deleteIf: async (id, predicate) =>
      deleteIf(id, (current) => {
        const parsed = parseOutcomeRecord(current);
        return predicate(parsed);
      }),
    deleteOwnedIf: async (owner, id, predicate) =>
      deleteIf(id, (current) => {
        const parsed = parseOutcomeRecord(current);
        return parsed.managerProfileId === owner && predicate(parsed);
      }),
  };
}

/** Formal production repository entry point. */
export const createOutcomeRepository = createStrictOutcomeRepository;
