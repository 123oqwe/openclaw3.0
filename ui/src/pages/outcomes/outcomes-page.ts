import { consume } from "@lit/context";
import type { OutcomeDetail, OutcomeSummary } from "@openclaw/outcomes-contract";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { getOutcome, listOutcomes } from "./client.ts";
import { renderOutcomeDetail, renderOutcomesList } from "./view.ts";

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
  @state() private detail: OutcomeDetail | null = null;
  @state() private detailError: string | null = null;
  @state() private detailLoading = false;
  @state() private detailRevalidating = false;
  @state() private selectedOutcomeId: string | null = null;

  private requestGeneration = 0;
  private detailRequestSequence = 0;
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
    const identityChanged = previous && !this.sameGatewayIdentity(previous, identity);
    const preserveSelection = Boolean(
      identityChanged &&
      previous &&
      previous.gateway === identity.gateway &&
      previous.client === identity.client &&
      previous.selfUserId === identity.selfUserId &&
      previous.authorizationKey === identity.authorizationKey &&
      previous.canRead &&
      identity.canRead,
    );
    if (identityChanged) {
      this.resetGatewayState(preserveSelection);
    }
    this.disconnected = snapshot.phase !== "connected";
    this.unauthorized = snapshot.phase === "connected" && !identity.canRead;
    if (identityChanged && identity.canRead) {
      void this.loadOutcomes();
      if (preserveSelection && this.selectedOutcomeId) {
        void this.loadSelectedOutcome();
      }
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

  private resetGatewayState(preserveSelection = false) {
    this.requestGeneration += 1;
    this.outcomes = [];
    this.loading = false;
    this.loaded = false;
    this.error = null;
    this.detailRequestSequence += 1;
    this.detail = null;
    this.detailError = null;
    this.detailLoading = preserveSelection && this.selectedOutcomeId !== null;
    this.detailRevalidating = this.detailLoading;
    if (!preserveSelection) {
      this.selectedOutcomeId = null;
    }
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
      const result = await listOutcomes(client);
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

  private selectOutcome(id: string) {
    this.selectedOutcomeId = id;
    this.detail = null;
    this.detailError = null;
    this.detailRevalidating = false;
    void this.loadSelectedOutcome();
  }

  private clearSelectedOutcome() {
    this.detailRequestSequence += 1;
    this.selectedOutcomeId = null;
    this.detail = null;
    this.detailError = null;
    this.detailLoading = false;
    this.detailRevalidating = false;
  }

  private async loadSelectedOutcome() {
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      !id ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.gatewayIdentity?.canRead ||
      !canCallGatewayMethod(snapshot, "outcomes.get", "operator.read")
    ) {
      return;
    }
    const generation = this.requestGeneration;
    const sequence = ++this.detailRequestSequence;
    this.detailLoading = true;
    this.detailError = null;
    try {
      const detail = await getOutcome(client, id);
      if (
        generation === this.requestGeneration &&
        sequence === this.detailRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.detail = detail;
      }
    } catch (error) {
      if (
        generation === this.requestGeneration &&
        sequence === this.detailRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.detailError = t("outcomesPage.loadDetailFailed", { error: formatUiError(error) });
      }
    } finally {
      if (
        generation === this.requestGeneration &&
        sequence === this.detailRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.detailLoading = false;
        this.detailRevalidating = false;
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
        onSelect: (id) => this.selectOutcome(id),
        selectedOutcomeId: this.selectedOutcomeId,
      })}
      ${renderOutcomeDetail({
        detail: this.detail,
        error: this.detailError,
        loading: this.detailLoading,
        revalidating: this.detailRevalidating,
        onBack: () => this.clearSelectedOutcome(),
        selectedOutcomeId: this.selectedOutcomeId,
      })}
    `;
  }
}

if (!customElements.get("openclaw-outcomes-page")) {
  customElements.define("openclaw-outcomes-page", OutcomesPage);
}
