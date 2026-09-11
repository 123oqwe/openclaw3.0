import type {
  OutcomeCreateParams,
  OutcomeCriterionInput,
  OutcomeRefreshStatus,
  OutcomeSourceIssueReason,
  OutcomeWorkboardLinkParams,
  OutcomeUpdateParams,
} from "@openclaw/outcomes-contract";
import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";
import { Value } from "typebox/value";
import type { OpenClawPluginApi } from "../../api.js";
import {
  WorkboardIdentityConflictError,
  readWorkboardCards,
} from "../adapters/workboard-adapter.js";
import { extractWorkboardEvidence } from "../assurance/evidence.js";
import { OUTCOME_MAX_ENTRIES, OUTCOME_OVERFLOW_POLICY } from "../domain/constants.js";
import {
  toOutcomeDetail,
  toOutcomeSummary,
  type AuthorizedOutcomeSource,
} from "../domain/read-model.js";
import {
  reduceOutcomeActivate,
  reduceOutcomeCancel,
  reduceOutcomeLink,
  reduceOutcomePatch,
  reduceOutcomeRefresh,
  reduceOutcomeUnlink,
} from "../domain/reducer.js";
import { createRequestHash, workboardProjectionFingerprint } from "../domain/schema.js";
import type {
  Criterion,
  EvidenceRef,
  OutcomeRecord,
  WorkProjection,
  WorkboardRef,
} from "../domain/types.js";
import type { OutcomeCapacityWarning } from "../store/outcome-repository.js";
import { createOutcomeRepository } from "../store/plugin-state-repository.js";
import { decodeOutcomeCursor, encodeOutcomeCursor } from "./cursor.js";
import {
  OutcomeErrorCodes,
  outcomeError,
  outcomeOwnerError,
  outcomeStorageError,
} from "./errors.js";
import {
  outcomeCancelParamsSchema,
  outcomeActivateParamsSchema,
  outcomeCreateParamsSchema,
  outcomeIdParamsSchema,
  outcomeListParamsSchema,
  outcomeRefreshParamsSchema,
  outcomeUpdateParamsSchema,
  outcomeWorkboardLinkParamsSchema,
  outcomeWorkboardUnlinkParamsSchema,
} from "./schemas.js";

const OUTCOME_STORE = {
  namespace: "outcomes-v1",
  maxEntries: OUTCOME_MAX_ENTRIES,
  overflowPolicy: OUTCOME_OVERFLOW_POLICY,
};
const MAX_REQUEST_BYTES = 64 * 1024;
type PublicCriterion = OutcomeCriterionInput;
type PublicCreate = OutcomeCreateParams;
type PublicPatch = OutcomeUpdateParams["patch"];
type PublicWorkboardLink = OutcomeWorkboardLinkParams;

function fail(
  respond: (ok: false, payload?: undefined, error?: unknown) => void,
  code: keyof typeof OutcomeErrorCodes,
): void {
  respond(false, undefined, outcomeError(OutcomeErrorCodes[code]));
}

function reportCapacityWarning(api: OpenClawPluginApi, warning: OutcomeCapacityWarning): void {
  // Keep persistence/source identities out of diagnostics; this is an internal threshold signal.
  api.logger.warn(
    `outcomes: capacity warning kind=${warning.kind} observed=${warning.observed} threshold=${warning.threshold}`,
  );
}

function authenticatedProfileId(
  client: { authenticatedUserProfile?: { profileId: string } } | null,
): string | undefined {
  const id = client?.authenticatedUserProfile?.profileId?.trim();
  return id || undefined;
}
function normalizedUuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? id
    : undefined;
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
  return criteria.some((criterion) => criterion.required) &&
    new Set(criteria.map((criterion) => criterion.id)).size === criteria.length
    ? criteria
    : undefined;
}
function withinBudget(value: unknown): boolean {
  return Buffer.byteLength(stableStringify(value), "utf8") <= MAX_REQUEST_BYTES;
}
function normalizeCreate(params: unknown): PublicCreate | undefined {
  if (!params || typeof params !== "object") return undefined;
  const input = params as Record<string, unknown>;
  const id = normalizedUuid(input.id);
  const title = normalizedText(input.title, 1, 160);
  const objective = normalizedText(input.objective, 1, 4000);
  const criteria = normalizeCriteria(input.criteria);
  const result =
    id && title && objective && criteria ? { id, title, objective, criteria } : undefined;
  return result && withinBudget(result) ? result : undefined;
}
function normalizePatch(
  params: unknown,
): { id: string; expectedRevision: number; patch: PublicPatch } | undefined {
  if (!params || typeof params !== "object") return undefined;
  const input = params as Record<string, unknown>;
  const id = normalizedUuid(input.id);
  const patchInput = input.patch;
  if (
    !id ||
    !Number.isSafeInteger(input.expectedRevision) ||
    (input.expectedRevision as number) < 1 ||
    !patchInput ||
    typeof patchInput !== "object"
  )
    return undefined;
  const raw = patchInput as Record<string, unknown>;
  const patch: PublicPatch = {};
  if (Object.hasOwn(raw, "title")) {
    const title = normalizedText(raw.title, 1, 160);
    if (!title) return undefined;
    patch.title = title;
  }
  if (Object.hasOwn(raw, "objective")) {
    const objective = normalizedText(raw.objective, 1, 4000);
    if (!objective) return undefined;
    patch.objective = objective;
  }
  if (Object.hasOwn(raw, "criteria")) {
    const criteria = normalizeCriteria(raw.criteria);
    if (!criteria) return undefined;
    patch.criteria = criteria;
  }
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
  return criteria.map((criterion) => ({
    ...criterion,
    workRefs: current.find((item) => item.id === criterion.id)?.workRefs ?? [],
  }));
}
function respondMutation(
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void,
  decision: { kind: "updated" | "noop" | "conflict" | "rejected"; record: OutcomeRecord },
  now: number,
): void {
  if (decision.kind === "updated" || decision.kind === "noop")
    return respond(true, { outcome: toOutcomeDetail(decision.record, now) });
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

class InvalidWorkboardResponseError extends Error {
  constructor() {
    super("invalid Workboard response");
    this.name = "InvalidWorkboardResponseError";
  }
}

async function readAuthorizedWorkboardCards(api: OpenClawPluginApi) {
  const response = await api.runtime.gateway.request(
    "workboard.cards.list",
    {},
    { scopes: ["operator.read"], requireAuthenticatedRequest: true, timeoutMs: 10_000 },
  );
  try {
    return readWorkboardCards(response);
  } catch (error) {
    if (error instanceof WorkboardIdentityConflictError) throw error;
    throw new InvalidWorkboardResponseError();
  }
}

type RefreshReason = OutcomeSourceIssueReason;
type RefreshSummary = { status: OutcomeRefreshStatus; reason?: RefreshReason };
type RefreshCandidate = {
  projections: WorkProjection[];
  evidence: EvidenceRef[];
  authorizedSources: AuthorizedOutcomeSource[];
  refresh: RefreshSummary;
};

function workRefIdentity(ref: WorkboardRef): string {
  return `${ref.cardId}\0${ref.cardCreatedAt}`;
}

function uniqueSourcePairs(items: Array<{ sourceId: string; digest: string }>) {
  const pairs = new Map(items.map((item) => [`${item.sourceId}\0${item.digest}`, item]));
  return Array.from(pairs.values()).toSorted(
    (left, right) =>
      (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0) ||
      (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0),
  );
}

function publicSourceUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function refreshReason(error: unknown): RefreshReason {
  if (error instanceof WorkboardIdentityConflictError) return "identity-conflict";
  if (error instanceof InvalidWorkboardResponseError) return "invalid-response";
  switch (outcomeOwnerError(error)) {
    case OutcomeErrorCodes.OWNER_FORBIDDEN:
      return "forbidden";
    case OutcomeErrorCodes.OWNER_TIMEOUT:
      return "timeout";
    default:
      return "workboard-disabled";
  }
}

function unavailableRefresh(
  record: OutcomeRecord,
  observedAt: number,
  reason: RefreshReason,
): RefreshCandidate {
  const availability: WorkProjection["availability"] =
    reason === "identity-conflict" ? "identity-conflict" : "unavailable";
  const projections = record.criteria
    .flatMap((criterion) => criterion.workRefs)
    .filter(
      (ref, index, refs) =>
        refs.findIndex((item) => workRefIdentity(item) === workRefIdentity(ref)) === index,
    )
    .map((ref) => ({
      ref,
      availability,
      observedAt,
      proofs: [],
      artifacts: [],
      errorCode: reason,
    }));
  return {
    projections,
    evidence: [],
    authorizedSources: [],
    refresh: { status: availability, reason },
  };
}

function buildRefreshCandidate(
  record: OutcomeRecord,
  cards: Awaited<ReturnType<typeof readAuthorizedWorkboardCards>>,
  observedAt: number,
): RefreshCandidate {
  const cardsById = new Map<string, typeof cards>();
  for (const card of cards) cardsById.set(card.id, [...(cardsById.get(card.id) ?? []), card]);
  const refs = record.criteria
    .flatMap((criterion) => criterion.workRefs)
    .filter(
      (ref, index, all) =>
        all.findIndex((item) => workRefIdentity(item) === workRefIdentity(ref)) === index,
    );
  const matchedCards = new Map<string, (typeof cards)[number]>();
  const unavailable = new Map<string, RefreshReason>();
  for (const ref of refs) {
    const candidates = cardsById.get(ref.cardId) ?? [];
    const exact = candidates.filter((card) => card.createdAt === ref.cardCreatedAt);
    if (candidates.length !== 1 || exact.length !== 1) {
      unavailable.set(
        workRefIdentity(ref),
        candidates.length === 0 ? "not-found" : "identity-conflict",
      );
      continue;
    }
    matchedCards.set(workRefIdentity(ref), exact[0]!);
  }

  const evidence: EvidenceRef[] = [];
  for (const criterion of record.criteria) {
    for (const ref of criterion.workRefs) {
      const card = matchedCards.get(workRefIdentity(ref));
      if (card !== undefined) {
        evidence.push(
          ...extractWorkboardEvidence({
            criterionId: criterion.id,
            planGeneration: record.planGeneration,
            observedAt,
            workRef: ref,
            card,
          }),
        );
      }
    }
  }
  const projections = refs.map((ref) => {
    const identity = workRefIdentity(ref);
    const reason = unavailable.get(identity);
    if (reason !== undefined) {
      return {
        ref,
        availability:
          reason === "identity-conflict"
            ? ("identity-conflict" as const)
            : ("unavailable" as const),
        observedAt,
        proofs: [],
        artifacts: [],
        errorCode: reason,
      };
    }
    const card = matchedCards.get(identity)!;
    const cardEvidence = evidence.filter((item) => workRefIdentity(item.workRef) === identity);
    const proofs = uniqueSourcePairs(
      cardEvidence
        .filter((item) => item.kind === "workboard-proof")
        .map((item) => ({ sourceId: item.sourceId, digest: item.sourceDigest })),
    );
    const artifacts = uniqueSourcePairs(
      cardEvidence
        .filter((item) => item.kind === "workboard-artifact")
        .map((item) => ({ sourceId: item.sourceId, digest: item.sourceDigest })),
    );
    return {
      ref,
      availability: "available" as const,
      observedAt,
      proofs,
      artifacts,
      currentBoardId: card.boardId,
      status: card.status,
      sourceUpdatedAt: card.updatedAt,
      lastSuccessfulAt: observedAt,
      upstreamStale: card.upstreamStale,
      sourceFingerprint: workboardProjectionFingerprint({
        ref,
        proofs,
        artifacts,
        currentBoardId: card.boardId,
        status: card.status,
        sourceUpdatedAt: card.updatedAt,
      }),
    };
  });
  const identityConflict = projections.some(
    (projection) => projection.availability === "identity-conflict",
  );
  const unavailableProjection = projections.find(
    (projection) => projection.availability === "unavailable",
  );
  const authorizedSources: AuthorizedOutcomeSource[] = projections.flatMap((projection) => {
    if (projection.availability !== "available") return [];
    const card = matchedCards.get(workRefIdentity(projection.ref));
    if (card === undefined) return [];
    const evidenceViews = evidence
      .filter((item) => workRefIdentity(item.workRef) === workRefIdentity(projection.ref))
      .flatMap((item) => {
        if (item.kind === "workboard-proof") {
          const proof = card.proofs.find((candidate) => candidate.id === item.sourceId);
          if (proof === undefined) return [];
          const url = publicSourceUrl(proof.url);
          return [
            {
              ...item,
              sourceCreatedAt: proof.createdAt,
              ...(proof.label === undefined ? {} : { label: proof.label }),
              proofStatus: proof.status,
              ...(url === undefined ? {} : { url }),
            },
          ];
        }
        const artifact = card.artifacts.find((candidate) => candidate.id === item.sourceId);
        if (artifact === undefined) return [];
        const url = publicSourceUrl(artifact.url);
        return [
          {
            ...item,
            sourceCreatedAt: artifact.createdAt,
            ...(artifact.label === undefined ? {} : { label: artifact.label }),
            ...(url === undefined ? {} : { url }),
            ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
          },
        ];
      });
    return [
      {
        ref: projection.ref,
        currentBoardId: card.boardId,
        status: card.status,
        sourceUpdatedAt: card.updatedAt,
        upstreamStale: card.upstreamStale,
        evidence: evidenceViews,
      },
    ];
  });
  return {
    projections,
    evidence,
    authorizedSources,
    refresh: identityConflict
      ? { status: "identity-conflict", reason: "identity-conflict" }
      : unavailableProjection === undefined
        ? { status: "available" }
        : { status: "unavailable", reason: unavailableProjection.errorCode },
  };
}

/** Register the P-02 first package; every persisted access is scoped to the authenticated owner. */
export function registerOutcomeFirstPackageMethods(api: OpenClawPluginApi): void {
  const repository = createOutcomeRepository(
    api.runtime.state.openKeyedStore<OutcomeRecord>(OUTCOME_STORE),
    { onCapacityWarning: (warning) => reportCapacityWarning(api, warning) },
  );
  api.registerGatewayMethod(
    "outcomes.create",
    async ({ client, params, respond }) => {
      if (!Value.Check(outcomeCreateParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
      const request = normalizeCreate(params);
      const owner = authenticatedProfileId(client);
      if (!request || !owner) return fail(respond, "INVALID_REQUEST");
      const now = Date.now();
      const criteria = request.criteria.map((criterion) => ({ ...criterion, workRefs: [] }));
      const record: OutcomeRecord = {
        schemaVersion: 1,
        id: request.id,
        createRequestHash: createRequestHash({ ...request, criteria }),
        managerProfileId: owner,
        title: request.title,
        objective: request.objective,
        phase: "draft",
        revision: 1,
        contractRevision: 1,
        planGeneration: 0,
        planHash: null,
        criteria,
        projections: [],
        evidence: [],
        decisions: [],
        operations: [],
        acceptances: [],
        createdAt: now,
        updatedAt: now,
      };
      try {
        const result = await repository.createOwned(owner, record);
        respond(true, {
          outcome: toOutcomeDetail(result.record, now),
          replayed: result.replayed,
          receipt: { kind: "create", id: result.record.id, committedRevision: 1 },
        });
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "create")));
      }
    },
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "outcomes.get",
    async ({ client, params, respond }) => {
      if (!Value.Check(outcomeIdParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
      const owner = authenticatedProfileId(client);
      const id = normalizedUuid(params.id);
      if (!owner || !id) return fail(respond, "NOT_FOUND");
      try {
        const record = await repository.getOwned(owner, id);
        if (!record) return fail(respond, "NOT_FOUND");
        const now = Date.now();
        if (record.criteria.every((criterion) => criterion.workRefs.length === 0)) {
          respond(true, { outcome: toOutcomeDetail(record, now) });
          return;
        }
        let candidate: RefreshCandidate;
        try {
          candidate = buildRefreshCandidate(record, await readAuthorizedWorkboardCards(api), now);
        } catch (error) {
          candidate = unavailableRefresh(record, now, refreshReason(error));
        }
        respond(true, {
          outcome: toOutcomeDetail(record, now, candidate.authorizedSources, candidate.projections),
        });
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "read")));
      }
    },
    { scope: "operator.read" },
  );
  api.registerGatewayMethod(
    "outcomes.list",
    async ({ client, params, respond }) => {
      if (!Value.Check(outcomeListParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
      const owner = authenticatedProfileId(client);
      if (!owner) return fail(respond, "NOT_FOUND");
      const cursor =
        params.cursor === undefined ? undefined : decodeOutcomeCursor(owner, params.cursor);
      if (params.cursor !== undefined && !cursor) return fail(respond, "INVALID_CURSOR");
      try {
        const eligible = (await repository.listOwned(owner)).filter(
          (record) =>
            !cursor ||
            record.updatedAt < cursor.updatedAt ||
            (record.updatedAt === cursor.updatedAt && record.id > cursor.id),
        );
        const page = eligible.slice(0, params.limit ?? 25);
        const now = Date.now();
        respond(true, {
          outcomes: page.map((record) => toOutcomeSummary(record, now)),
          ...(eligible.length > page.length && page.at(-1)
            ? { nextCursor: encodeOutcomeCursor(owner, page.at(-1)!) }
            : {}),
        });
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "read")));
      }
    },
    { scope: "operator.read" },
  );
  api.registerGatewayMethod(
    "outcomes.update",
    async ({ client, params, respond }) => {
      if (!Value.Check(outcomeUpdateParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
      const request = normalizePatch(params);
      const owner = authenticatedProfileId(client);
      if (!request || !owner) return fail(respond, "INVALID_REQUEST");
      const now = Date.now();
      try {
        const decision = await repository.transactOwned(owner, request.id, (current) => {
          const mutation = reduceOutcomePatch(current, {
            expectedRevision: request.expectedRevision,
            ...(request.patch.title === undefined ? {} : { title: request.patch.title }),
            ...(request.patch.objective === undefined
              ? {}
              : { objective: request.patch.objective }),
            ...(request.patch.criteria === undefined
              ? {}
              : { criteria: withRefs(request.patch.criteria, current.criteria) }),
            serverTime: now,
          });
          return {
            result: mutation,
            ...(mutation.kind === "updated" ? { next: mutation.record } : {}),
          };
        });
        respondMutation(respond, decision, now);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation")));
      }
    },
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "outcomes.linkWorkboard",
    async ({ client, params, respond }) => {
      if (!Value.Check(outcomeWorkboardLinkParamsSchema, params))
        return fail(respond, "INVALID_REQUEST");
      const request = normalizeWorkboardLink(params);
      const owner = authenticatedProfileId(client);
      if (!request || !owner) return fail(respond, "INVALID_REQUEST");
      let record: OutcomeRecord | undefined;
      try {
        record = await repository.getOwned(owner, request.id);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "read")));
        return;
      }
      if (!record) return fail(respond, "NOT_FOUND");
      if (record.revision !== request.expectedRevision) return fail(respond, "REVISION_CONFLICT");
      if (record.phase === "cancelled") return fail(respond, "INVALID_STATE");
      let card: Awaited<ReturnType<typeof readAuthorizedWorkboardCard>>;
      try {
        card = await readAuthorizedWorkboardCard(api, request.cardId);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeOwnerError(error)));
        return;
      }
      if (!card) return fail(respond, "OWNER_UNAVAILABLE");
      try {
        const now = Date.now();
        const decision = await repository.transactOwned(owner, request.id, (current) => {
          const mutation = reduceOutcomeLink(current, {
            expectedRevision: request.expectedRevision,
            criterionId: request.criterionId,
            ref: {
              owner: "workboard",
              cardId: card.id,
              cardCreatedAt: card.createdAt,
              boardIdAtLink: card.boardId,
            },
            serverTime: now,
          });
          return {
            result: mutation,
            ...(mutation.kind === "updated" ? { next: mutation.record } : {}),
          };
        });
        respondMutation(respond, decision, now);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation")));
      }
    },
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "outcomes.unlinkWorkboard",
    async ({ client, params, respond }) => {
      if (!Value.Check(outcomeWorkboardUnlinkParamsSchema, params))
        return fail(respond, "INVALID_REQUEST");
      const request = normalizeWorkboardLink(params);
      const owner = authenticatedProfileId(client);
      if (!request || !owner) return fail(respond, "INVALID_REQUEST");
      let record: OutcomeRecord | undefined;
      try {
        record = await repository.getOwned(owner, request.id);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "read")));
        return;
      }
      if (!record) return fail(respond, "NOT_FOUND");
      if (record.revision !== request.expectedRevision) return fail(respond, "REVISION_CONFLICT");
      if (record.phase === "cancelled") return fail(respond, "INVALID_STATE");
      let card: Awaited<ReturnType<typeof readAuthorizedWorkboardCard>>;
      try {
        card = await readAuthorizedWorkboardCard(api, request.cardId);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeOwnerError(error)));
        return;
      }
      if (!card) return fail(respond, "OWNER_UNAVAILABLE");
      try {
        const now = Date.now();
        const decision = await repository.transactOwned(owner, request.id, (current) => {
          const mutation = reduceOutcomeUnlink(current, {
            expectedRevision: request.expectedRevision,
            criterionId: request.criterionId,
            ref: {
              owner: "workboard",
              cardId: card.id,
              cardCreatedAt: card.createdAt,
              boardIdAtLink: card.boardId,
            },
            serverTime: now,
          });
          return {
            result: mutation,
            ...(mutation.kind === "updated" ? { next: mutation.record } : {}),
          };
        });
        respondMutation(respond, decision, now);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation")));
      }
    },
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "outcomes.activate",
    async ({ client, params, respond }) => {
      if (!Value.Check(outcomeActivateParamsSchema, params))
        return fail(respond, "INVALID_REQUEST");
      const owner = authenticatedProfileId(client);
      const id = normalizedUuid(params.id);
      if (!owner || !id) return fail(respond, "INVALID_REQUEST");
      const now = Date.now();
      try {
        const decision = await repository.transactOwned(owner, id, (current) => {
          const mutation = reduceOutcomeActivate(current, params.expectedRevision, now);
          return {
            result: mutation,
            ...(mutation.kind === "updated" ? { next: mutation.record } : {}),
          };
        });
        respondMutation(respond, decision, now);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation")));
      }
    },
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "outcomes.refresh",
    async ({ client, params, respond }) => {
      if (!Value.Check(outcomeRefreshParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
      const owner = authenticatedProfileId(client);
      const id = normalizedUuid(params.id);
      if (!owner || !id) return fail(respond, "INVALID_REQUEST");

      let record: OutcomeRecord | undefined;
      try {
        record = await repository.getOwned(owner, id);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "read")));
        return;
      }
      if (!record) return fail(respond, "NOT_FOUND");
      if (params.expectedRevision !== record.revision) return fail(respond, "REVISION_CONFLICT");
      if (record.phase === "cancelled") return fail(respond, "INVALID_STATE");

      const now = Date.now();
      let candidate: RefreshCandidate;
      if (record.criteria.every((criterion) => criterion.workRefs.length === 0)) {
        candidate = {
          projections: [],
          evidence: [],
          authorizedSources: [],
          refresh: { status: "available" },
        };
      } else {
        try {
          candidate = buildRefreshCandidate(record, await readAuthorizedWorkboardCards(api), now);
        } catch (error) {
          candidate = unavailableRefresh(record, now, refreshReason(error));
        }
      }
      try {
        const decision = await repository.transactOwned(owner, id, (current) => {
          const mutation = reduceOutcomeRefresh(current, {
            expectedRevision: params.expectedRevision,
            projections: candidate.projections,
            evidence: candidate.evidence,
            serverTime: now,
          });
          return {
            result: mutation,
            ...(mutation.kind === "updated" ? { next: mutation.record } : {}),
          };
        });
        if (decision.kind === "updated" || decision.kind === "noop") {
          respond(true, {
            outcome: toOutcomeDetail(
              decision.record,
              now,
              candidate.authorizedSources,
              candidate.projections,
            ),
            refresh: candidate.refresh,
          });
          return;
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
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation")));
      }
    },
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "outcomes.cancel",
    async ({ client, params, respond }) => {
      if (!Value.Check(outcomeCancelParamsSchema, params)) return fail(respond, "INVALID_REQUEST");
      const owner = authenticatedProfileId(client);
      const id = normalizedUuid(params.id);
      if (!owner || !id) return fail(respond, "INVALID_REQUEST");
      const now = Date.now();
      try {
        const decision = await repository.transactOwned(owner, id, (current) => {
          const mutation = reduceOutcomeCancel(current, params.expectedRevision, now);
          return {
            result: mutation,
            ...(mutation.kind === "updated" ? { next: mutation.record } : {}),
          };
        });
        respondMutation(respond, decision, now);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation")));
      }
    },
    { scope: "operator.write" },
  );
}
