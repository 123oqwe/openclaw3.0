import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { fail, authenticatedProfileId } from "./method-helpers.js";

type MissingOwnerCode = "INVALID_REQUEST" | "NOT_FOUND";

/**
 * Applies the common Outcome request boundary before a handler observes state.
 * Scope authorization remains owned by the host registration and dispatcher.
 */
export function admitOutcomeOwner<Schema extends TSchema>(params: {
  client: GatewayRequestHandlerOptions["client"];
  missingOwnerCode: MissingOwnerCode;
  request: unknown;
  respond: GatewayRequestHandlerOptions["respond"];
  schema: Schema;
}): { owner: string; request: Static<Schema> } | undefined {
  if (!Value.Check(params.schema, params.request)) {
    fail(params.respond, "INVALID_REQUEST");
    return undefined;
  }
  const owner = authenticatedProfileId(params.client);
  if (!owner) {
    fail(params.respond, params.missingOwnerCode);
    return undefined;
  }
  return { owner, request: params.request };
}
