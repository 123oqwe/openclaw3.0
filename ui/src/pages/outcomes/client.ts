import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { OutcomeDetail, OutcomeListResult } from "@openclaw/outcomes-contract";

export async function listOutcomes(client: GatewayBrowserClient): Promise<OutcomeListResult> {
  return client.request<OutcomeListResult>("outcomes.list", {});
}

export async function getOutcome(
  client: GatewayBrowserClient,
  id: string,
): Promise<OutcomeDetail> {
  const result = await client.request<{ outcome: OutcomeDetail }>("outcomes.get", { id });
  return result.outcome;
}
