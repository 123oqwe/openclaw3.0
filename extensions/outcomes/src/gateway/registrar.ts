import type { OpenClawPluginApi } from "../../api.js";
import { registerOutcomeHealthMethod } from "./health.js";
import { registerOutcomeFirstPackageMethods } from "./methods.js";

/** The runtime's single Outcome Gateway composition point. */
export function registerOutcomeGatewayMethods(api: OpenClawPluginApi): void {
  registerOutcomeHealthMethod(api);
  registerOutcomeFirstPackageMethods(api);
}
