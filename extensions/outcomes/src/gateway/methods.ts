import { Value } from "typebox/value";
import type { OpenClawPluginApi } from "../../api.js";
import { OUTCOME_MAX_ENTRIES, OUTCOME_OVERFLOW_POLICY } from "../domain/constants.js";
import { createRequestHash } from "../domain/hash.js";
import { toOutcomeDetail, toOutcomeSummary } from "../domain/read-model.js";
import {
  reduceOutcomeActivate,
  reduceOutcomeCancel,
  reduceOutcomeLink,
  reduceOutcomeRefresh,
  reduceOutcomeUnlink,
} from "../domain/reducer.js";
import type { OutcomeRecord } from "../domain/types.js";
import { createOutcomeRepository } from "../store/plugin-state-repository.js";
import { decodeOutcomeCursor, encodeOutcomeCursor } from "./cursor.js";
import {
  OutcomeErrorCodes,
  outcomeError,
  outcomeOwnerError,
  outcomeStorageError,
} from "./errors.js";
import {
  normalizeCreate,
  normalizePatch,
  normalizeWorkboardLink,
  normalizedUuid,
  withRefs,
} from "./input-normalizers.js";
import {
  authenticatedProfileId,
  fail,
  reportCapacityWarning,
  respondMutation,
} from "./method-helpers.js";
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
import { reduceGatewayOutcomePatch } from "./update-reducer.js";
import {
  buildRefreshCandidate,
  readAuthorizedWorkboardCard,
  readAuthorizedWorkboardCards,
  refreshReason,
  unavailableRefresh,
  type RefreshCandidate,
} from "./workboard-refresh.js";

const OUTCOME_STORE = {
  namespace: "outcomes-v1",
  maxEntries: OUTCOME_MAX_ENTRIES,
  overflowPolicy: OUTCOME_OVERFLOW_POLICY,
};

/** Register the P-02 first package; every persisted access is scoped to the authenticated owner. */
export function registerOutcomeFirstPackageMethods(api: OpenClawPluginApi): void {
  const repository = createOutcomeRepository(
    api.runtime.state.openKeyedStore<OutcomeRecord>(OUTCOME_STORE),
    { onCapacityWarning: (warning) => reportCapacityWarning(api, warning) },
  );
  api.registerGatewayMethod(
    "outcomes.create",
    async ({ client, params, respond }) => {
      if (!Value.Check(outcomeCreateParamsSchema, params)) {
        return fail(respond, "INVALID_REQUEST");
      }
      const request = normalizeCreate(params);
      const owner = authenticatedProfileId(client);
      if (!request || !owner) {
        return fail(respond, "INVALID_REQUEST");
      }
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
      if (!Value.Check(outcomeIdParamsSchema, params)) {
        return fail(respond, "INVALID_REQUEST");
      }
      const owner = authenticatedProfileId(client);
      const id = normalizedUuid(params.id);
      if (!owner || !id) {
        return fail(respond, "NOT_FOUND");
      }
      try {
        const record = await repository.getOwned(owner, id);
        if (!record) {
          return fail(respond, "NOT_FOUND");
        }
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
      if (!Value.Check(outcomeListParamsSchema, params)) {
        return fail(respond, "INVALID_REQUEST");
      }
      const owner = authenticatedProfileId(client);
      if (!owner) {
        return fail(respond, "NOT_FOUND");
      }
      const cursor =
        params.cursor === undefined ? undefined : decodeOutcomeCursor(owner, params.cursor);
      if (params.cursor !== undefined && !cursor) {
        return fail(respond, "INVALID_CURSOR");
      }
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
      if (!Value.Check(outcomeUpdateParamsSchema, params)) {
        return fail(respond, "INVALID_REQUEST");
      }
      const request = normalizePatch(params);
      const owner = authenticatedProfileId(client);
      if (!request || !owner) {
        return fail(respond, "INVALID_REQUEST");
      }
      const now = Date.now();
      try {
        const decision = await repository.transactOwned(owner, request.id, (current) => {
          const mutation = reduceGatewayOutcomePatch(current, {
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
      if (!Value.Check(outcomeWorkboardLinkParamsSchema, params)) {
        return fail(respond, "INVALID_REQUEST");
      }
      const request = normalizeWorkboardLink(params);
      const owner = authenticatedProfileId(client);
      if (!request || !owner) {
        return fail(respond, "INVALID_REQUEST");
      }
      let record: OutcomeRecord | undefined;
      try {
        record = await repository.getOwned(owner, request.id);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "read")));
        return;
      }
      if (!record) {
        return fail(respond, "NOT_FOUND");
      }
      if (record.revision !== request.expectedRevision) {
        return fail(respond, "REVISION_CONFLICT");
      }
      if (record.phase === "cancelled") {
        return fail(respond, "INVALID_STATE");
      }
      let card: Awaited<ReturnType<typeof readAuthorizedWorkboardCard>>;
      try {
        card = await readAuthorizedWorkboardCard(api, request.cardId);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeOwnerError(error)));
        return;
      }
      if (!card) {
        return fail(respond, "OWNER_UNAVAILABLE");
      }
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
      if (!Value.Check(outcomeWorkboardUnlinkParamsSchema, params)) {
        return fail(respond, "INVALID_REQUEST");
      }
      const request = normalizeWorkboardLink(params);
      const owner = authenticatedProfileId(client);
      if (!request || !owner) {
        return fail(respond, "INVALID_REQUEST");
      }
      try {
        const now = Date.now();
        const decision = await repository.transactOwned(owner, request.id, (current) => {
          const mutation = reduceOutcomeUnlink(current, {
            expectedRevision: request.expectedRevision,
            criterionId: request.criterionId,
            cardId: request.cardId,
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
      if (!Value.Check(outcomeActivateParamsSchema, params)) {
        return fail(respond, "INVALID_REQUEST");
      }
      const owner = authenticatedProfileId(client);
      const id = normalizedUuid(params.id);
      if (!owner || !id) {
        return fail(respond, "INVALID_REQUEST");
      }
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
      if (!Value.Check(outcomeRefreshParamsSchema, params)) {
        return fail(respond, "INVALID_REQUEST");
      }
      const owner = authenticatedProfileId(client);
      const id = normalizedUuid(params.id);
      if (!owner || !id) {
        return fail(respond, "INVALID_REQUEST");
      }

      let record: OutcomeRecord | undefined;
      try {
        record = await repository.getOwned(owner, id);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "read")));
        return;
      }
      if (!record) {
        return fail(respond, "NOT_FOUND");
      }
      if (params.expectedRevision !== record.revision) {
        return fail(respond, "REVISION_CONFLICT");
      }
      if (record.phase === "cancelled") {
        return fail(respond, "INVALID_STATE");
      }

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
      if (!Value.Check(outcomeCancelParamsSchema, params)) {
        return fail(respond, "INVALID_REQUEST");
      }
      const owner = authenticatedProfileId(client);
      const id = normalizedUuid(params.id);
      if (!owner || !id) {
        return fail(respond, "INVALID_REQUEST");
      }
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
