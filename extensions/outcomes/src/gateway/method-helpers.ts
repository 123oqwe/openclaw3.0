import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "../../api.js";
import { toOutcomeDetail } from "../domain/read-model.js";
import type { OutcomeRecord } from "../domain/types.js";
import type { OutcomeCapacityWarning } from "../store/outcome-repository.js";
import { OutcomeErrorCodes, outcomeError } from "./errors.js";

export type GatewayRespond = GatewayRequestHandlerOptions["respond"];

export function fail(respond: GatewayRespond, code: keyof typeof OutcomeErrorCodes): void {
  respond(false, undefined, outcomeError(OutcomeErrorCodes[code]));
}

export function reportCapacityWarning(
  api: OpenClawPluginApi,
  warning: OutcomeCapacityWarning,
): void {
  // Keep persistence/source identities out of diagnostics; this is an internal threshold signal.
  api.logger.warn(
    `outcomes: capacity warning kind=${warning.kind} observed=${warning.observed} threshold=${warning.threshold}`,
  );
}

export function authenticatedProfileId(
  client: { authenticatedUserProfile?: { profileId: string } } | null,
): string | undefined {
  const id = client?.authenticatedUserProfile?.profileId?.trim();
  return id || undefined;
}

export function respondMutation(
  respond: GatewayRespond,
  decision: { kind: "updated" | "noop" | "conflict" | "rejected"; record: OutcomeRecord },
  now: number,
): void {
  if (decision.kind === "updated" || decision.kind === "noop") {
    return respond(true, { outcome: toOutcomeDetail(decision.record, now) });
  }
  respond(
    false,
    undefined,
    outcomeError(
      decision.kind === "conflict"
        ? OutcomeErrorCodes.REVISION_CONFLICT
        : OutcomeErrorCodes.INVALID_STATE,
    ),
  );
}
