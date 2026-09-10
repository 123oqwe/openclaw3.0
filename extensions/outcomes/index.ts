// Outcomes plugin entrypoint registers its minimal capability surface.
import { definePluginEntry } from "./api.js";
import { registerOutcomeGatewayMethods } from "./runtime-api.js";
import { createOutcomeRepository } from "./src/store/plugin-state-repository.js";
import { createRequestHash, createRequestSchema } from "./src/domain/schema.js";
import { reduceOutcomeTitle } from "./src/domain/reducer.js";
import type { OutcomeMutationResult } from "./src/domain/reducer.js";
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
    api.registerGatewayMethod("outcomes.updateTitle", async ({ params, respond }) => {
      const input = params as { id?: unknown; expectedRevision?: unknown; title?: unknown } | undefined;
      if (
        typeof input?.id !== "string" ||
        !input.id ||
        typeof input.expectedRevision !== "number" ||
        !Number.isInteger(input.expectedRevision) ||
        typeof input.title !== "string"
      ) {
        respond(false, { error: "id, expectedRevision and title are required" });
        return;
      }
      const result = await repository.transact<OutcomeMutationResult>(input.id, (current) => {
        if (!current) {
          return { result: { kind: "rejected", record: { id: input.id!, revision: 0 } } as OutcomeMutationResult };
        }
        const decision = reduceOutcomeTitle(current, {
          expectedRevision: input.expectedRevision as number,
          title: input.title as string,
        });
        return { result: decision, next: decision.kind === "updated" ? decision.record : undefined };
      });
      respond(true, result);
    }, { scope: "operator.write" });
  },
});
