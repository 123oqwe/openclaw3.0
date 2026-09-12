import { html } from "lit";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

class OutcomesPage extends OpenClawLightDomElement {
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
