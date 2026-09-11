import type { OpenClawPluginApi } from "../../api.js";
import { Value } from "typebox/value";
import { reduceOutcomeCancel, reduceOutcomeContract, reduceOutcomeTitle } from "../domain/reducer.js";
import { createRequestHash } from "../domain/schema.js";
import { toOutcomeDetail, toOutcomeSummary } from "../domain/read-model.js";
import type { OutcomeRecord } from "../domain/types.js";
import { createOutcomeRepository } from "../store/plugin-state-repository.js";
import {
  outcomeCancelParamsSchema,
  outcomeCreateParamsSchema,
  outcomeIdParamsSchema,
  outcomeListParamsSchema,
  outcomeUpdateParamsSchema,
} from "./schemas.js";

const OUTCOME_STORE = { namespace: "outcomes-v1", maxEntries: 500, overflowPolicy: "reject-new" as const };

function invalid(respond: (ok: false, payload?: undefined, error?: unknown) => void): void {
  respond(false, undefined, { code: "INVALID_REQUEST", message: "invalid Outcome request" });
}

function owner(client: { authenticatedUserProfile?: { profileId: string } } | null): string | undefined {
  return client?.authenticatedUserProfile?.profileId;
}

/** Register the P-02 first package; every persisted access is scoped to the authenticated owner. */
export function registerOutcomeFirstPackageMethods(api: OpenClawPluginApi): void {
  const repository = createOutcomeRepository(api.runtime.state.openKeyedStore(OUTCOME_STORE) as never);
  api.registerGatewayMethod("outcomes.create", async ({ client, params, respond }) => {
    if (!Value.Check(outcomeCreateParamsSchema, params)) return invalid(respond);
    const managerProfileId = owner(client);
    if (!managerProfileId) return respond(false, undefined, { code: "FORBIDDEN", message: "authentication required" });
    const now = Date.now();
    const request = { ...params, criteria: params.criteria.map((criterion) => ({ ...criterion, workRefs: [] })) };
    const record: OutcomeRecord = { schemaVersion: 1, id: request.id, createRequestHash: createRequestHash(request), managerProfileId, title: request.title, objective: request.objective, phase: "draft", revision: 1, contractRevision: 1, planGeneration: 0, planHash: null, criteria: request.criteria, projections: [], evidence: [], decisions: [], operations: [], acceptances: [], createdAt: now, updatedAt: now };
    try {
      const result = await repository.createOwned(managerProfileId, record);
      respond(true, { outcome: toOutcomeDetail(result.record, now), replayed: result.replayed, receipt: { kind: "create", id: record.id, committedRevision: 1 } });
    } catch {
      respond(false, undefined, { code: "CONFLICT", message: "Outcome create conflicts" });
    }
  }, { scope: "operator.write" });
  api.registerGatewayMethod("outcomes.get", async ({ client, params, respond }) => {
    if (!Value.Check(outcomeIdParamsSchema, params)) return invalid(respond);
    const managerProfileId = owner(client);
    const record = managerProfileId ? await repository.getOwned(managerProfileId, params.id) : undefined;
    if (!record) return respond(false, undefined, { code: "NOT_FOUND", message: "Outcome not found" });
    respond(true, { outcome: toOutcomeDetail(record, Date.now()) });
  }, { scope: "operator.read" });
  api.registerGatewayMethod("outcomes.list", async ({ client, params, respond }) => {
    if (!Value.Check(outcomeListParamsSchema, params)) return invalid(respond);
    const managerProfileId = owner(client);
    if (!managerProfileId) return respond(false, undefined, { code: "FORBIDDEN", message: "authentication required" });
    const limit = params.limit ?? 25;
    const outcomes = (await repository.listOwned(managerProfileId)).slice(0, limit).map((record) => toOutcomeSummary(record, Date.now()));
    respond(true, { outcomes });
  }, { scope: "operator.read" });
  api.registerGatewayMethod("outcomes.update", async ({ client, params, respond }) => {
    if (!Value.Check(outcomeUpdateParamsSchema, params) || (params.title === undefined && params.objective === undefined && params.criteria === undefined)) return invalid(respond);
    const managerProfileId = owner(client);
    if (!managerProfileId) return respond(false, undefined, { code: "FORBIDDEN", message: "authentication required" });
    try {
      const decision = await repository.transactOwned(managerProfileId, params.id, (current) => {
        const mutation = params.objective === undefined && params.criteria === undefined ? reduceOutcomeTitle(current, { expectedRevision: params.expectedRevision, title: params.title!, serverTime: Date.now() }) : reduceOutcomeContract(current, { expectedRevision: params.expectedRevision, objective: params.objective ?? current.objective, criteria: (params.criteria ?? current.criteria.map(({ workRefs, ...criterion }) => criterion)).map((criterion) => ({ ...criterion, workRefs: current.criteria.find((item) => item.id === criterion.id)?.workRefs ?? [] })), serverTime: Date.now() });
        return { result: mutation, ...(mutation.kind === "updated" ? { next: mutation.record } : {}) };
      });
      respond(true, { outcome: toOutcomeDetail(decision.record, Date.now()) });
    } catch { respond(false, undefined, { code: "NOT_FOUND", message: "Outcome not found" }); }
  }, { scope: "operator.write" });
  api.registerGatewayMethod("outcomes.cancel", async ({ client, params, respond }) => {
    if (!Value.Check(outcomeCancelParamsSchema, params)) return invalid(respond);
    const managerProfileId = owner(client);
    if (!managerProfileId) return respond(false, undefined, { code: "FORBIDDEN", message: "authentication required" });
    try { const decision = await repository.transactOwned(managerProfileId, params.id, (current) => { const mutation = reduceOutcomeCancel(current, params.expectedRevision, Date.now()); return { result: mutation, ...(mutation.kind === "updated" ? { next: mutation.record } : {}) }; }); respond(true, { outcome: toOutcomeDetail(decision.record, Date.now()) }); } catch { respond(false, undefined, { code: "NOT_FOUND", message: "Outcome not found" }); }
  }, { scope: "operator.write" });
}
