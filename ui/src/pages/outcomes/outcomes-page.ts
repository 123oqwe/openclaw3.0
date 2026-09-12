import { consume } from "@lit/context";
import type { OutcomeDetail, OutcomeSummary } from "@openclaw/outcomes-contract";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerOutcomesEnglish } from "../../i18n/locales/en-outcomes.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  activateOutcome,
  cancelOutcome,
  createOutcome,
  getOutcome,
  listOutcomes,
  refreshOutcome,
} from "./client.ts";
import { renderCreateOutcomeDialog, renderOutcomeDetail, renderOutcomesList } from "./view.ts";

registerOutcomesEnglish();

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
  @state() private cancelConfirmationOpen = false;
  @state() private cancelError: string | null = null;
  @state() private cancelling = false;
  @state() private mutationError: string | null = null;
  @state() private refreshing = false;
  @state() private selectedOutcomeId: string | null = null;
  @state() private mutationInFlightOutcomeIds: readonly string[] = [];
  @state() private createDialogOpen = false;
  @state() private creating = false;
  @state() private createError: string | null = null;
  @state() private createTitle = "";
  @state() private createObjective = "";
  @state() private createCriterion = "";

  private requestGeneration = 0;
  private detailRequestSequence = 0;
  private mutationSequence = 0;
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
    this.mutationError = null;
    this.refreshing = false;
    this.cancelConfirmationOpen = false;
    this.cancelError = null;
    this.cancelling = false;
    this.createDialogOpen = false;
    this.creating = false;
    this.createError = null;
    this.createTitle = "";
    this.createObjective = "";
    this.createCriterion = "";
    this.mutationSequence += 1;
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
    this.mutationSequence += 1;
    this.selectedOutcomeId = id;
    this.detail = null;
    this.detailError = null;
    this.detailRevalidating = false;
    this.mutationError = null;
    this.refreshing = false;
    this.cancelConfirmationOpen = false;
    this.cancelError = null;
    this.cancelling = false;
    void this.loadSelectedOutcome();
  }

  private clearSelectedOutcome() {
    this.detailRequestSequence += 1;
    this.selectedOutcomeId = null;
    this.detail = null;
    this.detailError = null;
    this.detailLoading = false;
    this.detailRevalidating = false;
    this.mutationError = null;
    this.refreshing = false;
    this.cancelConfirmationOpen = false;
    this.cancelError = null;
    this.cancelling = false;
    this.mutationSequence += 1;
  }

  private canRefreshOutcome(): boolean {
    return Boolean(
      this.detail &&
        this.detail.nextActions.includes("refresh") &&
        this.gatewayIdentity?.canRead &&
        canCallGatewayMethod(this.gateway.snapshot, "outcomes.refresh", "operator.write"),
    );
  }

  private canCreateOutcome(): boolean {
    return Boolean(
      this.gatewayIdentity?.canRead &&
        canCallGatewayMethod(this.gateway.snapshot, "outcomes.create", "operator.write"),
    );
  }

  private canActivateOutcome(): boolean {
    return Boolean(
      this.detail &&
        this.detail.nextActions.includes("activate") &&
        this.gatewayIdentity?.canRead &&
        canCallGatewayMethod(this.gateway.snapshot, "outcomes.activate", "operator.write"),
    );
  }

  private canCancelOutcome(): boolean {
    return Boolean(
      this.detail &&
        this.detail.nextActions.includes("cancel") &&
        this.gatewayIdentity?.canRead &&
        canCallGatewayMethod(this.gateway.snapshot, "outcomes.cancel", "operator.write"),
    );
  }

  private outcomeMutationIsInFlight(id: string | null): boolean {
    return id !== null && this.mutationInFlightOutcomeIds.includes(id);
  }

  private beginOutcomeMutation(id: string) {
    this.mutationInFlightOutcomeIds = [...this.mutationInFlightOutcomeIds, id];
  }

  private endOutcomeMutation(id: string) {
    this.mutationInFlightOutcomeIds = this.mutationInFlightOutcomeIds.filter(
      (outcomeId) => outcomeId !== id,
    );
  }

  private replaceOutcome(detail: OutcomeDetail) {
    this.detail = detail;
    this.replaceOutcomeSummary(detail);
  }

  private replaceOutcomeSummary(detail: OutcomeDetail) {
    const summary: OutcomeSummary = {
      acceptanceValidity: detail.acceptanceValidity,
      id: detail.id,
      phase: detail.phase,
      readiness: detail.readiness,
      revision: detail.revision,
      title: detail.title,
      updatedAt: detail.updatedAt,
    };
    const hasOutcome = this.outcomes.some((outcome) => outcome.id === detail.id);
    this.outcomes = hasOutcome
      ? this.outcomes.map((outcome) => (outcome.id === detail.id ? summary : outcome))
      : [...this.outcomes, summary];
  }

  private openCreateDialog() {
    if (!this.canCreateOutcome() || this.creating) {
      return;
    }
    this.createError = null;
    this.createDialogOpen = true;
  }

  private dismissCreateDialog(event?: Event) {
    if (this.creating) {
      event?.preventDefault();
      return;
    }
    this.createDialogOpen = false;
    this.createError = null;
  }

  private updateCreateField(field: "title" | "objective" | "criterion", value: string) {
    if (field === "title") {
      this.createTitle = value;
    } else if (field === "objective") {
      this.createObjective = value;
    } else {
      this.createCriterion = value;
    }
  }

  private async submitCreateOutcome(event: SubmitEvent) {
    event.preventDefault();
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    const title = this.createTitle.trim();
    const objective = this.createObjective.trim();
    const criterion = this.createCriterion.trim();
    if (
      this.creating ||
      !title ||
      !objective ||
      !criterion ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canCreateOutcome()
    ) {
      return;
    }
    const sequence = ++this.mutationSequence;
    this.createError = null;
    this.creating = true;
    try {
      const created = await createOutcome(client, {
        criteria: [{ id: crypto.randomUUID(), required: true, text: criterion }],
        id: crypto.randomUUID(),
        objective,
        title,
      });
      if (sequence === this.mutationSequence && this.gateway.isCurrent(scope)) {
        this.replaceOutcomeSummary(created);
        this.createDialogOpen = false;
        this.createTitle = "";
        this.createObjective = "";
        this.createCriterion = "";
      }
    } catch (error) {
      if (sequence === this.mutationSequence && this.gateway.isCurrent(scope)) {
        this.createError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      if (sequence === this.mutationSequence && this.gateway.isCurrent(scope)) {
        this.creating = false;
      }
    }
  }

  private openCancelConfirmation() {
    if (
      !this.canCancelOutcome() ||
      this.cancelling ||
      this.outcomeMutationIsInFlight(this.selectedOutcomeId)
    ) {
      return;
    }
    this.cancelError = null;
    this.cancelConfirmationOpen = true;
  }

  private dismissCancelConfirmation(event?: Event) {
    if (this.cancelling) {
      event?.preventDefault();
      return;
    }
    this.cancelConfirmationOpen = false;
    this.cancelError = null;
  }

  private async cancelSelectedOutcome() {
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      this.cancelling ||
      !detail ||
      !id ||
      detail.id !== id ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canCancelOutcome() ||
      this.outcomeMutationIsInFlight(id)
    ) {
      return;
    }
    const sequence = ++this.mutationSequence;
    this.detailRequestSequence += 1;
    this.cancelError = null;
    this.cancelling = true;
    this.beginOutcomeMutation(id);
    try {
      const cancelled = await cancelOutcome(client, id, detail.revision);
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        cancelled.revision >= detail.revision &&
        this.gateway.isCurrent(scope)
      ) {
        this.replaceOutcome(cancelled);
        this.cancelConfirmationOpen = false;
      }
    } catch (error) {
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.cancelError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(id);
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.cancelling = false;
      }
    }
  }

  private async refreshSelectedOutcome() {
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      this.refreshing ||
      !detail ||
      !id ||
      detail.id !== id ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canRefreshOutcome() ||
      this.outcomeMutationIsInFlight(id)
    ) {
      return;
    }
    const sequence = ++this.mutationSequence;
    this.detailRequestSequence += 1;
    this.mutationError = null;
    this.refreshing = true;
    this.beginOutcomeMutation(id);
    try {
      const refreshed = await refreshOutcome(client, id, detail.revision);
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        refreshed.revision >= detail.revision &&
        this.gateway.isCurrent(scope)
      ) {
        this.replaceOutcome(refreshed);
      }
    } catch (error) {
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.mutationError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(id);
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.refreshing = false;
      }
    }
  }

  private async activateSelectedOutcome() {
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      !detail ||
      !id ||
      detail.id !== id ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canActivateOutcome() ||
      this.outcomeMutationIsInFlight(id)
    ) {
      return;
    }
    const sequence = ++this.mutationSequence;
    this.detailRequestSequence += 1;
    this.mutationError = null;
    this.beginOutcomeMutation(id);
    try {
      const activated = await activateOutcome(client, id, detail.revision);
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        activated.revision >= detail.revision &&
        this.gateway.isCurrent(scope)
      ) {
        this.replaceOutcome(activated);
      }
    } catch (error) {
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.mutationError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(id);
    }
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
        canCreate: this.canCreateOutcome(),
        onRequestCreate: () => this.openCreateDialog(),
        onSelect: (id) => this.selectOutcome(id),
        selectedOutcomeId: this.selectedOutcomeId,
      })}
      ${renderCreateOutcomeDialog({
        criterion: this.createCriterion,
        creating: this.creating,
        error: this.createError,
        objective: this.createObjective,
        onDismiss: (event) => this.dismissCreateDialog(event),
        onInput: (field, value) => this.updateCreateField(field, value),
        onSubmit: (event) => void this.submitCreateOutcome(event),
        open: this.createDialogOpen,
        title: this.createTitle,
      })}
      ${renderOutcomeDetail({
        detail: this.detail,
        error: this.detailError,
        loading: this.detailLoading,
        canActivate: this.canActivateOutcome(),
        canCancel: this.canCancelOutcome(),
        canRefresh: this.canRefreshOutcome(),
        cancelConfirmationOpen: this.cancelConfirmationOpen,
        cancelError: this.cancelError,
        cancelling: this.cancelling,
        mutationError: this.mutationError,
        mutationInFlight: this.outcomeMutationIsInFlight(this.selectedOutcomeId),
        onActivate: () => void this.activateSelectedOutcome(),
        onCancelConfirmationDismiss: (event) => this.dismissCancelConfirmation(event),
        onConfirmCancel: () => void this.cancelSelectedOutcome(),
        onRequestCancel: () => this.openCancelConfirmation(),
        onRefresh: () => void this.refreshSelectedOutcome(),
        revalidating: this.detailRevalidating,
        refreshing: this.refreshing,
        onBack: () => this.clearSelectedOutcome(),
        selectedOutcomeId: this.selectedOutcomeId,
      })}
    `;
  }
}

if (!customElements.get("openclaw-outcomes-page")) {
  customElements.define("openclaw-outcomes-page", OutcomesPage);
}
