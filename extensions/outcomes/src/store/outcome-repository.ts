import type { OutcomeRecord } from "../domain/types.js";
export type { OutcomeRecord } from "../domain/types.js";

export type OutcomeRepository = {
  create(record: OutcomeRecord): Promise<{ created: boolean }>;
  get(id: string): Promise<OutcomeRecord | undefined>;
};
