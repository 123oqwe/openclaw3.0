import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RuntimeEnv } from "../../../src/runtime.js";

export const outcomeStoreOptions = {
  namespace: "outcomes-v1",
  maxEntries: 500,
  overflowPolicy: "reject-new" as const,
};

export type GatewayCallResult = Record<string, unknown>;

export type RefreshResponseSummary = {
  errorCode?: string;
  ok: boolean;
  refreshReason?: string;
  refreshStatus?: string;
  revision?: number;
  sourceIssueReasons: string[];
};

export function isGatewayCallResult(value: unknown): value is GatewayCallResult {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function readPersistedOutcomeEntries(env: NodeJS.ProcessEnv) {
  const store = createPluginStateKeyedStoreForTests<Record<string, unknown>>("outcomes", {
    ...outcomeStoreOptions,
    env,
  });
  const entries = await store.entries();
  return entries
    .map(({ key, value }) => ({ key, value }))
    .toSorted((left, right) => left.key.localeCompare(right.key));
}

function gatewayFrame(payload: { toString(): string }): GatewayCallResult | undefined {
  try {
    const parsed: unknown = JSON.parse(payload.toString());
    return isGatewayCallResult(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function gatewayFailureCode(stdout: string): string {
  const frame = gatewayFrame({ toString: () => stdout });
  const error = frame && isGatewayCallResult(frame.error) ? frame.error : undefined;
  const code = error?.code;
  // A Gateway error code is safe, bounded diagnostic context for a hosted
  // failure. Do not print the response body: it can contain params or records.
  return typeof code === "string" && /^[A-Z_]{1,64}$/u.test(code) ? code : "UNAVAILABLE";
}

export function refreshResponseSummary(frame: GatewayCallResult): RefreshResponseSummary {
  const error = isGatewayCallResult(frame.error) ? frame.error : undefined;
  const payload = isGatewayCallResult(frame.payload) ? frame.payload : undefined;
  const refresh = payload && isGatewayCallResult(payload.refresh) ? payload.refresh : undefined;
  const outcome = payload && isGatewayCallResult(payload.outcome) ? payload.outcome : undefined;
  const sourceIssueReasons = Array.isArray(outcome?.sourceIssues)
    ? outcome.sourceIssues.flatMap((issue) => {
        if (!isGatewayCallResult(issue) || typeof issue.reason !== "string") {
          return [];
        }
        return [issue.reason];
      })
    : [];
  return {
    ok: frame.ok === true,
    sourceIssueReasons,
    ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
    ...(typeof refresh?.reason === "string" ? { refreshReason: refresh.reason } : {}),
    ...(typeof refresh?.status === "string" ? { refreshStatus: refresh.status } : {}),
    ...(typeof outcome?.revision === "number" ? { revision: outcome.revision } : {}),
  };
}

export function createBackupRuntime(): RuntimeEnv {
  return {
    log: () => undefined,
    error: () => undefined,
    exit: () => undefined,
  };
}
