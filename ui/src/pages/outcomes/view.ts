import type {
  OutcomeDetail,
  OutcomeCriterionInput,
  OutcomeAttentionCode,
  OutcomeAcceptanceValidity,
  OutcomeEvidenceKind,
  OutcomeNextAction,
  OutcomePhase,
  OutcomeReadiness,
  OutcomeSourceIssueReason,
  OutcomeSummary,
} from "@openclaw/outcomes-contract";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerOutcomesEnglish } from "../../i18n/locales/en-outcomes.ts";
import "../../styles/outcomes.css";

registerOutcomesEnglish();

export type OutcomesListViewData = {
  canCreate: boolean;
  disconnected: boolean;
  error: string | null;
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
  onRequestCreate: () => void;
  onSelect: (id: string) => void;
  outcomes: readonly OutcomeSummary[];
  selectedOutcomeId: string | null;
  unauthorized: boolean;
};

export type CreateOutcomeDialogViewData = {
  criteria: readonly string[];
  creating: boolean;
  error: string | null;
  objective: string;
  pendingRequest: boolean;
  onAbandonPendingRequest: () => void;
  onAddCriterion: () => void;
  onCriterionInput: (index: number, value: string) => void;
  onDismiss: (event: Event) => void;
  onInput: (field: "title" | "objective", value: string) => void;
  onRemoveCriterion: (index: number) => void;
  onSubmit: (event: SubmitEvent) => void;
  open: boolean;
  title: string;
};

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

function phaseLabel(phase: OutcomePhase): string {
  switch (phase) {
    case "draft":
      return t("outcomesPage.phase.draft");
    case "active":
      return t("common.active");
    case "accepted":
      return t("outcomesPage.phase.accepted");
    case "cancelled":
      return t("outcomesPage.phase.cancelled");
  }
}

function acceptanceValidityLabel(validity: OutcomeAcceptanceValidity): string {
  switch (validity) {
    case "current":
      return t("outcomesPage.acceptance.current");
    case "needs-review":
      return t("outcomesPage.acceptance.needsReview");
    case "none":
      return t("outcomesPage.acceptance.none");
  }
}

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

function readinessLabel(readiness: OutcomeReadiness): string {
  switch (readiness) {
    case "incomplete":
      return t("outcomesPage.readiness.incomplete");
    case "blocked":
      return t("outcomesPage.readiness.blocked");
    case "ready":
      return t("outcomesPage.readiness.ready");
    case "stale":
      return t("outcomesPage.readiness.stale");
    case "unavailable":
      return t("outcomesPage.readiness.unavailable");
  }
}

function attentionLabel(code: OutcomeAttentionCode): string {
  switch (code) {
    case "owner-unavailable":
      return t("outcomesPage.attention.ownerUnavailable");
    case "stale":
      return t("outcomesPage.attention.stale");
    case "blocked":
      return t("outcomesPage.attention.blocked");
    case "contract-incomplete":
      return t("outcomesPage.attention.contractIncomplete");
    case "evidence-missing":
      return t("outcomesPage.attention.evidenceMissing");
    case "verification-required":
      return t("outcomesPage.attention.verificationRequired");
    case "rejected":
      return t("outcomesPage.attention.rejected");
    case "ready-for-acceptance":
      return t("outcomesPage.attention.readyForAcceptance");
    case "acceptance-needs-review":
      return t("outcomesPage.attention.acceptanceNeedsReview");
    case "unknown-operation":
      return t("outcomesPage.attention.unknownOperation");
  }
}

function nextActionLabel(action: OutcomeNextAction): string {
  switch (action) {
    case "edit-contract":
      return t("outcomesPage.nextAction.editContract");
    case "link-work":
      return t("outcomesPage.nextAction.linkWork");
    case "unlink-work":
      return t("outcomesPage.nextAction.unlinkWork");
    case "activate":
      return t("outcomesPage.nextAction.activate");
    case "refresh":
      return t("common.refresh");
    case "cancel":
      return t("common.cancel");
    case "review-evidence":
      return t("outcomesPage.nextAction.reviewEvidence");
    case "accept":
      return t("outcomesPage.nextAction.accept");
    case "observe-operation":
      return t("outcomesPage.nextAction.observeOperation");
  }
}

function sourceIssueLabel(reason: OutcomeSourceIssueReason): string {
  switch (reason) {
    case "workboard-disabled":
      return t("outcomesPage.sourceIssue.workboardDisabled");
    default:
      return t("outcomesPage.sourceIssue.unavailable");
  }
}

export function renderOutcomesList(data: OutcomesListViewData) {
  if (data.disconnected) {
    return html`<section class="outcomes-state" role="status">
      ${t("outcomesPage.disconnected")}
    </section>`;
  }
  if (data.unauthorized) {
    return html`<section class="outcomes-state" role="alert">
      ${t("outcomesPage.unauthorized")}
    </section>`;
  }
  if (data.loading && !data.loaded) {
    return html`<section class="outcomes-state" role="status" aria-live="polite">
      ${t("common.loading")}
    </section>`;
  }
  if (data.error) {
    return html`<section class="outcomes-state outcomes-state--error" role="alert">
      ${data.error}
    </section>`;
  }
  if (!data.loaded) {
    return nothing;
  }
  if (data.outcomes.length === 0) {
    return html`
      ${data.canCreate
        ? html`<button data-outcome-action="create" type="button" @click=${data.onRequestCreate}>
            ${t("outcomesPage.createOutcome")}
          </button>`
        : nothing}
      <section class="outcomes-state" role="status">${t("outcomesPage.empty")}</section>
    `;
  }
  return html`${data.canCreate
      ? html`<button data-outcome-action="create" type="button" @click=${data.onRequestCreate}>
          ${t("outcomesPage.createOutcome")}
        </button>`
      : nothing}<section class="outcomes-list" aria-label=${t("outcomesPage.listLabel")}>
    ${data.outcomes.map(
      (outcome) => html`
        <article class="outcome-summary" data-outcome-id=${outcome.id}>
          <h2 class="outcome-summary__title">${outcome.title}</h2>
          <dl class="outcome-summary__status">
            <div>
              <dt class="sr-only">${t("outcomesPage.phaseLabel")}</dt>
              <dd data-outcome-phase=${outcome.phase}>${phaseLabel(outcome.phase)}</dd>
            </div>
            <div>
              <dt class="sr-only">${t("outcomesPage.readinessLabel")}</dt>
              <dd data-outcome-readiness=${outcome.readiness}>
                ${readinessLabel(outcome.readiness)}
              </dd>
            </div>
          </dl>
          <button
            class="outcome-summary__select"
            data-outcome-select=${outcome.id}
            type="button"
            aria-current=${data.selectedOutcomeId === outcome.id ? "true" : "false"}
            @click=${() => data.onSelect(outcome.id)}
          >
            ${t("outcomesPage.viewOutcome")}
          </button>
        </article>
      `,
    )}
  </section>
  ${data.loadMoreError
    ? html`<p class="outcomes-state outcomes-state--error" role="alert">${data.loadMoreError}</p>`
    : nothing}
  ${data.hasMore
    ? html`<button
        data-outcome-action="load-more"
        type="button"
        ?disabled=${data.loadingMore}
        @click=${data.onLoadMore}
      >
        ${data.loadingMore ? t("common.loading") : t("outcomesPage.loadMore")}
      </button>`
    : nothing}`;
}

export function renderCreateOutcomeDialog(data: CreateOutcomeDialogViewData) {
  if (!data.open) {
    return nothing;
  }
  return html`<openclaw-modal-dialog
    label=${t("outcomesPage.createOutcome")}
    description=${t("outcomesPage.createHelp")}
    @modal-cancel=${data.onDismiss}
  >
    <form
      class="outcome-create-dialog"
      data-outcome-create-form
      aria-busy=${data.creating ? "true" : "false"}
      @submit=${data.onSubmit}
    >
      <h2>${t("outcomesPage.createOutcome")}</h2>
      <p>${t("outcomesPage.createHelp")}</p>
      <label>
        ${t("outcomesPage.title")}
        <input
          name="title"
          required
          ?disabled=${data.creating || data.pendingRequest}
          .value=${data.title}
          @input=${(event: InputEvent) => data.onInput("title", formControlValue(event))}
        />
      </label>
      <label>
        ${t("outcomesPage.objective")}
        <textarea
          name="objective"
          required
          ?disabled=${data.creating || data.pendingRequest}
          .value=${data.objective}
          @input=${(event: InputEvent) => data.onInput("objective", formControlValue(event))}
        ></textarea>
      </label>
      <fieldset class="outcome-create-dialog__criteria">
        <legend>${t("outcomesPage.criteria")}</legend>
        ${data.criteria.map(
          (criterion, index) => html`
            <div class="outcome-create-dialog__criterion">
              <label>
                ${t("outcomesPage.criterionNumber", { number: String(index + 1) })}
                <input
                  name="criterion"
                  required
                  ?disabled=${data.creating || data.pendingRequest}
                  .value=${criterion}
                  @input=${(event: InputEvent) => data.onCriterionInput(index, formControlValue(event))}
                />
              </label>
              ${data.criteria.length > 1
                ? html`<button
                    data-outcome-remove-criterion=${index}
                    type="button"
                    ?disabled=${data.creating || data.pendingRequest}
                    @click=${() => data.onRemoveCriterion(index)}
                  >
                    ${t("outcomesPage.removeCriterion")}
                  </button>`
                : nothing}
            </div>
          `,
        )}
        ${data.criteria.length < 5
          ? html`<button
              data-outcome-add-criterion
              type="button"
              ?disabled=${data.creating || data.pendingRequest}
              @click=${data.onAddCriterion}
            >
              ${t("outcomesPage.addCriterion")}
            </button>`
          : nothing}
      </fieldset>
      ${data.error
        ? html`<p class="outcomes-state outcomes-state--error" role="alert">${data.error}</p>`
        : nothing}
      ${data.pendingRequest
        ? html`<p class="outcomes-state" data-outcome-pending-create>
            ${t("outcomesPage.pendingCreateHelp")}
          </p>`
        : nothing}
      <div class="outcome-cancel-dialog__actions">
        ${data.pendingRequest
          ? html`<button
              data-outcome-abandon-pending-create
              type="button"
              ?disabled=${data.creating}
              @click=${data.onAbandonPendingRequest}
            >
              ${t("outcomesPage.abandonPendingCreate")}
            </button>`
          : nothing}
        <button
          data-outcome-dismiss-create
          type="button"
          ?disabled=${data.creating}
          @click=${() => data.onDismiss(new Event("modal-cancel"))}
        >
          ${t("common.back")}
        </button>
        <button data-outcome-confirm-create type="submit" ?disabled=${data.creating}>
          ${data.creating
            ? t("common.loading")
            : data.pendingRequest
              ? t("outcomesPage.retryCreateOutcome")
              : t("outcomesPage.createOutcome")}
        </button>
      </div>
    </form>
  </openclaw-modal-dialog>`;
}

export function renderOutcomeDetail(data: OutcomeDetailViewData) {
  if (!data.selectedOutcomeId) {
    return nothing;
  }
  if (data.loading) {
    return html`<section class="outcomes-state" role="status" aria-live="polite">
      ${data.revalidating ? t("outcomesPage.revalidatingDetail") : t("outcomesPage.loadingDetail")}
    </section>`;
  }
  if (data.error) {
    return html`<section class="outcomes-state outcomes-state--error" role="alert">
      ${data.error}
    </section>`;
  }
  if (!data.detail) {
    return nothing;
  }
  return html`<article class="outcome-detail" data-outcome-detail-id=${data.detail.id}>
    <button class="outcome-detail__back" type="button" @click=${data.onBack}>
      ${t("common.back")}
    </button>
    <h2 class="outcome-detail__title">${data.detail.title}</h2>
    <p class="outcome-detail__objective">${data.detail.objective}</p>
    <p class="outcome-detail__phase" data-outcome-phase=${data.detail.phase}>
      ${phaseLabel(data.detail.phase)}
    </p>
    <p class="outcome-detail__acceptance" data-outcome-acceptance=${data.detail.acceptanceValidity}>
      ${t("outcomesPage.acceptanceLabel")}: ${acceptanceValidityLabel(
        data.detail.acceptanceValidity,
      )}
    </p>
    <p class="outcome-detail__readiness" data-outcome-readiness=${data.detail.readiness}>
      ${readinessLabel(data.detail.readiness)}
    </p>
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
                ${work.upstreamStale
                  ? html`<span>${t("outcomesPage.workStale")}</span>`
                  : nothing}
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
                  : html`<span>${t("outcomesPage.proofStatus", { status: evidence.proofStatus })}</span>`}
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
                @input=${(event: InputEvent) => data.onEditInput("objective", formControlValue(event))}
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
            ${data.linkCardsLoading
              ? html`<p role="status">${t("common.loading")}</p>`
              : nothing}
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
