// Outcomes plugin entrypoint registers its minimal capability surface.
import { definePluginEntry } from "./api.js";
import { registerOutcomeGatewayMethods } from "./runtime-api.js";

export default definePluginEntry({
  id: "outcomes",
  name: "Outcomes",
  description: "Outcome responsibility and acceptance layer.",
  register(api) {
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "outcomes",
      label: "Outcomes",
      placement: "route:outcomes",
      icon: "target",
      group: "control",
      requiredScopes: ["operator.read"],
    });
    registerOutcomeGatewayMethods(api);
  },
});
