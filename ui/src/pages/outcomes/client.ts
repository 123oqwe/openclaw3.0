import type {
  OutcomeDetail,
  OutcomeListResult,
  OutcomeMutationResult,
  OutcomeRefreshResult,
} from "@openclaw/outcomes-contract";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export async function listOutcomes(client: GatewayBrowserClient): Promise<OutcomeListResult> {
  return client.request<OutcomeListResult>("outcomes.list", {});
}

export async function getOutcome(client: GatewayBrowserClient, id: string): Promise<OutcomeDetail> {
  const result = await client.request<{ outcome: OutcomeDetail }>("outcomes.get", { id });
  return result.outcome;
}

export async function refreshOutcome(
  client: GatewayBrowserClient,
  id: string,
  expectedRevision: number,
): Promise<OutcomeDetail> {
  const result = await client.request<OutcomeRefreshResult>("outcomes.refresh", {
    expectedRevision,
    id,
  });
  return result.outcome;
}

export async function cancelOutcome(
  client: GatewayBrowserClient,
  id: string,
  expectedRevision: number,
): Promise<OutcomeDetail> {
  const result = await client.request<OutcomeMutationResult>("outcomes.cancel", {
    expectedRevision,
    id,
  });
  return result.outcome;
}

export async function activateOutcome(
  client: GatewayBrowserClient,
  id: string,
  expectedRevision: number,
): Promise<OutcomeDetail> {
  const result = await client.request<OutcomeMutationResult>("outcomes.activate", {
    expectedRevision,
    id,
  });
  return result.outcome;
}
