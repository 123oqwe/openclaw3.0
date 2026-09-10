import type { OutcomeRecord } from "../domain/types.js";
export type { OutcomeRecord, PersistedOutcomeRecord } from "../domain/types.js";

export type OutcomeRepository = {
  create(record: OutcomeRecord): Promise<{ created: boolean }>;
  createOwned(
    managerProfileId: string,
    record: OutcomeRecord,
  ): Promise<{ created: boolean; replayed: boolean; record: OutcomeRecord }>;
  get(id: string): Promise<OutcomeRecord | undefined>;
  list(): Promise<OutcomeRecord[]>;
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
