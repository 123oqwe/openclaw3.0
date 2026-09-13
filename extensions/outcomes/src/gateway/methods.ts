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
import { admitOutcomeOwner } from "./admission.js";
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
import { fail, reportCapacityWarning, respondMutation } from "./method-helpers.js";
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
  findAuthorizedWorkboardCard,
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

async function mutationPresentation(
  api: OpenClawPluginApi,
  decision: { kind: "updated" | "noop" | "conflict" | "rejected"; record: OutcomeRecord },
  now: number,
  authorizedCards?: Awaited<ReturnType<typeof readAuthorizedWorkboardCards>>,
) {
  if (
    (decision.kind !== "updated" && decision.kind !== "noop") ||
    decision.record.criteria.every((criterion) => criterion.workRefs.length === 0)
  ) {
    return undefined;
  }
  try {
    const candidate = buildRefreshCandidate(
      decision.record,
      authorizedCards ?? (await readAuthorizedWorkboardCards(api)),
      now,
    );
    return {
      authorizedSources: candidate.authorizedSources,
      projections: candidate.projections,
    };
  } catch (error) {
    const candidate = unavailableRefresh(decision.record, now, refreshReason(error));
    return {
      authorizedSources: candidate.authorizedSources,
      projections: candidate.projections,
    };
  }
}

/** Register the P-02 first package; every persisted access is scoped to the authenticated owner. */
export function registerOutcomeFirstPackageMethods(api: OpenClawPluginApi): void {
  const repository = createOutcomeRepository(
    api.runtime.state.openKeyedStore<OutcomeRecord>(OUTCOME_STORE),
    { onCapacityWarning: (warning) => reportCapacityWarning(api, warning) },
  );
  api.registerGatewayMethod(
    "outcomes.create",
    async ({ client, params: rawParams, respond }) => {
      const admission = admitOutcomeOwner({
        client,
        missingOwnerCode: "INVALID_REQUEST",
        request: rawParams,
        respond,
        schema: outcomeCreateParamsSchema,
      });
      if (!admission) {
        return;
      }
      const { owner, request: params } = admission;
      const request = normalizeCreate(params);
      if (!request) {
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
    async ({ client, params: rawParams, respond }) => {
      const admission = admitOutcomeOwner({
        client,
        missingOwnerCode: "NOT_FOUND",
        request: rawParams,
        respond,
        schema: outcomeIdParamsSchema,
      });
      if (!admission) {
        return;
      }
      const { owner, request: params } = admission;
      const id = normalizedUuid(params.id);
      if (!id) {
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
    async ({ client, params: rawParams, respond }) => {
      const admission = admitOutcomeOwner({
        client,
        missingOwnerCode: "NOT_FOUND",
        request: rawParams,
        respond,
        schema: outcomeListParamsSchema,
      });
      if (!admission) {
        return;
      }
      const { owner, request: params } = admission;
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
    async ({ client, params: rawParams, respond }) => {
      const admission = admitOutcomeOwner({
        client,
        missingOwnerCode: "INVALID_REQUEST",
        request: rawParams,
        respond,
        schema: outcomeUpdateParamsSchema,
      });
      if (!admission) {
        return;
      }
      const { owner, request: params } = admission;
      const request = normalizePatch(params);
      if (!request) {
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
        respondMutation(respond, decision, now, await mutationPresentation(api, decision, now));
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation")));
      }
    },
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "outcomes.linkWorkboard",
    async ({ client, params: rawParams, respond }) => {
      const admission = admitOutcomeOwner({
        client,
        missingOwnerCode: "INVALID_REQUEST",
        request: rawParams,
        respond,
        schema: outcomeWorkboardLinkParamsSchema,
      });
      if (!admission) {
        return;
      }
      const { owner, request: params } = admission;
      const request = normalizeWorkboardLink(params);
      if (!request) {
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
      let cards: Awaited<ReturnType<typeof readAuthorizedWorkboardCards>> | undefined;
      let card: Awaited<ReturnType<typeof readAuthorizedWorkboardCards>>[number] | undefined;
      try {
        cards = await readAuthorizedWorkboardCards(api);
        card = findAuthorizedWorkboardCard(cards, request.cardId);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeOwnerError(error)));
        return;
      }
      if (!cards || !card) {
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
        respondMutation(
          respond,
          decision,
          now,
          await mutationPresentation(api, decision, now, cards),
        );
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation")));
      }
    },
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "outcomes.unlinkWorkboard",
    async ({ client, params: rawParams, respond }) => {
      const admission = admitOutcomeOwner({
        client,
        missingOwnerCode: "INVALID_REQUEST",
        request: rawParams,
        respond,
        schema: outcomeWorkboardUnlinkParamsSchema,
      });
      if (!admission) {
        return;
      }
      const { owner, request: params } = admission;
      const request = normalizeWorkboardLink(params);
      if (!request) {
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
        respondMutation(respond, decision, now, await mutationPresentation(api, decision, now));
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation")));
      }
    },
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "outcomes.activate",
    async ({ client, params: rawParams, respond }) => {
      const admission = admitOutcomeOwner({
        client,
        missingOwnerCode: "INVALID_REQUEST",
        request: rawParams,
        respond,
        schema: outcomeActivateParamsSchema,
      });
      if (!admission) {
        return;
      }
      const { owner, request: params } = admission;
      const id = normalizedUuid(params.id);
      if (!id) {
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
        respondMutation(respond, decision, now, await mutationPresentation(api, decision, now));
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation")));
      }
    },
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "outcomes.refresh",
    async ({ client, params: rawParams, respond }) => {
      const admission = admitOutcomeOwner({
        client,
        missingOwnerCode: "INVALID_REQUEST",
        request: rawParams,
        respond,
        schema: outcomeRefreshParamsSchema,
      });
      if (!admission) {
        return;
      }
      const { owner, request: params } = admission;
      const id = normalizedUuid(params.id);
      if (!id) {
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
    async ({ client, params: rawParams, respond }) => {
      const admission = admitOutcomeOwner({
        client,
        missingOwnerCode: "INVALID_REQUEST",
        request: rawParams,
        respond,
        schema: outcomeCancelParamsSchema,
      });
      if (!admission) {
        return;
      }
      const { owner, request: params } = admission;
      const id = normalizedUuid(params.id);
      if (!id) {
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
        respondMutation(respond, decision, now, await mutationPresentation(api, decision, now));
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation")));
      }
    },
    { scope: "operator.write" },
  );
}
