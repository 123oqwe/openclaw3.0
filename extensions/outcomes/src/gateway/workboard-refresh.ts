import type { OutcomeRefreshStatus, OutcomeSourceIssueReason } from "@openclaw/outcomes-contract";
import type { OpenClawPluginApi } from "../../api.js";
import {
  WorkboardIdentityConflictError,
  readWorkboardCards,
} from "../adapters/workboard-adapter.js";
import { extractWorkboardEvidence } from "../assurance/evidence.js";
import { workboardProjectionFingerprint } from "../domain/hash.js";
import type { AuthorizedOutcomeSource } from "../domain/read-model.js";
import type { EvidenceRef, OutcomeRecord, WorkProjection, WorkboardRef } from "../domain/types.js";
import { OutcomeErrorCodes, outcomeOwnerError } from "./errors.js";

export function findAuthorizedWorkboardCard(
  cards: Awaited<ReturnType<typeof readAuthorizedWorkboardCards>>,
  cardId: string,
) {
  const matches = cards.filter((card) => card.id === cardId);
  if (matches.length > 1) {
    throw new WorkboardIdentityConflictError();
  }
  return matches[0];
}

class InvalidWorkboardResponseError extends Error {
  constructor() {
    super("invalid Workboard response");
    this.name = "InvalidWorkboardResponseError";
  }
}

export async function readAuthorizedWorkboardCards(api: OpenClawPluginApi) {
  const response = await api.runtime.gateway.request(
    "workboard.cards.list",
    {},
    { scopes: ["operator.read"], requireAuthenticatedRequest: true, timeoutMs: 10_000 },
  );
  try {
    return readWorkboardCards(response);
  } catch (error) {
    if (error instanceof WorkboardIdentityConflictError) {
      throw error;
    }
    throw new InvalidWorkboardResponseError();
  }
}

type RefreshReason = OutcomeSourceIssueReason;
type RefreshSummary = { status: OutcomeRefreshStatus; reason?: RefreshReason };
export type RefreshCandidate = {
  projections: WorkProjection[];
  evidence: EvidenceRef[];
  authorizedSources: AuthorizedOutcomeSource[];
  visibleHistoricalRefs: WorkboardRef[];
  refresh: RefreshSummary;
};

function workRefIdentity(ref: WorkboardRef): string {
  return `${ref.cardId}\0${ref.cardCreatedAt}`;
}

function uniqueWorkRefs(refs: WorkboardRef[]): WorkboardRef[] {
  return refs.filter(
    (ref, index) =>
      refs.findIndex((item) => workRefIdentity(item) === workRefIdentity(ref)) === index,
  );
}

function historicalWorkRefs(record: OutcomeRecord): WorkboardRef[] {
  return uniqueWorkRefs(
    [...record.decisions, ...record.acceptances].flatMap((entry) =>
      "decidedPlan" in entry
        ? entry.decidedPlan.criteria.flatMap((criterion) => criterion.workRefs)
        : entry.acceptedPlan.criteria.flatMap((criterion) => criterion.workRefs),
    ),
  );
}

export function hasOutcomeSourcePresentationRefs(record: OutcomeRecord): boolean {
  return (
    record.criteria.some((criterion) => criterion.workRefs.length > 0) ||
    historicalWorkRefs(record).length > 0
  );
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
  if (value === undefined) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function refreshReason(error: unknown): RefreshReason {
  if (error instanceof WorkboardIdentityConflictError) {
    return "identity-conflict";
  }
  if (error instanceof InvalidWorkboardResponseError) {
    return "invalid-response";
  }
  switch (outcomeOwnerError(error)) {
    case OutcomeErrorCodes.OWNER_FORBIDDEN:
      return "forbidden";
    case OutcomeErrorCodes.OWNER_TIMEOUT:
      return "timeout";
    default:
      return "workboard-disabled";
  }
}

export function unavailableRefresh(
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
    visibleHistoricalRefs: [],
    refresh: { status: availability, reason },
  };
}

export function buildRefreshCandidate(
  record: OutcomeRecord,
  cards: Awaited<ReturnType<typeof readAuthorizedWorkboardCards>>,
  observedAt: number,
): RefreshCandidate {
  const cardsById = new Map<string, typeof cards>();
  for (const card of cards) {
    cardsById.set(card.id, [...(cardsById.get(card.id) ?? []), card]);
  }
  const refs = uniqueWorkRefs(record.criteria.flatMap((criterion) => criterion.workRefs));
  const historicRefs = historicalWorkRefs(record);
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
    if (projection.availability !== "available") {
      return [];
    }
    const card = matchedCards.get(workRefIdentity(projection.ref));
    if (card === undefined) {
      return [];
    }
    const evidenceViews: AuthorizedOutcomeSource["evidence"] = [];
    for (const item of evidence) {
      if (workRefIdentity(item.workRef) !== workRefIdentity(projection.ref)) {
        continue;
      }
      if (item.kind === "workboard-proof") {
        const proof = card.proofs.find((candidate) => candidate.id === item.sourceId);
        if (proof === undefined) {
          continue;
        }
        const url = publicSourceUrl(proof.url);
        evidenceViews.push({
          ...item,
          sourceCreatedAt: proof.createdAt,
          ...(proof.label === undefined ? {} : { label: proof.label }),
          proofStatus: proof.status,
          ...(url === undefined ? {} : { url }),
        });
        continue;
      }
      const artifact = card.artifacts.find((candidate) => candidate.id === item.sourceId);
      if (artifact === undefined) {
        continue;
      }
      const url = publicSourceUrl(artifact.url);
      evidenceViews.push({
        ...item,
        sourceCreatedAt: artifact.createdAt,
        ...(artifact.label === undefined ? {} : { label: artifact.label }),
        ...(url === undefined ? {} : { url }),
        ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
      });
    }
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
  const visibleHistoricalRefs = historicRefs.filter((ref) => {
    const candidates = cardsById.get(ref.cardId) ?? [];
    return candidates.length === 1 && candidates[0]!.createdAt === ref.cardCreatedAt;
  });
  return {
    projections,
    evidence,
    authorizedSources,
    visibleHistoricalRefs,
    refresh: identityConflict
      ? { status: "identity-conflict", reason: "identity-conflict" }
      : unavailableProjection === undefined
        ? { status: "available" }
        : { status: "unavailable", reason: unavailableProjection.errorCode },
  };
}
