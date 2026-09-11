import { performance } from "node:perf_hooks";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  OUTCOME_CAPACITY_WARNING_ENTRIES,
  OUTCOME_CAPACITY_WARNING_RECORD_BYTES,
  OUTCOME_CAPACITY_WARNING_WRITE_DURATION_MS,
} from "../domain/constants.js";
import {
  assertOutcomeRecordSize,
  OutcomeRecordSizeError,
  outcomeRecordByteLength,
  parseOutcomeRecord,
} from "../domain/schema.js";
import type {
  OutcomeCapacityWarning,
  OutcomeCapacitySnapshot,
  OutcomeRecord,
  OutcomeRepository,
  OutcomeRepositoryOptions,
} from "./outcome-repository.js";

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

/** Deliberately merges missing and foreign records at the repository boundary. */
export class OutcomeRepositoryNotFoundError extends Error {
  readonly code = "outcome-not-found" as const;

  constructor() {
    super("Outcome is unavailable to the requested manager");
    this.name = "OutcomeRepositoryNotFoundError";
  }
}

function isHostCapacityError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "PLUGIN_STATE_LIMIT_EXCEEDED"
  );
}

function rethrowKnownCapacity(error: unknown): never {
  if (error instanceof OutcomeRecordSizeError || isHostCapacityError(error)) {
    throw new OutcomeRepositoryCapacityError();
  }
  throw error;
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
    inspectCapacity: async () => capacitySnapshot((await store.entries()).length),
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
      let unavailable = false;
      await store.update!(id, (current) => {
        if (!current || current.managerProfileId !== managerProfileId) {
          unavailable = true;
          return undefined;
        }
        const decision = decide(current);
        result = decision.result;
        if (decision.next) {
          assertOutcomeRecordSize(decision.next);
        }
        return decision.next;
      });
      if (unavailable) {
        throw new OutcomeRepositoryNotFoundError();
      }
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
  options: OutcomeRepositoryOptions = {},
): OutcomeRepository {
  if (typeof store.deleteIf !== "function") {
    throw new Error("Outcome repository requires atomic keyed-store deleteIf");
  }
  const deleteIf = store.deleteIf;
  const base = createLegacyOutcomeRepository(store);
  const strict = (value: OutcomeRecord | undefined) =>
    value === undefined ? undefined : parseOutcomeRecord(value);
  const diagnostics = createCapacityDiagnostics(options);
  return {
    ...base,
    create: async (record) => {
      const startedAt = diagnostics.now();
      try {
        const parsed = parseOutcomeRecord(record);
        const created = await base.create(parsed);
        if (created.created) {
          await diagnostics.observeCommitted(parsed, diagnostics.now() - startedAt);
        }
        return created;
      } catch (error) {
        return rethrowKnownCapacity(error);
      }
    },
    createOwned: async (owner, record) => {
      if (!owner.trim() || record.managerProfileId !== owner) {
        throw new Error("Outcome manager profile does not match authenticated owner");
      }
      const startedAt = diagnostics.now();
      let parsed: OutcomeRecord;
      let created: boolean;
      try {
        parsed = parseOutcomeRecord(record);
        created = await store.registerIfAbsent(parsed.id, parsed);
      } catch (error) {
        return rethrowKnownCapacity(error);
      }
      if (created) {
        await diagnostics.observeCommitted(parsed, diagnostics.now() - startedAt);
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
    inspectCapacity: () => base.inspectCapacity(),
    getOwned: async (owner, id) => strict(await base.getOwned(owner, id)),
    listOwned: async (owner) => (await base.listOwned(owner)).map(parseOutcomeRecord),
    transact: async <T>(
      id: string,
      decide: (current: OutcomeRecord | undefined) => { result: T; next?: OutcomeRecord },
    ) => {
      const startedAt = diagnostics.now();
      let capacityExceeded = false;
      let committed: OutcomeRecord | undefined;
      const result = await base.transact(id, (current) => {
        const decision = decide(strict(current));
        let next: OutcomeRecord | undefined;
        try {
          next = decision.next === undefined ? undefined : parseOutcomeRecord(decision.next);
          committed = next;
        } catch (error) {
          if (error instanceof OutcomeRecordSizeError) {
            capacityExceeded = true;
            next = undefined;
          } else {
            throw error;
          }
        }
        return {
          result: decision.result,
          next,
        };
      });
      if (capacityExceeded) {
        throw new OutcomeRepositoryCapacityError();
      }
      if (committed !== undefined) {
        await diagnostics.observeCommitted(committed, diagnostics.now() - startedAt);
      }
      return result;
    },
    transactOwned: async <T>(
      owner: string,
      id: string,
      decide: (current: OutcomeRecord) => { result: T; next?: OutcomeRecord },
    ) => {
      const startedAt = diagnostics.now();
      let capacityExceeded = false;
      let committed: OutcomeRecord | undefined;
      const result = await base.transactOwned(owner, id, (current) => {
        const decision = decide(parseOutcomeRecord(current));
        let next: OutcomeRecord | undefined;
        try {
          next = decision.next === undefined ? undefined : parseOutcomeRecord(decision.next);
          committed = next;
        } catch (error) {
          if (error instanceof OutcomeRecordSizeError) {
            capacityExceeded = true;
            next = undefined;
          } else {
            throw error;
          }
        }
        return {
          result: decision.result,
          next,
        };
      });
      if (capacityExceeded) {
        throw new OutcomeRepositoryCapacityError();
      }
      if (committed !== undefined) {
        await diagnostics.observeCommitted(committed, diagnostics.now() - startedAt);
      }
      return result;
    },
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

function createCapacityDiagnostics(options: OutcomeRepositoryOptions) {
  const now = options.now ?? performance.now;

  const warn = (warning: OutcomeCapacityWarning) => {
    try {
      options.onCapacityWarning?.(warning);
    } catch {
      // A post-commit observer must never alter the acknowledged write result.
    }
  };

  return {
    now,
    observeCommitted: async (record: OutcomeRecord, writeDuration: number) => {
      if (!options.onCapacityWarning) {
        return;
      }
      const bytes = outcomeRecordByteLength(record);
      if (bytes >= OUTCOME_CAPACITY_WARNING_RECORD_BYTES) {
        warn({
          kind: "record-bytes",
          observed: bytes,
          threshold: OUTCOME_CAPACITY_WARNING_RECORD_BYTES,
        });
      }
      if (writeDuration >= OUTCOME_CAPACITY_WARNING_WRITE_DURATION_MS) {
        warn({
          kind: "write-duration",
          observed: writeDuration,
          threshold: OUTCOME_CAPACITY_WARNING_WRITE_DURATION_MS,
        });
      }
    },
  };
}

function capacitySnapshot(entryCount: number): OutcomeCapacitySnapshot {
  return {
    entryCount,
    warnings:
      entryCount >= OUTCOME_CAPACITY_WARNING_ENTRIES
        ? [
            {
              kind: "entry-count",
              observed: entryCount,
              threshold: OUTCOME_CAPACITY_WARNING_ENTRIES,
            },
          ]
        : [],
  };
}

/** Formal production repository entry point. */
export const createOutcomeRepository = createStrictOutcomeRepository;
