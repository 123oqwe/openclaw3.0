import type {
  OutcomeDetail,
  OutcomeCriterionInput,
  OutcomeEvidenceKind,
  OutcomeSourceIssueReason,
} from "@openclaw/outcomes-contract";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerOutcomesEnglish } from "../../i18n/locales/en-outcomes.ts";
import "../../styles/outcomes.css";
import {
  acceptanceValidityLabel,
  attentionLabel,
  renderCreateOutcomeDialog,
  renderOutcomesList,
  nextActionLabel,
  phaseLabel,
  readinessLabel,
} from "./outcomes-view-support.ts";

export { renderCreateOutcomeDialog, renderOutcomesList };

registerOutcomesEnglish();

export type OutcomeDetailViewData = {
  canActivate: boolean;
  canCancel: boolean;
  canEdit: boolean;
  canLink: boolean;
  canRefresh: boolean;
  canUnlink: boolean;
  cancelConfirmationOpen: boolean;
  cancelError: string | null;
  cancelling: boolean;
  detail: OutcomeDetail | null;
  detailExpired?: boolean;
  editCriteria: readonly OutcomeCriterionInput[];
  editDialogOpen: boolean;
  editError: string | null;
  editing: boolean;
  editObjective: string;
  editTitle: string;
  error: string | null;
  loading: boolean;
  onBack: () => void;
  onActivate: () => void;
  onDismissEdit: (event: Event) => void;
  onEditCriterionInput: (index: number, value: string) => void;
  onEditInput: (field: "title" | "objective", value: string) => void;
  onRequestAddEditCriterion: () => void;
  onRequestEdit: () => void;
  onRequestLink: () => void;
  onRequestRemoveEditCriterion: (index: number) => void;
  onCancelConfirmationDismiss: (event: Event) => void;
  onConfirmCancel: () => void;
  onRequestCancel: () => void;
  onRefresh: () => void;
  onSubmitEdit: (event: SubmitEvent) => void;
  onDismissLink: (event: Event) => void;
  onLinkCardChange: (id: string) => void;
  onLinkCriterionChange: (id: string) => void;
  onSubmitLink: (event: SubmitEvent) => void;
  onUnlink: (criterionId: string, cardId: string) => void;
  mutationError: string | null;
  mutationInFlight: boolean;
  revalidating: boolean;
  refreshing: boolean;
  selectedOutcomeId: string | null;
  linkCardId: string;
  linkCards: readonly WorkboardCard[];
  linkCardsLoading: boolean;
  linkCriterionId: string;
  linkDialogOpen: boolean;
  linkError: string | null;
  linking: boolean;
};

function evidenceKindLabel(kind: OutcomeEvidenceKind): string {
  return kind === "workboard-proof"
    ? t("outcomesPage.evidence.proof")
    : t("outcomesPage.evidence.artifact");
}

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

function sourceIssueLabel(reason: OutcomeSourceIssueReason): string {
  switch (reason) {
    case "workboard-disabled":
      return t("outcomesPage.sourceIssue.workboardDisabled");
    default:
      return t("outcomesPage.sourceIssue.unavailable");
  }
}

export function renderOutcomeDetail(data: OutcomeDetailViewData) {
  if (!data.selectedOutcomeId) {
    return nothing;
  }
  const back = html`<button class="outcome-detail__back" type="button" @click=${data.onBack}>
    ${t("common.back")}
  </button>`;
  if (data.loading) {
    return html`<section class="outcomes-state" role="status" aria-live="polite">
      ${back}
      ${data.revalidating ? t("outcomesPage.revalidatingDetail") : t("outcomesPage.loadingDetail")}
    </section>`;
  }
  if (data.error) {
    return html`<section class="outcomes-state outcomes-state--error" role="alert">
      ${back} ${data.error}
    </section>`;
  }
  if (!data.detail) {
    return nothing;
  }
  const acceptanceValidity =
    data.detailExpired && data.detail.acceptanceValidity !== "none"
      ? "needs-review"
      : data.detail.acceptanceValidity;
  const readiness =
    data.detailExpired && data.detail.readiness !== "unavailable" ? "stale" : data.detail.readiness;
  return html`<article class="outcome-detail" data-outcome-detail-id=${data.detail.id}>
    ${back}
    <h2 class="outcome-detail__title">${data.detail.title}</h2>
    <p class="outcome-detail__objective">${data.detail.objective}</p>
    <p class="outcome-detail__phase" data-outcome-phase=${data.detail.phase}>
      ${phaseLabel(data.detail.phase)}
    </p>
    <p class="outcome-detail__acceptance" data-outcome-acceptance=${acceptanceValidity}>
      ${t("outcomesPage.acceptanceLabel")}: ${acceptanceValidityLabel(acceptanceValidity)}
    </p>
    <p class="outcome-detail__readiness" data-outcome-readiness=${readiness}>
      ${readinessLabel(readiness)}
    </p>
    ${data.detailExpired
      ? html`<section class="outcomes-state" role="alert">
          ${t("outcomesPage.detailsExpired")}
        </section>`
      : nothing}
    ${data.detail.sourceIssues.length > 0
      ? html`<section class="outcome-detail__section" role="alert">
          <ul>
            ${data.detail.sourceIssues.map(
              (issue) => html`<li>${sourceIssueLabel(issue.reason)}</li>`,
            )}
          </ul>
        </section>`
      : nothing}
    <section class="outcome-detail__section" aria-label=${t("outcomesPage.criteria")}>
      <h3>${t("outcomesPage.criteria")}</h3>
      <ul>
        ${data.detail.criteria.map(
          (criterion) => html`
            <li>
              <strong>${criterion.text}</strong>
              <span class="outcome-detail__criterion-kind">
                ${criterion.required
                  ? t("outcomesPage.requiredCriterion")
                  : t("outcomesPage.optionalCriterion")}
              </span>
              ${criterion.workRefs.length > 0
                ? html`<ul aria-label=${t("outcomesPage.linkedCards")}>
                    ${criterion.workRefs.map(
                      (ref) => html`<li>
                        ${t("outcomesPage.linkedCard", { cardId: ref.cardId })}
                        ${data.canUnlink && data.detail?.nextActions.includes("unlink-work")
                          ? html`<button
                              data-outcome-unlink-card=${ref.cardId}
                              data-outcome-unlink-criterion=${criterion.id}
                              type="button"
                              ?disabled=${data.mutationInFlight}
                              @click=${() => data.onUnlink(criterion.id, ref.cardId)}
                            >
                              ${t("outcomesPage.unlinkWork")}
                            </button>`
                          : nothing}
                      </li>`,
                    )}
                  </ul>`
                : nothing}
            </li>
          `,
        )}
      </ul>
    </section>
    ${data.detail.work.length > 0
      ? html`<section class="outcome-detail__section" aria-label=${t("outcomesPage.workLabel")}>
          <h3>${t("outcomesPage.workLabel")}</h3>
          <ul>
            ${data.detail.work.map(
              (work) => html`<li data-outcome-work-card=${work.ref.cardId}>
                ${t("outcomesPage.linkedCard", { cardId: work.ref.cardId })}
                <span>${t("outcomesPage.workStatus", { status: work.status })}</span>
                ${work.upstreamStale ? html`<span>${t("outcomesPage.workStale")}</span>` : nothing}
              </li>`,
            )}
          </ul>
        </section>`
      : nothing}
    ${data.detail.evidence.length > 0
      ? html`<section class="outcome-detail__section" aria-label=${t("outcomesPage.evidenceLabel")}>
          <h3>${t("outcomesPage.evidenceLabel")}</h3>
          <ul>
            ${data.detail.evidence.map(
              (evidence) => html`<li data-outcome-evidence=${evidence.sourceId}>
                ${evidenceKindLabel(evidence.kind)}: ${evidence.label ?? evidence.sourceId}
                ${evidence.proofStatus === undefined
                  ? nothing
                  : html`<span
                      >${t("outcomesPage.proofStatus", { status: evidence.proofStatus })}</span
                    >`}
              </li>`,
            )}
          </ul>
        </section>`
      : nothing}
    ${data.detail.attention.length > 0
      ? html`<section class="outcome-detail__section">
          <h3>${t("outcomesPage.attentionLabel")}</h3>
          <ul>
            ${data.detail.attention.map(
              (attention) => html`<li>${attentionLabel(attention.code)}</li>`,
            )}
          </ul>
        </section>`
      : nothing}
    ${data.detail.nextActions.length > 0
      ? html`<section class="outcome-detail__section">
          <h3>${t("outcomesPage.nextActionsLabel")}</h3>
          <ul>
            ${data.detail.nextActions.map((action) => html`<li>${nextActionLabel(action)}</li>`)}
          </ul>
        </section>`
      : nothing}
    ${data.canEdit && data.detail.nextActions.includes("edit-contract")
      ? html`<section class="outcome-detail__section outcome-detail__actions">
          <button
            data-outcome-action="edit-contract"
            type="button"
            ?disabled=${data.mutationInFlight}
            @click=${data.onRequestEdit}
          >
            ${t("outcomesPage.nextAction.editContract")}
          </button>
        </section>`
      : nothing}
    ${data.canLink && data.detail.nextActions.includes("link-work")
      ? html`<section class="outcome-detail__section outcome-detail__actions">
          <button
            data-outcome-action="link-work"
            type="button"
            ?disabled=${data.mutationInFlight}
            @click=${data.onRequestLink}
          >
            ${t("outcomesPage.nextAction.linkWork")}
          </button>
        </section>`
      : nothing}
    ${data.canActivate && data.detail.nextActions.includes("activate")
      ? html`<section class="outcome-detail__section outcome-detail__actions" aria-live="polite">
          <button
            data-outcome-action="activate"
            type="button"
            ?disabled=${data.mutationInFlight}
            @click=${data.onActivate}
          >
            ${t("outcomesPage.nextAction.activate")}
          </button>
          ${data.mutationError
            ? html`<p class="outcomes-state outcomes-state--error" role="alert">
                ${data.mutationError}
              </p>`
            : nothing}
        </section>`
      : nothing}
    ${data.canRefresh && data.detail.nextActions.includes("refresh")
      ? html`<section class="outcome-detail__section outcome-detail__actions" aria-live="polite">
          <button
            data-outcome-action="refresh"
            type="button"
            ?disabled=${data.refreshing || data.mutationInFlight}
            @click=${data.onRefresh}
          >
            ${data.refreshing ? t("common.refreshing") : t("common.refresh")}
          </button>
          ${data.mutationError
            ? html`<p class="outcomes-state outcomes-state--error" role="alert">
                ${data.mutationError}
              </p>`
            : nothing}
        </section>`
      : nothing}
    ${data.canCancel && data.detail.nextActions.includes("cancel")
      ? html`<button
          class="outcome-detail__cancel"
          data-outcome-action="cancel"
          type="button"
          ?disabled=${data.cancelling || data.mutationInFlight}
          @click=${data.onRequestCancel}
        >
          ${t("common.cancel")}
        </button>`
      : nothing}
    ${data.cancelConfirmationOpen
      ? html`<openclaw-modal-dialog
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
        </openclaw-modal-dialog>`
      : nothing}
    ${data.editDialogOpen
      ? html`<openclaw-modal-dialog
          label=${t("outcomesPage.editOutcome")}
          description=${t("outcomesPage.editHelp")}
          @modal-cancel=${data.onDismissEdit}
        >
          <form
            class="outcome-create-dialog"
            data-outcome-edit-form
            aria-busy=${data.editing ? "true" : "false"}
            @submit=${data.onSubmitEdit}
          >
            <h2>${t("outcomesPage.editOutcome")}</h2>
            <p>${t("outcomesPage.editHelp")}</p>
            <label>
              ${t("outcomesPage.title")}
              <input
                name="title"
                required
                ?disabled=${data.editing}
                .value=${data.editTitle}
                @input=${(event: InputEvent) => data.onEditInput("title", formControlValue(event))}
              />
            </label>
            <label>
              ${t("outcomesPage.objective")}
              <textarea
                name="objective"
                required
                ?disabled=${data.editing}
                .value=${data.editObjective}
                @input=${(event: InputEvent) =>
                  data.onEditInput("objective", formControlValue(event))}
              ></textarea>
            </label>
            <fieldset class="outcome-create-dialog__criteria">
              <legend>${t("outcomesPage.criteria")}</legend>
              ${data.editCriteria.map(
                (criterion, index) => html`
                  <div class="outcome-create-dialog__criterion">
                    <label>
                      ${t("outcomesPage.criterionNumber", { number: String(index + 1) })}
                      <input
                        name="criterion"
                        required
                        ?disabled=${data.editing}
                        .value=${criterion.text}
                        @input=${(event: InputEvent) =>
                          data.onEditCriterionInput(index, formControlValue(event))}
                      />
                    </label>
                    ${data.editCriteria.length > 1
                      ? html`<button
                          data-outcome-remove-edit-criterion=${index}
                          type="button"
                          ?disabled=${data.editing}
                          @click=${() => data.onRequestRemoveEditCriterion(index)}
                        >
                          ${t("outcomesPage.removeCriterion")}
                        </button>`
                      : nothing}
                  </div>
                `,
              )}
              ${data.editCriteria.length < 5
                ? html`<button
                    data-outcome-add-edit-criterion
                    type="button"
                    ?disabled=${data.editing}
                    @click=${data.onRequestAddEditCriterion}
                  >
                    ${t("outcomesPage.addCriterion")}
                  </button>`
                : nothing}
            </fieldset>
            ${data.editError
              ? html`<p class="outcomes-state outcomes-state--error" role="alert">
                  ${data.editError}
                </p>`
              : nothing}
            <div class="outcome-cancel-dialog__actions">
              <button
                data-outcome-dismiss-edit
                type="button"
                ?disabled=${data.editing}
                @click=${() => data.onDismissEdit(new Event("modal-cancel"))}
              >
                ${t("common.back")}
              </button>
              <button data-outcome-confirm-edit type="submit" ?disabled=${data.editing}>
                ${data.editing ? t("common.loading") : t("common.confirm")}
              </button>
            </div>
          </form>
        </openclaw-modal-dialog>`
      : nothing}
    ${data.linkDialogOpen
      ? html`<openclaw-modal-dialog
          label=${t("outcomesPage.linkWork")}
          description=${t("outcomesPage.linkWorkHelp")}
          @modal-cancel=${data.onDismissLink}
        >
          <form
            class="outcome-create-dialog"
            data-outcome-link-form
            aria-busy=${data.linking || data.linkCardsLoading ? "true" : "false"}
            @submit=${data.onSubmitLink}
          >
            <h2>${t("outcomesPage.linkWork")}</h2>
            <p>${t("outcomesPage.linkWorkHelp")}</p>
            <label>
              ${t("outcomesPage.criterion")}
              <select
                name="criterion"
                required
                ?disabled=${data.linking || data.linkCardsLoading}
                .value=${data.linkCriterionId}
                @change=${(event: Event) => data.onLinkCriterionChange(formControlValue(event))}
              >
                ${data.detail.criteria.map(
                  (criterion) => html`<option value=${criterion.id}>${criterion.text}</option>`,
                )}
              </select>
            </label>
            <label>
              ${t("outcomesPage.card")}
              <select
                name="card"
                required
                ?disabled=${data.linking || data.linkCardsLoading || data.linkCards.length === 0}
                .value=${data.linkCardId}
                @change=${(event: Event) => data.onLinkCardChange(formControlValue(event))}
              >
                <option value="">${t("outcomesPage.selectCard")}</option>
                ${data.linkCards.map(
                  (card) => html`<option value=${card.id}>${card.title}</option>`,
                )}
              </select>
            </label>
            ${data.linkCardsLoading ? html`<p role="status">${t("common.loading")}</p>` : nothing}
            ${data.linkError
              ? html`<p class="outcomes-state outcomes-state--error" role="alert">
                  ${data.linkError}
                </p>`
              : nothing}
            <div class="outcome-cancel-dialog__actions">
              <button
                data-outcome-dismiss-link
                type="button"
                ?disabled=${data.linking}
                @click=${() => data.onDismissLink(new Event("modal-cancel"))}
              >
                ${t("common.back")}
              </button>
              <button
                data-outcome-confirm-link
                type="submit"
                ?disabled=${data.linking || data.linkCardsLoading || !data.linkCardId}
              >
                ${data.linking ? t("common.loading") : t("common.confirm")}
              </button>
            </div>
          </form>
        </openclaw-modal-dialog>`
      : nothing}
  </article>`;
}
