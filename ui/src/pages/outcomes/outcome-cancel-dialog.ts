import { html, nothing } from "lit";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";

export type OutcomeCancelDialogData = {
  cancelConfirmationOpen: boolean;
  cancelError: string | null;
  cancelling: boolean;
  onCancelConfirmationDismiss: (event: Event) => void;
  onConfirmCancel: () => void;
};

export function renderOutcomeCancelDialog(data: OutcomeCancelDialogData) {
  if (!data.cancelConfirmationOpen) {
    return nothing;
  }
  return html`<openclaw-modal-dialog
    label=${t("outcomesPage.cancelOutcome")}
    description=${t("outcomesPage.cancelHelp")}
    @modal-cancel=${data.onCancelConfirmationDismiss}
  >
    <section class="outcome-cancel-dialog" aria-busy=${data.cancelling ? "true" : "false"}>
      <h2>${t("outcomesPage.cancelOutcome")}</h2>
      <p>${t("outcomesPage.cancelHelp")}</p>
      ${data.cancelError
        ? html`<p class="outcomes-state outcomes-state--error" role="alert">
            ${data.cancelError}
          </p>`
        : nothing}
      <div class="outcome-cancel-dialog__actions">
        <button
          data-outcome-dismiss-cancel
          type="button"
          ?disabled=${data.cancelling}
          @click=${() => data.onCancelConfirmationDismiss(new Event("modal-cancel"))}
        >
          ${t("common.back")}
        </button>
        <button
          data-outcome-confirm-cancel
          type="button"
          ?disabled=${data.cancelling}
          @click=${data.onConfirmCancel}
        >
          ${data.cancelling ? t("outcomesPage.cancelling") : t("common.confirm")}
        </button>
      </div>
    </section>
  </openclaw-modal-dialog>`;
}
