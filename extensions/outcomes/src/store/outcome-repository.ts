export type OutcomeRecord = {
  id: string;
  revision: number;
  title?: string;
  lastRequestHash?: string;
  [key: string]: unknown;
};

export type OutcomeRepository = {
  create(record: OutcomeRecord): Promise<{ created: boolean }>;
  get(id: string): Promise<OutcomeRecord | undefined>;
};
