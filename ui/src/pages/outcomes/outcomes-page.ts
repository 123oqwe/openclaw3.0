import { consume } from "@lit/context";
import type { OutcomeListResult, OutcomeSummary } from "@openclaw/outcomes-contract";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderOutcomesList } from "./view.ts";

type OutcomeGatewayIdentity = {
  authorizationKey: string;
  canRead: boolean;
  client: ApplicationContext["gateway"]["snapshot"]["client"];
  connectionRevision: number;
  gateway: ApplicationContext["gateway"] | undefined;
  phase: ApplicationContext["gateway"]["snapshot"]["phase"];
  selfUserId: string | null;
};

class OutcomesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private outcomes: OutcomeSummary[] = [];
  @state() private disconnected = false;
  @state() private unauthorized = false;
  @state() private loading = false;
  @state() private loaded = false;
  @state() private error: string | null = null;

  private requestGeneration = 0;
  private gatewayIdentity: OutcomeGatewayIdentity | null = null;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetGatewayState(),
    ensureInitialData: () => this.loadOutcomes(),
    onSnapshot: (change) => this.observeGatewaySnapshot(change.snapshot),
  });

  private observeGatewaySnapshot(snapshot: ApplicationContext["gateway"]["snapshot"]) {
    const gateway = this.context?.gateway;
    const identity: OutcomeGatewayIdentity = {
      authorizationKey: this.authorizationKey(snapshot),
      canRead: Boolean(
        snapshot.selfUser?.id && canCallGatewayMethod(snapshot, "outcomes.list", "operator.read"),
      ),
      client: snapshot.client,
      connectionRevision: gateway?.connectionRevision ?? -1,
      gateway,
      phase: snapshot.phase,
      selfUserId: snapshot.selfUser?.id ?? null,
    };
    const previous = this.gatewayIdentity;
    this.gatewayIdentity = identity;
    if (previous && !this.sameGatewayIdentity(previous, identity)) {
      this.resetGatewayState();
    }
    this.disconnected = snapshot.phase !== "connected";
    this.unauthorized = snapshot.phase === "connected" && !identity.canRead;
    if (previous && !this.sameGatewayIdentity(previous, identity) && identity.canRead) {
      void this.loadOutcomes();
    }
  }

  private authorizationKey(snapshot: ApplicationContext["gateway"]["snapshot"]): string {
    const auth = snapshot.hello?.auth;
    const scopes = auth?.scopes?.toSorted().join("\u0000") ?? "";
    const methods = snapshot.hello?.features?.methods?.toSorted().join("\u0000") ?? "";
    return `${auth?.role ?? ""}\u0001${scopes}\u0001${methods}`;
  }

  private sameGatewayIdentity(
    left: OutcomeGatewayIdentity,
    right: OutcomeGatewayIdentity,
  ): boolean {
    return (
      left.gateway === right.gateway &&
      left.client === right.client &&
      left.connectionRevision === right.connectionRevision &&
      left.phase === right.phase &&
      left.selfUserId === right.selfUserId &&
      left.authorizationKey === right.authorizationKey
    );
  }

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
      this.loading ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.gatewayIdentity?.canRead ||
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
        unauthorized: this.unauthorized,
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
