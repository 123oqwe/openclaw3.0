import { consume } from "@lit/context";
import type { OutcomeListResult, OutcomeSummary } from "@openclaw/outcomes-contract";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderOutcomesList } from "./view.ts";

class OutcomesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private outcomes: OutcomeSummary[] = [];
  @state() private disconnected = false;
  @state() private loading = false;
  @state() private loaded = false;
  @state() private error: string | null = null;

  private requestGeneration = 0;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetGatewayState(),
    ensureInitialData: () => this.loadOutcomes(),
    onSnapshot: (change) => {
      this.disconnected = change.snapshot.phase !== "connected";
    },
  });

  private resetGatewayState() {
    this.requestGeneration += 1;
    this.outcomes = [];
    this.loading = false;
    this.loaded = false;
    this.error = null;
  }

  private async loadOutcomes() {
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !canCallGatewayMethod(snapshot, "outcomes.list", "operator.read")
    ) {
      return;
    }
    const generation = ++this.requestGeneration;
    this.loading = true;
    this.error = null;
    try {
      const result = await client.request<OutcomeListResult>("outcomes.list", {});
      if (generation === this.requestGeneration && this.gateway.isCurrent(scope)) {
        this.outcomes = result.outcomes;
        this.loaded = true;
      }
    } catch (error) {
      if (generation === this.requestGeneration && this.gateway.isCurrent(scope)) {
        this.error = t("outcomesPage.loadFailed", { error: formatUiError(error) });
        this.loaded = true;
      }
    } finally {
      if (generation === this.requestGeneration && this.gateway.isCurrent(scope)) {
        this.loading = false;
      }
    }
  }

  override render() {
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("outcomes")}</div>
          <p class="muted">${subtitleForRoute("outcomes")}</p>
        </div>
      </section>
      ${renderOutcomesList({
        outcomes: this.outcomes,
        disconnected: this.disconnected,
        loading: this.loading,
        loaded: this.loaded,
        error: this.error,
      })}
    `;
  }
}

if (!customElements.get("openclaw-outcomes-page")) {
  customElements.define("openclaw-outcomes-page", OutcomesPage);
}
