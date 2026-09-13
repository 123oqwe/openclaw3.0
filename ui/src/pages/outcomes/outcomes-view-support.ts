import type {
  OutcomeAcceptanceValidity,
  OutcomeAttentionCode,
  OutcomeNextAction,
  OutcomePhase,
  OutcomeReadiness,
  OutcomeSummary,
} from "@openclaw/outcomes-contract";
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";

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

function unreachable(value: never): never {
  throw new Error(`Unexpected Outcome display value: ${String(value)}`);
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

export function phaseLabel(phase: OutcomePhase): string {
  switch (phase) {
    case "draft":
      return t("outcomesPage.phase.draft");
    case "active":
      return t("common.active");
    case "accepted":
      return t("outcomesPage.phase.accepted");
    case "cancelled":
      return t("outcomesPage.phase.cancelled");
    default:
      return unreachable(phase);
  }
}

export function acceptanceValidityLabel(validity: OutcomeAcceptanceValidity): string {
  switch (validity) {
    case "current":
      return t("outcomesPage.acceptance.current");
    case "needs-review":
      return t("outcomesPage.acceptance.needsReview");
    case "none":
      return t("outcomesPage.acceptance.none");
    default:
      return unreachable(validity);
  }
}

export function readinessLabel(readiness: OutcomeReadiness): string {
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
    default:
      return unreachable(readiness);
  }
}

export function attentionLabel(code: OutcomeAttentionCode): string {
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
    default:
      return unreachable(code);
  }
}

export function nextActionLabel(action: OutcomeNextAction): string {
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
    default:
      return unreachable(action);
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
  return html`<section
    class="outcomes-list-panel"
    data-outcome-detail-selected=${data.selectedOutcomeId === null ? "false" : "true"}
  >
    ${data.canCreate
      ? html`<button data-outcome-action="create" type="button" @click=${data.onRequestCreate}>
          ${t("outcomesPage.createOutcome")}
        </button>`
      : nothing}
    <section class="outcomes-list" aria-label=${t("outcomesPage.listLabel")}>
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
              aria-label=${t("outcomesPage.viewOutcomeNamed", { title: outcome.title })}
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
      : nothing}
  </section>`;
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
          autofocus
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
                  @input=${(event: InputEvent) =>
                    data.onCriterionInput(index, formControlValue(event))}
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
