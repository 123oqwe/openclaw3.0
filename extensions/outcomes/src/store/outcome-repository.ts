import type { OutcomeRecord } from "../domain/types.js";
export type { OutcomeRecord } from "../domain/types.js";

export type OutcomeRepository = {
  create(record: OutcomeRecord): Promise<{ created: boolean }>;
  get(id: string): Promise<OutcomeRecord | undefined>;
  transact<T>(
    id: string,
    decide: (current: OutcomeRecord | undefined) => { result: T; next?: OutcomeRecord },
  ): Promise<T>;
};
