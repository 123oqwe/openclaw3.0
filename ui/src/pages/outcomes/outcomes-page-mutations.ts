import type {
  OutcomeAcceptParams,
  OutcomeCreateParams,
  OutcomeVerifyCriterionParams,
} from "@openclaw/outcomes-contract";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  activateOutcome,
  acceptOutcome,
  cancelOutcome,
  createOutcome,
  linkOutcomeWorkboard,
  listAuthorizedWorkboardCards,
  refreshOutcome,
  updateOutcome,
  unlinkOutcomeWorkboard,
  verifyOutcomeCriterion,
} from "./client.ts";
import { OutcomesPageGateway } from "./outcomes-page-gateway.ts";
import { replaceOutcomeSummary } from "./outcomes-page-model.ts";

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

export abstract class OutcomesPageMutations extends OutcomesPageGateway {
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

  protected openCreateDialog() {
    if (!this.canCreateOutcome() || this.creating) {
      return;
    }
    this.createError = null;
    this.createDialogOpen = true;
  }

  protected dismissCreateDialog(event?: Event) {
    if (this.creating) {
      event?.preventDefault();
      return;
    }
    this.createDialogOpen = false;
    this.createError = null;
    this.restoreCreateFocus();
  }

  protected abandonPendingCreateRequest() {
    if (this.creating) {
      return;
    }
    this.createRequest = null;
    this.createError = null;
  }

  protected async submitCreateOutcome(event: SubmitEvent) {
    event.preventDefault();
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    const title = this.createTitle.trim();
    const objective = this.createObjective.trim();
    const criteria = this.createCriteria.map((criterion) => criterion.trim());
    if (
      this.creating ||
      !title ||
      !objective ||
      criteria.length < 1 ||
      criteria.length > 5 ||
      criteria.some((criterion) => !criterion) ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canCreateOutcome()
    ) {
      return;
    }
    const request =
      this.createRequest ??
      ({
        criteria: criteria.map((text) => ({ id: crypto.randomUUID(), required: true, text })),
        id: crypto.randomUUID(),
        objective,
        title,
      } satisfies OutcomeCreateParams);
    this.createRequest = request;
    const sequence = ++this.createRequestSequence;
    this.createError = null;
    this.creating = true;
    try {
      const created = await createOutcome(client, request);
      if (sequence === this.createRequestSequence && this.gateway.isCurrent(scope)) {
        this.outcomes = replaceOutcomeSummary(this.outcomes, created);
        this.createDialogOpen = false;
        this.createTitle = "";
        this.createObjective = "";
        this.createCriteria = [""];
        this.createRequest = null;
        this.restoreCreateFocus();
      }
    } catch (error) {
      if (sequence === this.createRequestSequence && this.gateway.isCurrent(scope)) {
        this.createError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      if (sequence === this.createRequestSequence && this.gateway.isCurrent(scope)) {
        this.creating = false;
      }
    }
  }

  protected openEditDialog() {
    const detail = this.detail;
    if (!detail || this.editing || !this.canOutcomeAction("edit-contract", "outcomes.update")) {
      return;
    }
    this.editError = null;
    this.editTitle = detail.title;
    this.editObjective = detail.objective;
    this.editCriteria = detail.criteria.map(({ id, required, text }) => ({ id, required, text }));
    this.editDialogOpen = true;
  }

  protected dismissEditDialog(event?: Event) {
    if (this.editing) {
      event?.preventDefault();
      return;
    }
    this.editDialogOpen = false;
    this.editError = null;
  }

  protected updateEditField(field: "title" | "objective", value: string) {
    if (this.editing) {
      return;
    }
    if (field === "title") {
      this.editTitle = value;
    } else {
      this.editObjective = value;
    }
  }

  protected updateEditCriterion(index: number, text: string) {
    if (this.editing) {
      return;
    }
    this.editCriteria = this.editCriteria.map((criterion, criterionIndex) =>
      criterionIndex === index ? { ...criterion, text } : criterion,
    );
  }

  protected addEditCriterion() {
    if (this.editing || this.editCriteria.length >= 5) {
      return;
    }
    this.editCriteria = [
      ...this.editCriteria,
      { id: crypto.randomUUID(), required: true, text: "" },
    ];
  }

  protected removeEditCriterion(index: number) {
    if (this.editing || this.editCriteria.length <= 1) {
      return;
    }
    this.editCriteria = this.editCriteria.filter((_, criterionIndex) => criterionIndex !== index);
  }

  protected async submitEditOutcome(event: SubmitEvent) {
    event.preventDefault();
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    const title = this.editTitle.trim();
    const objective = this.editObjective.trim();
    const criteria = this.editCriteria.map((criterion) => ({
      ...criterion,
      text: criterion.text.trim(),
    }));
    if (
      this.editing ||
      !detail ||
      !id ||
      detail.id !== id ||
      !title ||
      !objective ||
      criteria.length < 1 ||
      criteria.length > 5 ||
      criteria.some((criterion) => !criterion.text) ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canOutcomeAction("edit-contract", "outcomes.update")
    ) {
      return;
    }
    const ownerId = snapshot.selfUser.id;
    const expectedRevision = detail.revision;
    const sequence = ++this.editRequestSequence;
    this.editError = null;
    this.editing = true;
    this.detailRequestSequence += 1;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const updated = await updateOutcome(client, id, expectedRevision, {
        criteria,
        objective,
        title,
      });
      if (
        sequence === this.editRequestSequence &&
        id === this.selectedOutcomeId &&
        updated.revision >= expectedRevision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(updated, requestStartedAt);
        this.editDialogOpen = false;
      }
    } catch (error) {
      if (
        sequence === this.editRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.editError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(mutationLock);
      if (!mutationResultWasCurrent) {
        this.revalidateAfterSettledMutation(mutationLock);
      }
      if (
        sequence === this.editRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.editing = false;
      }
    }
  }

  protected async openLinkDialog() {
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      !detail ||
      !id ||
      detail.id !== id ||
      this.linking ||
      !client ||
      !scope ||
      !this.canLinkOutcome()
    ) {
      return;
    }
    const sequence = ++this.linkRequestSequence;
    this.linkDialogOpen = true;
    this.linkError = null;
    this.linkCards = [];
    this.linkCardsLoading = true;
    this.linkCriterionId = detail.criteria[0]?.id ?? "";
    this.linkCardId = "";
    try {
      const result = await listAuthorizedWorkboardCards(client);
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.linkCards = result.cards;
      }
    } catch (error) {
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.linkError = t("outcomesPage.loadCardsFailed", { error: formatUiError(error) });
      }
    } finally {
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.linkCardsLoading = false;
      }
    }
  }

  protected dismissLinkDialog(event?: Event) {
    if (this.linking) {
      event?.preventDefault();
      return;
    }
    this.linkDialogOpen = false;
    this.linkError = null;
    this.linkCardsLoading = false;
  }

  protected updateLinkCriterion(id: string) {
    if (!this.linking) {
      this.linkCriterionId = id;
    }
  }

  protected updateLinkCard(id: string) {
    if (!this.linking) {
      this.linkCardId = id;
    }
  }

  protected async submitLinkOutcome(event: SubmitEvent) {
    event.preventDefault();
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    const criterionId = this.linkCriterionId;
    const cardId = this.linkCardId;
    if (
      this.linking ||
      !detail ||
      !id ||
      detail.id !== id ||
      !criterionId ||
      !detail.criteria.some((criterion) => criterion.id === criterionId) ||
      !cardId ||
      !this.linkCards.some((card) => card.id === cardId) ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canLinkOutcome() ||
      this.outcomeMutationIsInFlight(id)
    ) {
      return;
    }
    const ownerId = snapshot.selfUser.id;
    const expectedRevision = detail.revision;
    const sequence = ++this.linkRequestSequence;
    this.linkError = null;
    this.linking = true;
    this.detailRequestSequence += 1;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const linked = await linkOutcomeWorkboard(client, {
        cardId,
        criterionId,
        expectedRevision,
        id,
      });
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        linked.revision >= expectedRevision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(linked, requestStartedAt);
        this.linkDialogOpen = false;
      }
    } catch (error) {
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.linkError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(mutationLock);
      if (!mutationResultWasCurrent) {
        this.revalidateAfterSettledMutation(mutationLock);
      }
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.linking = false;
      }
    }
  }

  protected async unlinkWorkboardCard(criterionId: string, cardId: string) {
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      !detail ||
      !id ||
      detail.id !== id ||
      !detail.criteria.some(
        (criterion) =>
          criterion.id === criterionId &&
          criterion.workRefs.some((reference) => reference.cardId === cardId),
      ) ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canOutcomeAction("unlink-work", "outcomes.unlinkWorkboard") ||
      this.outcomeMutationIsInFlight(id)
    ) {
      return;
    }
    const ownerId = snapshot.selfUser.id;
    const expectedRevision = detail.revision;
    const sequence = ++this.linkRequestSequence;
    this.mutationError = null;
    this.detailRequestSequence += 1;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const unlinked = await unlinkOutcomeWorkboard(client, {
        cardId,
        criterionId,
        expectedRevision,
        id,
      });
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        unlinked.revision >= expectedRevision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(unlinked, requestStartedAt);
      }
    } catch (error) {
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.mutationError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(mutationLock);
      if (!mutationResultWasCurrent) {
        this.revalidateAfterSettledMutation(mutationLock);
      }
    }
  }

  protected openCancelConfirmation() {
    if (
      !this.canOutcomeAction("cancel", "outcomes.cancel") ||
      this.cancelling ||
      this.outcomeMutationIsInFlight(this.selectedOutcomeId)
    ) {
      return;
    }
    this.cancelError = null;
    this.cancelConfirmationOpen = true;
  }

  protected dismissCancelConfirmation(event?: Event) {
    if (this.cancelling) {
      event?.preventDefault();
      return;
    }
    this.cancelConfirmationOpen = false;
    this.cancelError = null;
  }

  protected async cancelSelectedOutcome() {
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      this.cancelling ||
      !detail ||
      !id ||
      detail.id !== id ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canOutcomeAction("cancel", "outcomes.cancel") ||
      this.outcomeMutationIsInFlight(id)
    ) {
      return;
    }
    const ownerId = snapshot.selfUser.id;
    const sequence = ++this.mutationSequence;
    this.detailRequestSequence += 1;
    this.cancelError = null;
    this.cancelling = true;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const cancelled = await cancelOutcome(client, id, detail.revision);
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        cancelled.revision >= detail.revision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(cancelled, requestStartedAt);
        this.cancelConfirmationOpen = false;
      }
    } catch (error) {
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.cancelError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(mutationLock);
      if (!mutationResultWasCurrent) {
        this.revalidateAfterSettledMutation(mutationLock);
      }
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.cancelling = false;
      }
    }
  }

  protected async refreshSelectedOutcome() {
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      this.refreshing ||
      !detail ||
      !id ||
      detail.id !== id ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canOutcomeAction("refresh", "outcomes.refresh") ||
      this.outcomeMutationIsInFlight(id)
    ) {
      return;
    }
    const ownerId = snapshot.selfUser.id;
    const sequence = ++this.mutationSequence;
    this.detailRequestSequence += 1;
    this.mutationError = null;
    this.refreshing = true;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const refreshed = await refreshOutcome(client, id, detail.revision);
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        refreshed.revision >= detail.revision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(refreshed, requestStartedAt);
      }
    } catch (error) {
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.mutationError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(mutationLock);
      if (!mutationResultWasCurrent) {
        this.revalidateAfterSettledMutation(mutationLock);
      }
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.refreshing = false;
      }
    }
  }

  protected async activateSelectedOutcome() {
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      !detail ||
      !id ||
      detail.id !== id ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canOutcomeAction("activate", "outcomes.activate", true) ||
      this.outcomeMutationIsInFlight(id)
    ) {
      return;
    }
    const ownerId = snapshot.selfUser.id;
    const sequence = ++this.mutationSequence;
    this.detailRequestSequence += 1;
    this.mutationError = null;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const activated = await activateOutcome(client, id, detail.revision);
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        activated.revision >= detail.revision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(activated, requestStartedAt);
      }
    } catch (error) {
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
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
