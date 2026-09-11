import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";
import type {
  OutcomeCreateParams,
  OutcomeCriterionInput,
  OutcomeWorkboardLinkParams,
  OutcomeUpdateParams,
} from "@openclaw/outcomes-contract";
import type { OpenClawPluginApi } from "../../api.js";
import { Value } from "typebox/value";
import { OUTCOME_MAX_ENTRIES, OUTCOME_OVERFLOW_POLICY } from "../domain/constants.js";
import {
  reduceOutcomeActivate,
  reduceOutcomeCancel,
  reduceOutcomeLink,
  reduceOutcomePatch,
  reduceOutcomeUnlink,
} from "../domain/reducer.js";
import { createRequestHash } from "../domain/schema.js";
import { toOutcomeDetail, toOutcomeSummary } from "../domain/read-model.js";
import type { Criterion, OutcomeRecord } from "../domain/types.js";
import { createOutcomeRepository } from "../store/plugin-state-repository.js";
import { WorkboardIdentityConflictError, readWorkboardCards } from "../adapters/workboard-adapter.js";
import { decodeOutcomeCursor, encodeOutcomeCursor } from "./cursor.js";
import { OutcomeErrorCodes, outcomeError, outcomeOwnerError, outcomeStorageError } from "./errors.js";
import {
  outcomeCancelParamsSchema,
  outcomeActivateParamsSchema,
  outcomeCreateParamsSchema,
  outcomeIdParamsSchema,
  outcomeListParamsSchema,
  outcomeUpdateParamsSchema,
  outcomeWorkboardLinkParamsSchema,
  outcomeWorkboardUnlinkParamsSchema,
} from "./schemas.js";

const OUTCOME_STORE = { namespace: "outcomes-v1", maxEntries: OUTCOME_MAX_ENTRIES, overflowPolicy: OUTCOME_OVERFLOW_POLICY };
const MAX_REQUEST_BYTES = 64 * 1024;
type PublicCriterion = OutcomeCriterionInput;
type PublicCreate = OutcomeCreateParams;
type PublicPatch = OutcomeUpdateParams["patch"];
type PublicWorkboardLink = OutcomeWorkboardLinkParams;

function fail(respond: (ok: false, payload?: undefined, error?: unknown) => void, code: keyof typeof OutcomeErrorCodes): void {
  respond(false, undefined, outcomeError(OutcomeErrorCodes[code]));
}
function authenticatedProfileId(client: { authenticatedUserProfile?: { profileId: string } } | null): string | undefined {
  const id = client?.authenticatedUserProfile?.profileId?.trim();
  return id || undefined;
}
function normalizedUuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ? id : undefined;
}
function normalizedText(value: unknown, min: number, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const length = Array.from(text).length;
  return length >= min && length <= max ? text : undefined;
}
function normalizeCriteria(value: unknown): PublicCriterion[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return undefined;
  const criteria: PublicCriterion[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const input = item as Record<string, unknown>;
    const id = normalizedUuid(input.id);
    const text = normalizedText(input.text, 1, 1000);
    if (!id || !text || typeof input.required !== "boolean") return undefined;
    criteria.push({ id, text, required: input.required });
  }
  return criteria.some((criterion) => criterion.required) && new Set(criteria.map((criterion) => criterion.id)).size === criteria.length ? criteria : undefined;
}
function withinBudget(value: unknown): boolean { return Buffer.byteLength(stableStringify(value), "utf8") <= MAX_REQUEST_BYTES; }
function normalizeCreate(params: unknown): PublicCreate | undefined {
  if (!params || typeof params !== "object") return undefined;
  const input = params as Record<string, unknown>;
  const id = normalizedUuid(input.id); const title = normalizedText(input.title, 1, 160);
  const objective = normalizedText(input.objective, 1, 4000); const criteria = normalizeCriteria(input.criteria);
  const result = id && title && objective && criteria ? { id, title, objective, criteria } : undefined;
  return result && withinBudget(result) ? result : undefined;
}
function normalizePatch(params: unknown): { id: string; expectedRevision: number; patch: PublicPatch } | undefined {
  if (!params || typeof params !== "object") return undefined;
  const input = params as Record<string, unknown>; const id = normalizedUuid(input.id); const patchInput = input.patch;
  if (!id || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1 || !patchInput || typeof patchInput !== "object") return undefined;
  const raw = patchInput as Record<string, unknown>; const patch: PublicPatch = {};
  if (Object.hasOwn(raw, "title")) { const title = normalizedText(raw.title, 1, 160); if (!title) return undefined; patch.title = title; }
  if (Object.hasOwn(raw, "objective")) { const objective = normalizedText(raw.objective, 1, 4000); if (!objective) return undefined; patch.objective = objective; }
  if (Object.hasOwn(raw, "criteria")) { const criteria = normalizeCriteria(raw.criteria); if (!criteria) return undefined; patch.criteria = criteria; }
  const result = { id, expectedRevision: input.expectedRevision as number, patch };
  return Object.keys(patch).length > 0 && withinBudget(result) ? result : undefined;
}
function normalizeWorkboardLink(params: unknown): PublicWorkboardLink | undefined {
  if (!params || typeof params !== "object") return undefined;
  const input = params as Record<string, unknown>;
  const id = normalizedUuid(input.id);
  const criterionId = normalizedUuid(input.criterionId);
  const cardId = typeof input.cardId === "string" ? input.cardId.trim() : "";
  if (
    !id ||
    !criterionId ||
    !cardId ||
    !Number.isSafeInteger(input.expectedRevision) ||
    (input.expectedRevision as number) < 1
  ) {
    return undefined;
  }
  const result = { id, expectedRevision: input.expectedRevision as number, criterionId, cardId };
  return withinBudget(result) ? result : undefined;
}
function withRefs(criteria: PublicCriterion[], current: Criterion[]): Criterion[] {
  return criteria.map((criterion) => ({ ...criterion, workRefs: current.find((item) => item.id === criterion.id)?.workRefs ?? [] }));
}
function respondMutation(
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void,
  decision: { kind: "updated" | "noop" | "conflict" | "rejected"; record: OutcomeRecord }, now: number,
): void {
  if (decision.kind === "updated" || decision.kind === "noop") return respond(true, { outcome: toOutcomeDetail(decision.record, now) });
  respond(false, undefined, outcomeError(decision.kind === "conflict" ? OutcomeErrorCodes.REVISION_CONFLICT : OutcomeErrorCodes.INVALID_STATE));
}

async function readAuthorizedWorkboardCard(api: OpenClawPluginApi, cardId: string) {
  const response = await api.runtime.gateway.request(
    "workboard.cards.list",
    {},
    { scopes: ["operator.read"], requireAuthenticatedRequest: true, timeoutMs: 10_000 },
  );
  const matches = readWorkboardCards(response).filter((card) => card.id === cardId);
  if (matches.length > 1) throw new WorkboardIdentityConflictError();
  return matches[0];
}

/** Register the P-02 first package; every persisted access is scoped to the authenticated owner. */
export function registerOutcomeFirstPackageMethods(api: OpenClawPluginApi): void {
  const repository = createOutcomeRepository(api.runtime.state.openKeyedStore<OutcomeRecord>(OUTCOME_STORE));
  api.registerGatewayMethod("outcomes.create", async ({ client, params, respond }) => {
    if (!Value.Check(outcomeCreateParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
    const request = normalizeCreate(params); const owner = authenticatedProfileId(client); if (!request || !owner) return fail(respond, "INVALID_REQUEST");
    const now = Date.now(); const criteria = request.criteria.map((criterion) => ({ ...criterion, workRefs: [] }));
    const record: OutcomeRecord = { schemaVersion: 1, id: request.id, createRequestHash: createRequestHash({ ...request, criteria }), managerProfileId: owner, title: request.title, objective: request.objective, phase: "draft", revision: 1, contractRevision: 1, planGeneration: 0, planHash: null, criteria, projections: [], evidence: [], decisions: [], operations: [], acceptances: [], createdAt: now, updatedAt: now };
    try { const result = await repository.createOwned(owner, record); respond(true, { outcome: toOutcomeDetail(result.record, now), replayed: result.replayed, receipt: { kind: "create", id: result.record.id, committedRevision: 1 } }); }
    catch (error) { respond(false, undefined, outcomeError(outcomeStorageError(error, "create"))); }
  }, { scope: "operator.write" });
  api.registerGatewayMethod("outcomes.get", async ({ client, params, respond }) => {
    if (!Value.Check(outcomeIdParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
    const owner = authenticatedProfileId(client); const id = normalizedUuid(params.id); if (!owner || !id) return fail(respond, "NOT_FOUND");
    try { const record = await repository.getOwned(owner, id); if (!record) return fail(respond, "NOT_FOUND"); respond(true, { outcome: toOutcomeDetail(record, Date.now()) }); }
    catch (error) { respond(false, undefined, outcomeError(outcomeStorageError(error, "read"))); }
  }, { scope: "operator.read" });
  api.registerGatewayMethod("outcomes.list", async ({ client, params, respond }) => {
    if (!Value.Check(outcomeListParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
    const owner = authenticatedProfileId(client); if (!owner) return fail(respond, "NOT_FOUND");
    const cursor = params.cursor === undefined ? undefined : decodeOutcomeCursor(owner, params.cursor); if (params.cursor !== undefined && !cursor) return fail(respond, "INVALID_CURSOR");
    try { const eligible = (await repository.listOwned(owner)).filter((record) => !cursor || record.updatedAt < cursor.updatedAt || (record.updatedAt === cursor.updatedAt && record.id > cursor.id)); const page = eligible.slice(0, params.limit ?? 25); const now = Date.now(); respond(true, { outcomes: page.map((record) => toOutcomeSummary(record, now)), ...(eligible.length > page.length && page.at(-1) ? { nextCursor: encodeOutcomeCursor(owner, page.at(-1)!) } : {}) }); }
    catch (error) { respond(false, undefined, outcomeError(outcomeStorageError(error, "read"))); }
  }, { scope: "operator.read" });
  api.registerGatewayMethod("outcomes.update", async ({ client, params, respond }) => {
    if (!Value.Check(outcomeUpdateParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
    const request = normalizePatch(params); const owner = authenticatedProfileId(client); if (!request || !owner) return fail(respond, "INVALID_REQUEST"); const now = Date.now();
    try { const decision = await repository.transactOwned(owner, request.id, (current) => { const mutation = reduceOutcomePatch(current, { expectedRevision: request.expectedRevision, ...(request.patch.title === undefined ? {} : { title: request.patch.title }), ...(request.patch.objective === undefined ? {} : { objective: request.patch.objective }), ...(request.patch.criteria === undefined ? {} : { criteria: withRefs(request.patch.criteria, current.criteria) }), serverTime: now }); return { result: mutation, ...(mutation.kind === "updated" ? { next: mutation.record } : {}) }; }); respondMutation(respond, decision, now); }
    catch (error) { respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation"))); }
  }, { scope: "operator.write" });
  api.registerGatewayMethod("outcomes.linkWorkboard", async ({ client, params, respond }) => {
    if (!Value.Check(outcomeWorkboardLinkParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
    const request = normalizeWorkboardLink(params); const owner = authenticatedProfileId(client); if (!request || !owner) return fail(respond, "INVALID_REQUEST");
    try {
      if (!(await repository.getOwned(owner, request.id))) return fail(respond, "NOT_FOUND");
    } catch (error) { respond(false, undefined, outcomeError(outcomeStorageError(error, "read"))); return; }
    let card: Awaited<ReturnType<typeof readAuthorizedWorkboardCard>>;
    try { card = await readAuthorizedWorkboardCard(api, request.cardId); }
    catch (error) { respond(false, undefined, outcomeError(outcomeOwnerError(error))); return; }
    if (!card) return fail(respond, "OWNER_UNAVAILABLE");
    try {
      const now = Date.now();
      const decision = await repository.transactOwned(owner, request.id, (current) => {
        const mutation = reduceOutcomeLink(current, {
          expectedRevision: request.expectedRevision,
          criterionId: request.criterionId,
          ref: { owner: "workboard", cardId: card.id, cardCreatedAt: card.createdAt, boardIdAtLink: card.boardId },
          serverTime: now,
        });
        return { result: mutation, ...(mutation.kind === "updated" ? { next: mutation.record } : {}) };
      });
      respondMutation(respond, decision, now);
    } catch (error) { respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation"))); }
  }, { scope: "operator.write" });
  api.registerGatewayMethod("outcomes.unlinkWorkboard", async ({ client, params, respond }) => {
    if (!Value.Check(outcomeWorkboardUnlinkParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
    const request = normalizeWorkboardLink(params); const owner = authenticatedProfileId(client); if (!request || !owner) return fail(respond, "INVALID_REQUEST");
    try {
      if (!(await repository.getOwned(owner, request.id))) return fail(respond, "NOT_FOUND");
    } catch (error) { respond(false, undefined, outcomeError(outcomeStorageError(error, "read"))); return; }
    let card: Awaited<ReturnType<typeof readAuthorizedWorkboardCard>>;
    try { card = await readAuthorizedWorkboardCard(api, request.cardId); }
    catch (error) { respond(false, undefined, outcomeError(outcomeOwnerError(error))); return; }
    if (!card) return fail(respond, "OWNER_UNAVAILABLE");
    try {
      const now = Date.now();
      const decision = await repository.transactOwned(owner, request.id, (current) => {
        const mutation = reduceOutcomeUnlink(current, {
          expectedRevision: request.expectedRevision,
          criterionId: request.criterionId,
          ref: { owner: "workboard", cardId: card.id, cardCreatedAt: card.createdAt, boardIdAtLink: card.boardId },
          serverTime: now,
        });
        return { result: mutation, ...(mutation.kind === "updated" ? { next: mutation.record } : {}) };
      });
      respondMutation(respond, decision, now);
    } catch (error) { respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation"))); }
  }, { scope: "operator.write" });
  api.registerGatewayMethod("outcomes.activate", async ({ client, params, respond }) => {
    if (!Value.Check(outcomeActivateParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
    const owner = authenticatedProfileId(client); const id = normalizedUuid(params.id);
    if (!owner || !id) return fail(respond, "INVALID_REQUEST");
    const now = Date.now();
    try {
      const decision = await repository.transactOwned(owner, id, (current) => {
        const mutation = reduceOutcomeActivate(current, params.expectedRevision, now);
        return { result: mutation, ...(mutation.kind === "updated" ? { next: mutation.record } : {}) };
      });
      respondMutation(respond, decision, now);
    } catch (error) { respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation"))); }
  }, { scope: "operator.write" });
  api.registerGatewayMethod("outcomes.cancel", async ({ client, params, respond }) => {
    if (!Value.Check(outcomeCancelParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
    const owner = authenticatedProfileId(client); const id = normalizedUuid(params.id); if (!owner || !id) return fail(respond, "INVALID_REQUEST"); const now = Date.now();
    try { const decision = await repository.transactOwned(owner, id, (current) => { const mutation = reduceOutcomeCancel(current, params.expectedRevision, now); return { result: mutation, ...(mutation.kind === "updated" ? { next: mutation.record } : {}) }; }); respondMutation(respond, decision, now); }
    catch (error) { respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation"))); }
  }, { scope: "operator.write" });
}
