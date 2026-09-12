import type {
  OutcomeDetail,
  OutcomeAttentionCode,
  OutcomeNextAction,
  OutcomePhase,
  OutcomeReadiness,
  OutcomeSummary,
} from "@openclaw/outcomes-contract";
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import "../../styles/outcomes.css";

export type OutcomesListViewData = {
  disconnected: boolean;
  error: string | null;
  loaded: boolean;
  loading: boolean;
  onSelect: (id: string) => void;
  outcomes: readonly OutcomeSummary[];
  selectedOutcomeId: string | null;
  unauthorized: boolean;
};

export type OutcomeDetailViewData = {
  detail: OutcomeDetail | null;
  error: string | null;
  loading: boolean;
  onBack: () => void;
  selectedOutcomeId: string | null;
};

function phaseLabel(phase: OutcomePhase): string {
  switch (phase) {
    case "draft":
      return t("outcomesPage.phase.draft");
    case "active":
      return t("outcomesPage.phase.active");
    case "accepted":
      return t("outcomesPage.phase.accepted");
    case "cancelled":
      return t("outcomesPage.phase.cancelled");
  }
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
      return t("outcomesPage.nextAction.refresh");
    case "cancel":
      return t("outcomesPage.nextAction.cancel");
    case "review-evidence":
      return t("outcomesPage.nextAction.reviewEvidence");
    case "accept":
      return t("outcomesPage.nextAction.accept");
    case "observe-operation":
      return t("outcomesPage.nextAction.observeOperation");
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
      ${t("outcomesPage.loading")}
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
    return html`<section class="outcomes-state" role="status">${t("outcomesPage.empty")}</section>`;
  }
  return html`<section class="outcomes-list" aria-label=${t("outcomesPage.listLabel")}>
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
  </section>`;
}

export function renderOutcomeDetail(data: OutcomeDetailViewData) {
  if (!data.selectedOutcomeId) {
    return nothing;
  }
  if (data.loading) {
    return html`<section class="outcomes-state" role="status" aria-live="polite">
      ${t("outcomesPage.loadingDetail")}
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
      ${t("outcomesPage.backToList")}
    </button>
    <h2 class="outcome-detail__title">${data.detail.title}</h2>
    <p class="outcome-detail__objective">${data.detail.objective}</p>
    <p class="outcome-detail__readiness" data-outcome-readiness=${data.detail.readiness}>
      ${readinessLabel(data.detail.readiness)}
    </p>
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
                      (ref) =>
                        html`<li>${t("outcomesPage.linkedCard", { cardId: ref.cardId })}</li>`,
                    )}
                  </ul>`
                : nothing}
            </li>
          `,
        )}
      </ul>
    </section>
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
  </article>`;
}
