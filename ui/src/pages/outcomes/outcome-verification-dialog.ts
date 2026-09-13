import type { OutcomeDetail } from "@openclaw/outcomes-contract";
import { html, nothing } from "lit";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";

export type OutcomeVerificationDialogData = {
  detail: OutcomeDetail | null;
  onDismissVerification: (event: Event) => void;
  onSubmitVerification: (event: SubmitEvent) => void;
  onVerificationCriterionChange: (id: string) => void;
  onVerificationNoteChange: (note: string) => void;
  onVerificationStatusChange: (status: "verified" | "rejected") => void;
  verificationCriterionId: string;
  verificationDialogOpen: boolean;
  verificationError: string | null;
  verificationNote: string;
  verificationReplayPending: boolean;
  verificationStatus: "verified" | "rejected";
  verifying: boolean;
};

function formControlValue(event: Event): string {
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return target.value;
  }
  return "";
}

export function renderOutcomeVerificationDialog(data: OutcomeVerificationDialogData) {
  if (!data.verificationDialogOpen || !data.detail) {
    return nothing;
  }
  return html`<openclaw-modal-dialog
    label=${t("outcomesPage.verifyCriterion")}
    description=${t("outcomesPage.verifyHelp")}
    @modal-cancel=${data.onDismissVerification}
  >
    <form
      class="outcome-create-dialog"
      data-outcome-verification-form
      aria-busy=${data.verifying ? "true" : "false"}
      @submit=${data.onSubmitVerification}
    >
      <h2>${t("outcomesPage.verifyCriterion")}</h2>
      <p>${t("outcomesPage.verifyHelp")}</p>
      ${data.verificationReplayPending
        ? html`<p>${t("outcomesPage.assuranceReplayHelp")}</p>`
        : nothing}
      <label>
        ${t("outcomesPage.criterion")}
        <select
          name="criterion"
          required
          ?disabled=${data.verifying || data.verificationReplayPending}
          .value=${data.verificationCriterionId}
          @change=${(event: Event) => data.onVerificationCriterionChange(formControlValue(event))}
        >
          ${data.detail.criteria
            .filter((criterion) => criterion.evidenceSetHash !== null)
            .map((criterion) => html`<option value=${criterion.id}>${criterion.text}</option>`)}
        </select>
      </label>
      <label>
        ${t("outcomesPage.verificationStatus")}
        <select
          name="status"
          required
          ?disabled=${data.verifying || data.verificationReplayPending}
          .value=${data.verificationStatus}
          @change=${(event: Event) =>
            data.onVerificationStatusChange(
              formControlValue(event) === "rejected" ? "rejected" : "verified",
            )}
        >
          <option value="verified">${t("outcomesPage.verified")}</option>
          <option value="rejected">${t("outcomesPage.rejected")}</option>
        </select>
      </label>
      ${data.verificationStatus === "rejected"
        ? html`<label>
            ${t("outcomesPage.rejectionNote")}
            <textarea
              name="note"
              required
              ?disabled=${data.verifying || data.verificationReplayPending}
              .value=${data.verificationNote}
              @input=${(event: InputEvent) =>
                data.onVerificationNoteChange(formControlValue(event))}
            ></textarea>
          </label>`
        : nothing}
      ${data.verificationError
        ? html`<p class="outcomes-state outcomes-state--error" role="alert">
            ${data.verificationError}
          </p>`
        : nothing}
      <div class="outcome-cancel-dialog__actions">
        <button
          data-outcome-dismiss-verification
          type="button"
          ?disabled=${data.verifying}
          @click=${() => data.onDismissVerification(new Event("modal-cancel"))}
        >
          ${t("common.back")}
        </button>
        <button data-outcome-confirm-verification type="submit" ?disabled=${data.verifying}>
          ${data.verifying
            ? t("common.loading")
            : data.verificationReplayPending
              ? t("common.retry")
              : t("common.confirm")}
        </button>
      </div>
    </form>
  </openclaw-modal-dialog>`;
}
