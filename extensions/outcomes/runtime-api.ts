// Outcomes runtime API exposes only the plugin-owned Gateway registrar.
export { registerOutcomeGatewayMethods } from "./src/gateway/health.js";
export { createOutcomeRepository } from "./src/store/plugin-state-repository.js";
