import type { OutcomePhase, OutcomeReadiness, OutcomeSummary } from "@openclaw/outcomes-contract";
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import "../../styles/outcomes.css";

export type OutcomesListViewData = {
  disconnected: boolean;
  error: string | null;
  loaded: boolean;
  loading: boolean;
  outcomes: readonly OutcomeSummary[];
  unauthorized: boolean;
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
        </article>
      `,
    )}
  </section>`;
}
