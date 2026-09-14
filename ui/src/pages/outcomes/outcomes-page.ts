import { html } from "lit";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import {
  addCreateDraftCriterion,
  removeCreateDraftCriterion,
  updateCreateDraftCriterion,
  updateCreateDraftField,
} from "./outcomes-page-model.ts";
import { OutcomesPageMutations } from "./outcomes-page-mutations.ts";
import { renderCreateOutcomeDialog, renderOutcomeDetail, renderOutcomesList } from "./view.ts";

class OutcomesPage extends OutcomesPageMutations {
  override render() {
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("outcomes")}</div>
          <p class="muted">${subtitleForRoute("outcomes")}</p>
        </div>
      </section>
      ${renderOutcomesList({
        outcomes: this.outcomes,
        disconnected: this.disconnected,
        unauthorized: this.unauthorized,
        loading: this.loading,
        loaded: this.loaded,
        error: this.error,
        hasMore: this.nextCursor !== null,
        canCreate: this.canCreateOutcome(),
        loadingMore: this.loadingMore,
        loadMoreError: this.loadMoreError,
        onLoadMore: () => void this.loadMoreOutcomes(),
        onRequestCreate: () => this.openCreateDialog(),
        onSelect: (id) => this.selectOutcome(id),
        selectedOutcomeId: this.selectedOutcomeId,
      })}
      ${renderCreateOutcomeDialog({
        criteria: this.createCriteria,
        creating: this.creating,
        error: this.createError,
        objective: this.createObjective,
        pendingRequest: this.createRequest !== null,
        onAbandonPendingRequest: () => this.abandonPendingCreateRequest(),
        onAddCriterion: () => {
          if (!this.creating && !this.createRequest && this.createCriteria.length < 5) {
            this.createCriteria = addCreateDraftCriterion({
              criteria: this.createCriteria,
              objective: this.createObjective,
              title: this.createTitle,
            }).criteria;
          }
        },
        onDismiss: (event) => this.dismissCreateDialog(event),
        onInput: (field, value) => {
          if (!this.creating && !this.createRequest) {
            const draft = updateCreateDraftField(
              {
                criteria: this.createCriteria,
                objective: this.createObjective,
                title: this.createTitle,
              },
              field,
              value,
            );
            this.createTitle = draft.title;
            this.createObjective = draft.objective;
          }
        },
        onRemoveCriterion: (index) => {
          if (!this.creating && !this.createRequest && this.createCriteria.length > 1) {
            this.createCriteria = removeCreateDraftCriterion(
              {
                criteria: this.createCriteria,
                objective: this.createObjective,
                title: this.createTitle,
              },
              index,
            ).criteria;
          }
        },
        onCriterionInput: (index, value) => {
          if (!this.creating && !this.createRequest && this.createCriteria[index] !== value) {
            this.createCriteria = updateCreateDraftCriterion(
              {
                criteria: this.createCriteria,
                objective: this.createObjective,
                title: this.createTitle,
              },
              index,
              value,
            ).criteria;
          }
        },
        onSubmit: (event) => void this.submitCreateOutcome(event),
        open: this.createDialogOpen,
        title: this.createTitle,
      })}
      ${renderOutcomeDetail({
        detail: this.detail,
        detailExpired: this.isDetailExpired(),
        error: this.detailError,
        loading: this.detailLoading,
        canActivate: this.canOutcomeAction("activate", "outcomes.activate", true),
        canCancel: this.canOutcomeAction("cancel", "outcomes.cancel"),
        canDelete: this.canDeleteOutcome(),
        canEdit: this.canOutcomeAction("edit-contract", "outcomes.update"),
        canExport: this.canExportOutcome(),
        canLink: this.canLinkOutcome(),
        canRefresh: this.canOutcomeAction("refresh", "outcomes.refresh"),
        canUnlink: this.canOutcomeAction("unlink-work", "outcomes.unlinkWorkboard"),
        canVerify:
          this.canOutcomeAction("review-evidence", "outcomes.verifyCriterion", true) ||
          (this.verificationReplayPending &&
            this.canReplayOutcomeAssurance("outcomes.verifyCriterion")),
        canAccept:
          this.canOutcomeAction("accept", "outcomes.accept", true) ||
          (this.acceptanceReplayPending && this.canReplayOutcomeAssurance("outcomes.accept")),
        cancelConfirmationOpen: this.cancelConfirmationOpen,
        cancelError: this.cancelError,
        cancelling: this.cancelling,
        deleteConfirmationOpen: this.deleteConfirmationOpen,
        deleteError: this.deleteError,
        deleting: this.deleting,
        mutationError: this.mutationError,
        mutationInFlight: this.outcomeMutationIsInFlight(this.selectedOutcomeId),
        onActivate: () => void this.activateSelectedOutcome(),
        onAccept: () => void this.acceptSelectedOutcome(),
        onExport: () => void this.exportSelectedOutcome(),
        onDismissEdit: (event) => this.dismissEditDialog(event),
        onEditCriterionInput: (index, value) => this.updateEditCriterion(index, value),
        onEditInput: (field, value) => this.updateEditField(field, value),
        onRequestAddEditCriterion: () => this.addEditCriterion(),
        onRequestEdit: () => this.openEditDialog(),
        onRequestVerify: () => this.openVerificationDialog(),
        onRequestLink: () => void this.openLinkDialog(),
        onRequestRemoveEditCriterion: (index) => this.removeEditCriterion(index),
        onSubmitEdit: (event) => void this.submitEditOutcome(event),
        onDismissLink: (event) => this.dismissLinkDialog(event),
        onLinkCardChange: (id) => this.updateLinkCard(id),
        onLinkCriterionChange: (id) => this.updateLinkCriterion(id),
        onSubmitLink: (event) => void this.submitLinkOutcome(event),
        onUnlink: (criterionId, cardId) => void this.unlinkWorkboardCard(criterionId, cardId),
        onCancelConfirmationDismiss: (event) => this.dismissCancelConfirmation(event),
        onConfirmCancel: () => void this.cancelSelectedOutcome(),
        onRequestCancel: () => this.openCancelConfirmation(),
        onDeleteConfirmationDismiss: (event) => this.dismissDeleteConfirmation(event),
        onConfirmDelete: () => void this.deleteSelectedOutcome(),
        onRequestDelete: () => this.openDeleteConfirmation(),
        onRefresh: () => void this.refreshSelectedOutcome(),
        onDismissVerification: (event) => this.dismissVerificationDialog(event),
        onVerificationCriterionChange: (id) => this.updateVerificationCriterion(id),
        onVerificationNoteChange: (note) => this.updateVerificationNote(note),
        onVerificationStatusChange: (status) => this.updateVerificationStatus(status),
        onSubmitVerification: (event) => void this.submitVerification(event),
        revalidating: this.detailRevalidating,
        refreshing: this.refreshing,
        onBack: () => this.clearSelectedOutcome(),
        selectedOutcomeId: this.selectedOutcomeId,
        editCriteria: this.editCriteria,
        editDialogOpen: this.editDialogOpen,
        editError: this.editError,
        editing: this.editing,
        editObjective: this.editObjective,
        editTitle: this.editTitle,
        linkCardId: this.linkCardId,
        linkCards: this.linkCards,
        linkCardsLoading: this.linkCardsLoading,
        linkCriterionId: this.linkCriterionId,
        linkDialogOpen: this.linkDialogOpen,
        linkError: this.linkError,
        linking: this.linking,
        verificationCriterionId: this.verificationCriterionId,
        verificationDialogOpen: this.verificationDialogOpen,
        verificationError: this.verificationError,
        verificationNote: this.verificationNote,
        verificationReplayPending: this.verificationReplayPending,
        acceptanceReplayPending: this.acceptanceReplayPending,
        assuranceRefreshRequired: this.assuranceRefreshRequired,
        verificationStatus: this.verificationStatus,
        verifying: this.verifying,
      })}
    `;
  }
}

if (!customElements.get("openclaw-outcomes-page")) {
  customElements.define("openclaw-outcomes-page", OutcomesPage);
}
