import { consume } from "@lit/context";
import type { OutcomeListResult } from "@openclaw/outcomes-contract";
import { html } from "lit";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

class OutcomesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    ensureInitialData: () => this.loadOutcomes(),
  });

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
    try {
      await client.request<OutcomeListResult>("outcomes.list", {});
    } catch {
      // The first read is intentionally best-effort until the Outcome Center
      // renders its dedicated unavailable and error states.
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
    `;
  }
}

if (!customElements.get("openclaw-outcomes-page")) {
  customElements.define("openclaw-outcomes-page", OutcomesPage);
}
