import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { fail, authenticatedProfileId } from "./method-helpers.js";

type MissingOwnerCode = "INVALID_REQUEST" | "NOT_FOUND";

/**
 * Applies the common Outcome request boundary before a handler observes state.
 * Scope authorization remains owned by the host registration and dispatcher.
 */
export function admitOutcomeOwner(params: {
  client: GatewayRequestHandlerOptions["client"];
  missingOwnerCode: MissingOwnerCode;
  request: unknown;
  respond: GatewayRequestHandlerOptions["respond"];
  schema: TSchema;
}): string | undefined {
  if (!Value.Check(params.schema, params.request)) {
    fail(params.respond, "INVALID_REQUEST");
    return undefined;
  }
  const owner = authenticatedProfileId(params.client);
  if (!owner) {
    fail(params.respond, params.missingOwnerCode);
    return undefined;
  }
  return owner;
}
