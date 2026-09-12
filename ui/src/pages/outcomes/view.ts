import type {
  OutcomeDetail,
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
  </article>`;
}
