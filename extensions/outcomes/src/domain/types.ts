export type OutcomeRecord = {
  id: string;
  revision: number;
  title?: string;
  phase?: "draft" | "active" | "accepted" | "cancelled";
  planGeneration?: number;
};
