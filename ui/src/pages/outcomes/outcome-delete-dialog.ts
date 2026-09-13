import { html, nothing } from "lit";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";

export type OutcomeDeleteDialogData = {
  deleteConfirmationOpen: boolean;
  deleteError: string | null;
  deleting: boolean;
  onConfirmDelete: () => void;
  onDeleteConfirmationDismiss: (event: Event) => void;
};

export function renderOutcomeDeleteDialog(data: OutcomeDeleteDialogData) {
  if (!data.deleteConfirmationOpen) {
    return nothing;
  }
  return html`<openclaw-modal-dialog
    label=${t("outcomesPage.deleteOutcome")}
    description=${t("outcomesPage.deleteHelp")}
    @modal-cancel=${data.onDeleteConfirmationDismiss}
  >
    <section class="outcome-cancel-dialog" aria-busy=${data.deleting ? "true" : "false"}>
      <h2>${t("outcomesPage.deleteOutcome")}</h2>
      <p>${t("outcomesPage.deleteHelp")}</p>
      ${data.deleteError
        ? html`<p class="outcomes-state outcomes-state--error" role="alert">
            ${data.deleteError}
          </p>`
        : nothing}
      <div class="outcome-cancel-dialog__actions">
        <button
          data-outcome-dismiss-delete
          type="button"
          ?disabled=${data.deleting}
          @click=${() => data.onDeleteConfirmationDismiss(new Event("modal-cancel"))}
        >
          ${t("common.back")}
        </button>
        <button
          data-outcome-confirm-delete
          type="button"
          ?disabled=${data.deleting}
          @click=${data.onConfirmDelete}
        >
          ${data.deleting ? t("outcomesPage.deleting") : t("common.confirm")}
        </button>
      </div>
    </section>
  </openclaw-modal-dialog>`;
}
