import type {
  OutcomeAcceptParams,
  OutcomeVerifyCriterionParams,
} from "@openclaw/outcomes-contract";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { acceptOutcome, verifyOutcomeCriterion } from "./client.ts";
import { OutcomesPageGateway } from "./outcomes-page-gateway.ts";

const DETERMINISTIC_ASSURANCE_REJECTION_CODES = new Set([
  "OUTCOME_CAPACITY_EXCEEDED",
  "OUTCOME_CLOSURE_INCOMPLETE",
  "OUTCOME_INVALID_REQUEST",
  "OUTCOME_INVALID_STATE",
  "OUTCOME_NOT_FOUND",
  "OUTCOME_OPERATION_CONFLICT",
  "OUTCOME_REVISION_CONFLICT",
]);

function isDeterministicAssuranceRejection(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    DETERMINISTIC_ASSURANCE_REJECTION_CODES.has(error.code)
  );
}
export abstract class OutcomesPageAssuranceMutations extends OutcomesPageGateway {
  protected openVerificationDialog() {
    const detail = this.detail;
    if (
      !detail ||
      this.verifying ||
      (!this.verificationReplayPending &&
        !this.canOutcomeAction("review-evidence", "outcomes.verifyCriterion", true)) ||
      (this.verificationReplayPending &&
        !this.canReplayOutcomeAssurance("outcomes.verifyCriterion"))
    ) {
      return;
    }
    const criterion = detail.criteria.find((item) => item.evidenceSetHash !== null);
    if (!criterion && this.verificationRequest === null) {
      return;
    }
    if (this.verificationRequest) {
      this.verificationCriterionId = this.verificationRequest.criterionId;
      this.verificationStatus = this.verificationRequest.status;
      this.verificationNote = this.verificationRequest.note ?? "";
    } else {
      this.verificationCriterionId = criterion!.id;
      this.verificationStatus = "verified";
      this.verificationNote = "";
    }
    this.verificationError = null;
    this.verificationDialogOpen = true;
  }

  protected dismissVerificationDialog(event?: Event) {
    if (this.verifying) {
      event?.preventDefault();
      return;
    }
    this.verificationDialogOpen = false;
    this.verificationError = null;
  }

  protected updateVerificationCriterion(id: string) {
    if (!this.verifying && !this.verificationReplayPending) {
      this.verificationCriterionId = id;
    }
  }

  protected updateVerificationStatus(status: "verified" | "rejected") {
    if (!this.verifying && !this.verificationReplayPending) {
      this.verificationStatus = status;
    }
  }

  protected updateVerificationNote(note: string) {
    if (!this.verifying && !this.verificationReplayPending) {
      this.verificationNote = note;
    }
  }

  protected async submitVerification(event: SubmitEvent) {
    event.preventDefault();
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    const pendingRequest = this.verificationRequest;
    const criterion = detail?.criteria.find((item) => item.id === this.verificationCriterionId);
    const note = this.verificationNote.trim();
    if (
      this.verifying ||
      (pendingRequest === null && this.assuranceRefreshRequired) ||
      !detail ||
      !id ||
      detail.id !== id ||
      (pendingRequest === null &&
        (!detail.planHash ||
          !criterion?.evidenceSetHash ||
          (this.verificationStatus === "rejected" && !note))) ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      (pendingRequest === null
        ? !this.canOutcomeAction("review-evidence", "outcomes.verifyCriterion", true)
        : !this.canReplayOutcomeAssurance("outcomes.verifyCriterion")) ||
      this.outcomeMutationIsInFlight(id)
    ) {
      return;
    }
    const ownerId = snapshot.selfUser.id;
    const request =
      pendingRequest ??
      ({
        id,
        expectedRevision: detail.revision,
        decisionId: crypto.randomUUID(),
        criterionId: criterion!.id,
        status: this.verificationStatus,
        planHash: detail.planHash!,
        evidenceSetHash: criterion!.evidenceSetHash!,
        ...(note ? { note } : {}),
      } satisfies OutcomeVerifyCriterionParams);
    this.verificationRequest = request;
    this.verificationReplayPending = false;
    const sequence = ++this.assuranceRequestSequence;
    const expectedRevision = request.expectedRevision;
    this.verificationError = null;
    this.verifying = true;
    this.detailRequestSequence += 1;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const outcome = await verifyOutcomeCriterion(client, request);
      if (
        sequence === this.assuranceRequestSequence &&
        id === this.selectedOutcomeId &&
        outcome.revision >= expectedRevision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(outcome, requestStartedAt);
        this.verificationDialogOpen = false;
        this.verificationRequest = null;
        this.verificationReplayPending = false;
      }
    } catch (error) {
      if (
        sequence === this.assuranceRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        const deterministic = isDeterministicAssuranceRejection(error);
        if (deterministic) {
          this.verificationRequest = null;
          this.verificationReplayPending = false;
          this.assuranceRefreshRequired = true;
        } else {
          this.verificationReplayPending = true;
          mutationResultWasCurrent = false;
        }
        this.verificationError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(mutationLock);
      if (!mutationResultWasCurrent) {
        this.revalidateAfterSettledMutation(mutationLock);
      }
      if (
        sequence === this.assuranceRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.verifying = false;
      }
    }
  }

  protected async acceptSelectedOutcome() {
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      !detail ||
      !id ||
      detail.id !== id ||
      (this.acceptanceRequest === null && this.assuranceRefreshRequired) ||
      (this.acceptanceRequest === null && (!detail.planHash || !detail.closureHash)) ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      (this.acceptanceRequest === null
        ? !this.canOutcomeAction("accept", "outcomes.accept", true)
        : !this.canReplayOutcomeAssurance("outcomes.accept")) ||
      this.outcomeMutationIsInFlight(id)
    ) {
      return;
    }
    const ownerId = snapshot.selfUser.id;
    const request =
      this.acceptanceRequest ??
      ({
        id,
        expectedRevision: detail.revision,
        acceptanceId: crypto.randomUUID(),
        planHash: detail.planHash!,
        closureHash: detail.closureHash!,
      } satisfies OutcomeAcceptParams);
    this.acceptanceRequest = request;
    this.acceptanceReplayPending = false;
    const sequence = ++this.assuranceRequestSequence;
    const expectedRevision = request.expectedRevision;
    this.mutationError = null;
    this.detailRequestSequence += 1;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const outcome = await acceptOutcome(client, request);
      if (
        sequence === this.assuranceRequestSequence &&
        id === this.selectedOutcomeId &&
        outcome.revision >= expectedRevision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(outcome, requestStartedAt);
        this.acceptanceRequest = null;
        this.acceptanceReplayPending = false;
      }
    } catch (error) {
      if (
        sequence === this.assuranceRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        const deterministic = isDeterministicAssuranceRejection(error);
        if (deterministic) {
          this.acceptanceRequest = null;
          this.acceptanceReplayPending = false;
          this.assuranceRefreshRequired = true;
        } else {
          this.acceptanceReplayPending = true;
        }
        this.mutationError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(mutationLock);
      if (!mutationResultWasCurrent) {
        this.revalidateAfterSettledMutation(mutationLock);
      }
    }
  }
}
