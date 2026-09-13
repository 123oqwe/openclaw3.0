import type {
  OutcomeAttentionCode,
  OutcomeDetail,
  OutcomeNextAction,
} from "@openclaw/outcomes-contract";
import type { OutcomeRecord } from "../domain/types.js";
import {
  currentOutcomeDecision,
  currentOutcomeEvidenceSourceDigests,
  isStaleOutcomeProjection,
} from "./closure.js";

type CurrentProjection = OutcomeRecord["projections"][number];

export type OutcomeAssuranceGuidance = Pick<OutcomeDetail, "attention" | "nextActions">;

/**
 * Produces bounded operator guidance from persisted facts plus one authorized
 * observation. It records no state and never acts as an authorization token.
 */
export function deriveOutcomeAttention(
  record: OutcomeRecord,
  projections: CurrentProjection[],
  observedAt: number,
  closureHash: string | null,
): OutcomeAssuranceGuidance {
  if (record.phase === "cancelled") {
    const hasUncertainOperation = record.operations.some((operation) =>
      ["prepared", "may-have-crossed", "unknown"].includes(operation.state),
    );
    return { attention: [], nextActions: hasUncertainOperation ? [] : ["delete"] };
  }
  const attention: OutcomeDetail["attention"] = [];
  const nextActions: OutcomeNextAction[] = [];
  const addAttention = (code: OutcomeAttentionCode, criterionId?: string) => {
    if (!attention.some((item) => item.code === code && item.criterionId === criterionId)) {
      attention.push(criterionId === undefined ? { code } : { code, criterionId });
    }
  };
  const addAction = (action: OutcomeNextAction) => {
    if (!nextActions.includes(action)) {
      nextActions.push(action);
    }
  };
  const workRefIdentity = (ref: OutcomeRecord["criteria"][number]["workRefs"][number]) =>
    `${ref.cardId}\0${ref.cardCreatedAt}`;
  const projectionsByRef = new Map(
    projections.map((projection) => [workRefIdentity(projection.ref), projection]),
  );
  const hasUncertainOperation = record.operations.some((operation) =>
    ["prepared", "may-have-crossed", "unknown"].includes(operation.state),
  );
  let hasLinkedWork = false;
  for (const criterion of record.criteria) {
    const missingRequiredLink = criterion.required && criterion.workRefs.length === 0;
    if (record.phase === "draft" || missingRequiredLink) {
      addAttention("contract-incomplete", criterion.id);
    }
    if (criterion.workRefs.length > 0) {
      hasLinkedWork = true;
    }
    let sourceIsCurrent = criterion.workRefs.length > 0;
    for (const ref of criterion.workRefs) {
      const projection = projectionsByRef.get(workRefIdentity(ref));
      if (projection === undefined || projection.availability !== "available") {
        addAttention("owner-unavailable", criterion.id);
        addAction("refresh");
        sourceIsCurrent = false;
        continue;
      }
      if (isStaleOutcomeProjection(projection, observedAt)) {
        addAttention("stale", criterion.id);
        addAction("refresh");
        sourceIsCurrent = false;
        continue;
      }
      if (projection.status === "blocked") {
        addAttention("blocked", criterion.id);
        addAction("refresh");
        sourceIsCurrent = false;
      }
    }
    if (!sourceIsCurrent) {
      continue;
    }
    const sourceDigests = currentOutcomeEvidenceSourceDigests(
      record,
      criterion,
      projections,
      observedAt,
    );
    if (sourceDigests === undefined) {
      continue;
    }
    if (sourceDigests.length === 0) {
      addAttention("evidence-missing", criterion.id);
      addAction("refresh");
      if (record.phase === "active" || record.phase === "accepted") {
        addAction("review-evidence");
      }
      continue;
    }
    if (record.phase !== "active" && record.phase !== "accepted") {
      continue;
    }
    const currentDecision = currentOutcomeDecision(
      record,
      criterion,
      projections,
      observedAt,
    )?.decision;
    addAction("review-evidence");
    if (currentDecision === undefined) {
      addAttention("verification-required", criterion.id);
    }
  }
  if (hasLinkedWork) {
    addAction("refresh");
    if (!hasUncertainOperation) {
      addAction("unlink-work");
    }
  }
  if (
    !hasUncertainOperation &&
    (record.phase === "draft" || record.phase === "active" || record.phase === "accepted")
  ) {
    addAction("edit-contract");
    addAction("link-work");
  }
  if (
    record.phase === "draft" &&
    record.criteria
      .filter((criterion) => criterion.required)
      .every((criterion) => criterion.workRefs.length > 0)
  ) {
    addAction("activate");
  }
  if ((record.phase === "draft" || record.phase === "active") && !hasUncertainOperation) {
    addAction("cancel");
  }
  if (record.phase === "draft" && !hasUncertainOperation) {
    addAction("delete");
  }
  const hasCurrentAcceptance =
    closureHash !== null &&
    record.acceptances.some(
      (acceptance) =>
        acceptance.planGeneration === record.planGeneration &&
        acceptance.planHash === record.planHash &&
        acceptance.closureHash === closureHash,
    );
  if (
    record.criteria.some(
      (criterion) =>
        currentOutcomeDecision(record, criterion, projections, observedAt)?.decision.status ===
        "rejected",
    )
  ) {
    addAttention("rejected");
  }
  if (record.acceptances.length > 0 && !hasCurrentAcceptance) {
    addAttention("acceptance-needs-review");
  }
  if (hasUncertainOperation) {
    addAttention("unknown-operation");
  }
  if (closureHash !== null && !hasCurrentAcceptance) {
    addAttention("ready-for-acceptance");
    addAction("review-evidence");
    addAction("accept");
  }
  return { attention, nextActions };
}
