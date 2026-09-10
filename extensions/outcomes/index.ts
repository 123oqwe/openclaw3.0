// Outcomes plugin entrypoint registers its minimal capability surface.
import { definePluginEntry } from "./api.js";
import { registerOutcomeGatewayMethods } from "./runtime-api.js";
import { createOutcomeRepository } from "./src/store/plugin-state-repository.js";
import { createRequestHash, createRequestSchema } from "./src/domain/schema.js";
import type { OutcomeRecord } from "./src/domain/types.js";

export default definePluginEntry({
  id: "outcomes",
  name: "Outcomes",
  description: "Outcome responsibility and acceptance layer.",
  register(api) {
    registerOutcomeGatewayMethods(api);
    const repository = createOutcomeRepository(
      api.runtime.state.openKeyedStore<OutcomeRecord>({
        namespace: "outcomes-v1",
        maxEntries: 100,
        overflowPolicy: "reject-new",
      }),
    );
    api.registerGatewayMethod("outcomes.create", async ({ params, respond }) => {
      try {
        const request = createRequestSchema.parse(params);
        const now = Date.now();
        const record: OutcomeRecord = {
          schemaVersion: 1,
          id: request.id,
          createRequestHash: createRequestHash(request),
          title: request.title,
          objective: request.objective,
          revision: 1,
          phase: "draft",
          planGeneration: 0,
          criteria: request.criteria,
          createdAt: now,
          updatedAt: now,
        };
        const result = await repository.create(record);
        respond(true, { created: result.created, record: result.created ? record : await repository.get(record.id) });
      } catch (error) {
        respond(false, { error: error instanceof Error ? error.message : String(error) });
      }
    }, { scope: "operator.write" });
    api.registerGatewayMethod("outcomes.get", async ({ params, respond }) => {
      const id = (params as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || !id) {
        respond(false, { error: "id must be a non-empty string" });
        return;
      }
      respond(true, { record: await repository.get(id) });
    }, { scope: "operator.read" });
  },
});
