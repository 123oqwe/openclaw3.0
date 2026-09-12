import type { OutcomeSummary } from "@openclaw/outcomes-contract";
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import "../../styles/outcomes.css";

export type OutcomesListViewData = {
  error: string | null;
  loaded: boolean;
  loading: boolean;
  outcomes: readonly OutcomeSummary[];
};

export function renderOutcomesList(data: OutcomesListViewData) {
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
        </article>
      `,
    )}
  </section>`;
}
