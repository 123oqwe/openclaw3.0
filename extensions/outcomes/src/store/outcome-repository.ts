import type { OutcomeRecord } from "../domain/types.js";
export type { OutcomeRecord, PersistedOutcomeRecord } from "../domain/types.js";

export type OutcomeCapacityWarning =
  | { kind: "entry-count"; observed: number; threshold: number }
  | { kind: "record-bytes"; observed: number; threshold: number }
  | { kind: "write-duration"; observed: number; threshold: number };

/** A read-only, host-sampled capacity observation. */
export type OutcomeCapacitySnapshot = {
  entryCount: number;
  warnings: OutcomeCapacityWarning[];
};

/**
 * Internal-only diagnostics. The callback is deliberately not part of a public
 * Gateway contract; P-02 supplies an actual receiver when it wires mutations.
 */
export type OutcomeRepositoryOptions = {
  onCapacityWarning?: (warning: OutcomeCapacityWarning) => void;
  /** Test seam for measuring a single host write without trusting caller time. */
  now?: () => number;
};

export type OutcomeRepository = {
  create(record: OutcomeRecord): Promise<{ created: boolean }>;
  createOwned(
    managerProfileId: string,
    record: OutcomeRecord,
  ): Promise<{ created: boolean; replayed: boolean; record: OutcomeRecord }>;
  get(id: string): Promise<OutcomeRecord | undefined>;
  list(): Promise<OutcomeRecord[]>;
  inspectCapacity(): Promise<OutcomeCapacitySnapshot>;
  transact<T>(
    id: string,
    decide: (current: OutcomeRecord | undefined) => { result: T; next?: OutcomeRecord },
  ): Promise<T>;
  deleteIf(id: string, predicate: (current: OutcomeRecord) => boolean): Promise<boolean>;
  getOwned(managerProfileId: string, id: string): Promise<OutcomeRecord | undefined>;
  listOwned(managerProfileId: string): Promise<OutcomeRecord[]>;
  transactOwned<T>(
    managerProfileId: string,
    id: string,
    decide: (current: OutcomeRecord | undefined) => { result: T; next?: OutcomeRecord },
  ): Promise<T>;
  deleteOwnedIf(
    managerProfileId: string,
    id: string,
    predicate: (current: OutcomeRecord) => boolean,
  ): Promise<boolean>;
};
