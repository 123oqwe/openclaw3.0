import type { OpenClawPluginApi } from "../../api.js";
import {
  outcomeAcceptanceRequestHash,
  outcomeDecisionRequestHash,
} from "../assurance/closure.js";
import {
  reduceOutcomeAcceptance,
  reduceOutcomeDecision,
} from "../domain/assurance-reducer.js";
import { toOutcomeDetail } from "../domain/read-model.js";
import type { OutcomeRecord } from "../domain/types.js";
import type { OutcomeRepository } from "../store/outcome-repository.js";
import { admitOutcomeOwner } from "./admission.js";
import {
  OutcomeErrorCodes,
  outcomeError,
  outcomeOwnerError,
  outcomeStorageError,
} from "./errors.js";
import { normalizeAccept, normalizeVerifyCriterion } from "./input-normalizers.js";
import { fail, type GatewayRespond } from "./method-helpers.js";
import { outcomeAcceptParamsSchema, outcomeVerifyCriterionParamsSchema } from "./schemas.js";
import {
  buildRefreshCandidate,
  hasOutcomeSourcePresentationRefs,
  readAuthorizedWorkboardCards,
  refreshReason,
  unavailableRefresh,
  type RefreshCandidate,
} from "./workboard-refresh.js";

async function assurancePresentation(
  api: OpenClawPluginApi,
  record: OutcomeRecord,
  now: number,
): Promise<RefreshCandidate | undefined> {
  if (!hasOutcomeSourcePresentationRefs(record)) {
    return undefined;
  }
  try {
    return buildRefreshCandidate(record, await readAuthorizedWorkboardCards(api), now);
  } catch (error) {
    return unavailableRefresh(record, now, refreshReason(error));
  }
}

function respondAssuranceMutation(
  respond: GatewayRespond,
  decision: {
    kind: "updated" | "conflict" | "rejected";
    reason?:
      | "operation-conflict"
      | "revision-conflict"
      | "invalid-state"
      | "closure-incomplete"
      | "capacity-exceeded";
    replayed: boolean;
    record: OutcomeRecord;
  },
  now: number,
  candidate: RefreshCandidate,
  receipt: { kind: "verify-criterion" | "accept"; id: string; committedRevision: number },
): void {
  if (decision.kind === "updated") {
    respond(true, {
      outcome: toOutcomeDetail(
        decision.record,
        now,
        candidate.authorizedSources,
        candidate.projections,
        candidate.evidence,
        candidate.visibleHistoricalRefs,
      ),
      replayed: decision.replayed,
      receipt,
    });
    return;
  }
  respond(
    false,
    undefined,
    outcomeError(
      decision.reason === "operation-conflict"
        ? OutcomeErrorCodes.OPERATION_CONFLICT
        : decision.reason === "revision-conflict" || decision.kind === "conflict"
          ? OutcomeErrorCodes.REVISION_CONFLICT
          : decision.reason === "invalid-state"
            ? OutcomeErrorCodes.INVALID_STATE
            : decision.reason === "capacity-exceeded"
              ? OutcomeErrorCodes.CAPACITY_EXCEEDED
              : OutcomeErrorCodes.CLOSURE_INCOMPLETE,
    ),
  );
}

async function respondReplayedAssuranceMutation(
  api: OpenClawPluginApi,
  respond: GatewayRespond,
  record: OutcomeRecord,
  now: number,
  receipt: { kind: "verify-criterion" | "accept"; id: string; committedRevision: number },
): Promise<void> {
  const candidate = await assurancePresentation(api, record, now);
  respond(true, {
    outcome: toOutcomeDetail(
      record,
      now,
      candidate?.authorizedSources,
      candidate?.projections,
      candidate?.evidence,
      candidate?.visibleHistoricalRefs,
    ),
    replayed: true,
    receipt,
  });
}

/** Registers assurance writes against the registrar's single owner-scoped repository. */
export function registerOutcomeAssuranceMethods(
  api: OpenClawPluginApi,
  repository: OutcomeRepository,
): void {
  api.registerGatewayMethod(
    "outcomes.verifyCriterion",
    async ({ client, params: rawParams, respond }) => {
      const admission = admitOutcomeOwner({
        client,
        missingOwnerCode: "INVALID_REQUEST",
        request: rawParams,
        respond,
        schema: outcomeVerifyCriterionParamsSchema,
      });
      if (!admission) {
        return;
      }
      const { owner, request: params } = admission;
      const request = normalizeVerifyCriterion(params);
      if (!request) {
        return fail(respond, "INVALID_REQUEST");
      }
      const requestHash = outcomeDecisionRequestHash({
        id: request.id,
        decisionId: request.decisionId,
        criterionId: request.criterionId,
        status: request.status,
        planHash: request.planHash,
        evidenceSetHash: request.evidenceSetHash,
        ...(request.note === undefined ? {} : { note: request.note }),
      });
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
      const now = Date.now();
      const existing = record.decisions.find((decision) => decision.id === request.decisionId);
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) {
          return fail(respond, "OPERATION_CONFLICT");
        }
        await respondReplayedAssuranceMutation(api, respond, record, now, {
          kind: "verify-criterion",
          id: request.decisionId,
          committedRevision: existing.decidedRevision,
        });
        return;
      }
      let candidate: RefreshCandidate;
      try {
        candidate = buildRefreshCandidate(record, await readAuthorizedWorkboardCards(api), now);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeOwnerError(error)));
        return;
      }
      try {
        const decision = await repository.transactOwned(owner, request.id, (current) => {
          const mutation = reduceOutcomeDecision(current, {
            expectedRevision: request.expectedRevision,
            id: request.decisionId,
            requestHash,
            criterionId: request.criterionId,
            status: request.status,
            planHash: request.planHash,
            evidenceSetHash: request.evidenceSetHash,
            profileId: owner,
            ...(request.note === undefined ? {} : { note: request.note }),
            projections: candidate.projections,
            evidence: candidate.evidence,
            serverTime: now,
          });
          return {
            result: mutation,
            ...(mutation.kind === "updated" && !mutation.replayed ? { next: mutation.record } : {}),
          };
        });
        const committed = decision.replayed
          ? decision.record.decisions.find((item) => item.id === request.decisionId)?.decidedRevision
          : decision.record.revision;
        if (committed === undefined) {
          respond(false, undefined, outcomeError(OutcomeErrorCodes.INTERNAL));
          return;
        }
        respondAssuranceMutation(respond, decision, now, candidate, {
          kind: "verify-criterion",
          id: request.decisionId,
          committedRevision: committed,
        });
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation")));
      }
    },
    { scope: "operator.write" },
  );
  api.registerGatewayMethod(
    "outcomes.accept",
    async ({ client, params: rawParams, respond }) => {
      const admission = admitOutcomeOwner({
        client,
        missingOwnerCode: "INVALID_REQUEST",
        request: rawParams,
        respond,
        schema: outcomeAcceptParamsSchema,
      });
      if (!admission) {
        return;
      }
      const { owner, request: params } = admission;
      const request = normalizeAccept(params);
      if (!request) {
        return fail(respond, "INVALID_REQUEST");
      }
      const requestHash = outcomeAcceptanceRequestHash({
        id: request.id,
        acceptanceId: request.acceptanceId,
        planHash: request.planHash,
        closureHash: request.closureHash,
      });
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
      const now = Date.now();
      const existing = record.acceptances.find((acceptance) => acceptance.id === request.acceptanceId);
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) {
          return fail(respond, "OPERATION_CONFLICT");
        }
        await respondReplayedAssuranceMutation(api, respond, record, now, {
          kind: "accept",
          id: request.acceptanceId,
          committedRevision: existing.acceptedRevision,
        });
        return;
      }
      let candidate: RefreshCandidate;
      try {
        candidate = buildRefreshCandidate(record, await readAuthorizedWorkboardCards(api), now);
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeOwnerError(error)));
        return;
      }
      try {
        const decision = await repository.transactOwned(owner, request.id, (current) => {
          const mutation = reduceOutcomeAcceptance(current, {
            expectedRevision: request.expectedRevision,
            id: request.acceptanceId,
            requestHash,
            planHash: request.planHash,
            closureHash: request.closureHash,
            profileId: owner,
            projections: candidate.projections,
            evidence: candidate.evidence,
            serverTime: now,
          });
          return {
            result: mutation,
            ...(mutation.kind === "updated" && !mutation.replayed ? { next: mutation.record } : {}),
          };
        });
        const committed = decision.replayed
          ? decision.record.acceptances.find((item) => item.id === request.acceptanceId)?.acceptedRevision
          : decision.record.revision;
        if (committed === undefined) {
          respond(false, undefined, outcomeError(OutcomeErrorCodes.INTERNAL));
          return;
        }
        respondAssuranceMutation(respond, decision, now, candidate, {
          kind: "accept",
          id: request.acceptanceId,
          committedRevision: committed,
        });
      } catch (error) {
        respond(false, undefined, outcomeError(outcomeStorageError(error, "mutation")));
      }
    },
    { scope: "operator.write" },
  );
}
