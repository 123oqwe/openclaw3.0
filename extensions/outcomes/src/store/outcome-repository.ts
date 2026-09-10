export type OutcomeRecord = {
  id: string;
  revision: number;
  [key: string]: unknown;
};

export type OutcomeRepository = {
  create(record: OutcomeRecord): Promise<{ created: boolean }>;
  get(id: string): Promise<OutcomeRecord | undefined>;
};
