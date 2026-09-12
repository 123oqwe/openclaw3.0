import { consume } from "@lit/context";
import type {
  OutcomeCreateParams,
  OutcomeCriterionInput,
  OutcomeDetail,
  OutcomeSummary,
} from "@openclaw/outcomes-contract";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  activateOutcome,
  cancelOutcome,
  createOutcome,
  getOutcome,
  linkOutcomeWorkboard,
  listAuthorizedWorkboardCards,
  listOutcomes,
  refreshOutcome,
  updateOutcome,
  unlinkOutcomeWorkboard,
} from "./client.ts";
import { isOutcomeDetailFresh, outcomeDetailFreshnessDeadline } from "./freshness.ts";
import { renderCreateOutcomeDialog, renderOutcomeDetail, renderOutcomesList } from "./view.ts";

type OutcomeGatewayIdentity = {
  authorizationKey: string;
  canRead: boolean;
  client: ApplicationContext["gateway"]["snapshot"]["client"];
  connectionRevision: number;
  gateway: ApplicationContext["gateway"] | undefined;
  phase: ApplicationContext["gateway"]["snapshot"]["phase"];
  selfUserId: string | null;
};

type OutcomeMutationLock = {
  id: string;
  ownerId: string;
  sequence: number;
};

function compareOutcomeSummaries(left: OutcomeSummary, right: OutcomeSummary): number {
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function mergeOutcomeSummaries(
  existing: readonly OutcomeSummary[],
  incoming: readonly OutcomeSummary[],
): OutcomeSummary[] {
  const byId = new Map(existing.map((outcome) => [outcome.id, outcome]));
  for (const outcome of incoming) {
    byId.set(outcome.id, outcome);
  }
  return [...byId.values()].toSorted(compareOutcomeSummaries);
}

function sortOutcomeSummaries(outcomes: readonly OutcomeSummary[]): OutcomeSummary[] {
  return [...outcomes].toSorted(compareOutcomeSummaries);
}

class OutcomesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private outcomes: OutcomeSummary[] = [];
  @state() private disconnected = false;
  @state() private unauthorized = false;
  @state() private loading = false;
  @state() private loaded = false;
  @state() private error: string | null = null;
  @state() private nextCursor: string | null = null;
  @state() private loadingMore = false;
  @state() private loadMoreError: string | null = null;
  @state() private detail: OutcomeDetail | null = null;
  @state() private detailError: string | null = null;
  @state() private detailLoading = false;
  @state() private detailRevalidating = false;
  @state() private detailExpired = false;
  @state() private cancelConfirmationOpen = false;
  @state() private cancelError: string | null = null;
  @state() private cancelling = false;
  @state() private mutationError: string | null = null;
  @state() private refreshing = false;
  @state() private selectedOutcomeId: string | null = null;
  @state() private mutationInFlightOutcomeLocks: readonly OutcomeMutationLock[] = [];
  @state() private createDialogOpen = false;
  @state() private creating = false;
  @state() private createError: string | null = null;
  @state() private createTitle = "";
  @state() private createObjective = "";
  @state() private createCriteria: readonly string[] = [""];
  @state() private editDialogOpen = false;
  @state() private editing = false;
  @state() private editError: string | null = null;
  @state() private editTitle = "";
  @state() private editObjective = "";
  @state() private editCriteria: readonly OutcomeCriterionInput[] = [];
  @state() private linkDialogOpen = false;
  @state() private linking = false;
  @state() private linkError: string | null = null;
  @state() private linkCards: readonly WorkboardCard[] = [];
  @state() private linkCardsLoading = false;
  @state() private linkCriterionId = "";
  @state() private linkCardId = "";

  private requestGeneration = 0;
  private detailRequestSequence = 0;
  private mutationSequence = 0;
  private outcomeMutationLockSequence = 0;
  private createRequestSequence = 0;
  private editRequestSequence = 0;
  private linkRequestSequence = 0;
  private createRequest: OutcomeCreateParams | null = null;
  private gatewayIdentity: OutcomeGatewayIdentity | null = null;
  private pendingListFocusId: string | null = null;
  private pendingCreateFocus = false;
  private detailFreshnessDeadline: number | null = null;
  private detailFreshnessTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      this.revalidateAfterPageResume();
    } else {
      this.stopDetailFreshnessTimer();
    }
  };

  private readonly handlePageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      this.revalidateAfterPageResume();
    }
  };

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetGatewayState(),
    ensureInitialData: () => this.loadOutcomes(),
    onSnapshot: (change) => this.observeGatewaySnapshot(change.snapshot),
  });

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    globalThis.addEventListener("pageshow", this.handlePageShow);
  }

  override disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    globalThis.removeEventListener("pageshow", this.handlePageShow);
    this.clearDetailFreshness();
    super.disconnectedCallback();
  }

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
    this.nextCursor = null;
    this.loadingMore = false;
    this.loadMoreError = null;
    this.detailRequestSequence += 1;
    this.detail = null;
    this.clearDetailFreshness();
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
    this.createCriteria = [""];
    this.createRequest = null;
    this.pendingCreateFocus = false;
    this.createRequestSequence += 1;
    this.editDialogOpen = false;
    this.editing = false;
    this.editError = null;
    this.editTitle = "";
    this.editObjective = "";
    this.editCriteria = [];
    this.editRequestSequence += 1;
    this.linkDialogOpen = false;
    this.linking = false;
    this.linkError = null;
    this.linkCards = [];
    this.linkCardsLoading = false;
    this.linkCriterionId = "";
    this.linkCardId = "";
    this.linkRequestSequence += 1;
    this.mutationSequence += 1;
    this.detailLoading = preserveSelection && this.selectedOutcomeId !== null;
    this.detailRevalidating = this.detailLoading;
    this.pendingListFocusId = null;
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
        this.outcomes = mergeOutcomeSummaries([], result.outcomes);
        this.nextCursor = result.nextCursor ?? null;
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

  private async loadMoreOutcomes() {
    const cursor = this.nextCursor;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    const generation = this.requestGeneration;
    if (
      this.loading ||
      this.loadingMore ||
      !cursor ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.gatewayIdentity?.canRead ||
      !canCallGatewayMethod(snapshot, "outcomes.list", "operator.read")
    ) {
      return;
    }
    this.loadingMore = true;
    this.loadMoreError = null;
    try {
      const result = await listOutcomes(client, { cursor });
      if (
        generation === this.requestGeneration &&
        cursor === this.nextCursor &&
        this.gateway.isCurrent(scope)
      ) {
        this.outcomes = mergeOutcomeSummaries(this.outcomes, result.outcomes);
        this.nextCursor = result.nextCursor ?? null;
      }
    } catch (error) {
      if (
        generation === this.requestGeneration &&
        cursor === this.nextCursor &&
        this.gateway.isCurrent(scope)
      ) {
        this.loadMoreError = t("outcomesPage.loadFailed", { error: formatUiError(error) });
      }
    } finally {
      if (generation === this.requestGeneration && this.gateway.isCurrent(scope)) {
        this.loadingMore = false;
      }
    }
  }

  private selectOutcome(id: string) {
    this.mutationSequence += 1;
    this.editRequestSequence += 1;
    this.selectedOutcomeId = id;
    this.detail = null;
    this.clearDetailFreshness();
    this.detailError = null;
    this.detailRevalidating = false;
    this.mutationError = null;
    this.refreshing = false;
    this.cancelConfirmationOpen = false;
    this.cancelError = null;
    this.cancelling = false;
    this.editDialogOpen = false;
    this.editing = false;
    this.editError = null;
    this.linkDialogOpen = false;
    this.linking = false;
    this.linkError = null;
    this.linkCards = [];
    this.linkCardsLoading = false;
    this.linkCriterionId = "";
    this.linkCardId = "";
    this.linkRequestSequence += 1;
    void this.loadSelectedOutcome();
  }

  private clearSelectedOutcome() {
    const focusId = this.selectedOutcomeId;
    this.detailRequestSequence += 1;
    this.editRequestSequence += 1;
    this.selectedOutcomeId = null;
    this.detail = null;
    this.clearDetailFreshness();
    this.detailError = null;
    this.detailLoading = false;
    this.detailRevalidating = false;
    this.mutationError = null;
    this.refreshing = false;
    this.cancelConfirmationOpen = false;
    this.cancelError = null;
    this.cancelling = false;
    this.editDialogOpen = false;
    this.editing = false;
    this.editError = null;
    this.linkDialogOpen = false;
    this.linking = false;
    this.linkError = null;
    this.linkCards = [];
    this.linkCardsLoading = false;
    this.linkCriterionId = "";
    this.linkCardId = "";
    this.linkRequestSequence += 1;
    this.mutationSequence += 1;
    if (focusId) {
      this.restoreListFocus(focusId);
    }
  }

  private restoreListFocus(id: string) {
    // Identity and connection resets clear this page-local intent before the
    // next render, so a detail from another authority cannot steal focus.
    this.pendingListFocusId = id;
    void this.updateComplete.then(() => {
      if (this.pendingListFocusId !== id || this.selectedOutcomeId !== null) {
        return;
      }
      this.pendingListFocusId = null;
      for (const button of this.querySelectorAll<HTMLButtonElement>("[data-outcome-select]")) {
        if (button.getAttribute("data-outcome-select") === id) {
          button.focus({ preventScroll: true });
          return;
        }
      }
    });
  }

  private restoreCreateFocus() {
    this.pendingCreateFocus = true;
    void this.updateComplete.then(() => {
      if (!this.pendingCreateFocus || this.createDialogOpen) {
        return;
      }
      this.pendingCreateFocus = false;
      this.querySelector<HTMLButtonElement>('[data-outcome-action="create"]')?.focus({
        preventScroll: true,
      });
    });
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

  private canEditOutcome(): boolean {
    return Boolean(
      this.detail &&
      this.detail.nextActions.includes("edit-contract") &&
      this.gatewayIdentity?.canRead &&
      canCallGatewayMethod(this.gateway.snapshot, "outcomes.update", "operator.write"),
    );
  }

  private canLinkOutcome(): boolean {
    return Boolean(
      this.detail &&
      this.detail.nextActions.includes("link-work") &&
      this.gatewayIdentity?.canRead &&
      canCallGatewayMethod(this.gateway.snapshot, "outcomes.linkWorkboard", "operator.write") &&
      canCallGatewayMethod(this.gateway.snapshot, "workboard.cards.list", "operator.read"),
    );
  }

  private canUnlinkOutcome(): boolean {
    return Boolean(
      this.detail &&
      this.detail.nextActions.includes("unlink-work") &&
      this.gatewayIdentity?.canRead &&
      canCallGatewayMethod(this.gateway.snapshot, "outcomes.unlinkWorkboard", "operator.write"),
    );
  }

  private canActivateOutcome(): boolean {
    return Boolean(
      this.detail &&
      this.detail.nextActions.includes("activate") &&
      !this.isDetailExpired() &&
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
    const ownerId = this.gatewayIdentity?.selfUserId;
    return (
      id !== null &&
      ownerId !== null &&
      this.mutationInFlightOutcomeLocks.some((lock) => lock.id === id && lock.ownerId === ownerId)
    );
  }

  private beginOutcomeMutation(id: string, ownerId: string): OutcomeMutationLock {
    const lock = { id, ownerId, sequence: ++this.outcomeMutationLockSequence };
    this.mutationInFlightOutcomeLocks = [...this.mutationInFlightOutcomeLocks, lock];
    return lock;
  }

  private endOutcomeMutation(lock: OutcomeMutationLock) {
    this.mutationInFlightOutcomeLocks = this.mutationInFlightOutcomeLocks.filter(
      (currentLock) => currentLock.sequence !== lock.sequence,
    );
  }

  private revalidateAfterSettledMutation(lock: OutcomeMutationLock) {
    if (
      !this.isConnected ||
      this.selectedOutcomeId !== lock.id ||
      this.gatewayIdentity?.selfUserId !== lock.ownerId ||
      this.outcomeMutationIsInFlight(lock.id)
    ) {
      return;
    }
    void this.loadSelectedOutcome();
  }

  private replaceOutcome(detail: OutcomeDetail, requestStartedAt = performance.now()) {
    this.detail = detail;
    this.setDetailFreshness(detail, requestStartedAt);
    this.replaceOutcomeSummary(detail);
  }

  private clearDetailFreshness() {
    this.stopDetailFreshnessTimer();
    this.detailFreshnessDeadline = null;
    this.detailExpired = false;
  }

  private stopDetailFreshnessTimer() {
    if (this.detailFreshnessTimer !== undefined) {
      globalThis.clearTimeout(this.detailFreshnessTimer);
      this.detailFreshnessTimer = undefined;
    }
  }

  private setDetailFreshness(detail: OutcomeDetail, requestStartedAt: number) {
    this.clearDetailFreshness();
    const deadline = outcomeDetailFreshnessDeadline(detail, requestStartedAt);
    this.detailFreshnessDeadline = deadline;
    this.detailExpired = !isOutcomeDetailFresh(deadline, performance.now());
    if (deadline === null || this.detailExpired) {
      return;
    }
    this.detailFreshnessTimer = globalThis.setTimeout(
      () => {
        if (!isOutcomeDetailFresh(this.detailFreshnessDeadline, performance.now())) {
          this.detailExpired = true;
        }
      },
      Math.max(0, deadline - performance.now()),
    );
  }

  private isDetailExpired(): boolean {
    return !isOutcomeDetailFresh(this.detailFreshnessDeadline, performance.now());
  }

  private revalidateAfterPageResume() {
    if (document.visibilityState !== "visible") {
      return;
    }
    this.requestGeneration += 1;
    this.detailRequestSequence += 1;
    this.detail = null;
    this.clearDetailFreshness();
    this.detailError = null;
    this.detailLoading = this.selectedOutcomeId !== null;
    this.detailRevalidating = this.detailLoading;
    this.outcomes = [];
    this.loaded = false;
    this.nextCursor = null;
    this.loading = false;
    void this.loadOutcomes();
    if (this.selectedOutcomeId) {
      void this.loadSelectedOutcome();
    }
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
    this.outcomes = sortOutcomeSummaries(
      hasOutcome
        ? this.outcomes.map((outcome) => (outcome.id === detail.id ? summary : outcome))
        : [...this.outcomes, summary],
    );
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
    this.restoreCreateFocus();
  }

  private abandonPendingCreateRequest() {
    if (this.creating) {
      return;
    }
    this.createRequest = null;
    this.createError = null;
  }

  private updateCreateField(field: "title" | "objective", value: string) {
    if (this.creating) {
      return;
    }
    if (field === "title") {
      if (this.createRequest) {
        return;
      }
      this.createTitle = value;
    } else {
      if (this.createRequest) {
        return;
      }
      this.createObjective = value;
    }
  }

  private updateCreateCriterion(index: number, value: string) {
    if (this.creating || this.createCriteria[index] === value) {
      return;
    }
    if (this.createRequest) {
      return;
    }
    this.createCriteria = this.createCriteria.map((criterion, criterionIndex) =>
      criterionIndex === index ? value : criterion,
    );
  }

  private addCreateCriterion() {
    if (this.creating || this.createCriteria.length >= 5) {
      return;
    }
    if (this.createRequest) {
      return;
    }
    this.createCriteria = [...this.createCriteria, ""];
  }

  private removeCreateCriterion(index: number) {
    if (this.creating || this.createCriteria.length <= 1) {
      return;
    }
    if (this.createRequest) {
      return;
    }
    this.createCriteria = this.createCriteria.filter(
      (_, criterionIndex) => criterionIndex !== index,
    );
  }

  private async submitCreateOutcome(event: SubmitEvent) {
    event.preventDefault();
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    const title = this.createTitle.trim();
    const objective = this.createObjective.trim();
    const criteria = this.createCriteria.map((criterion) => criterion.trim());
    if (
      this.creating ||
      !title ||
      !objective ||
      criteria.length < 1 ||
      criteria.length > 5 ||
      criteria.some((criterion) => !criterion) ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canCreateOutcome()
    ) {
      return;
    }
    const request =
      this.createRequest ??
      ({
        criteria: criteria.map((text) => ({ id: crypto.randomUUID(), required: true, text })),
        id: crypto.randomUUID(),
        objective,
        title,
      } satisfies OutcomeCreateParams);
    this.createRequest = request;
    const sequence = ++this.createRequestSequence;
    this.createError = null;
    this.creating = true;
    try {
      const created = await createOutcome(client, request);
      if (sequence === this.createRequestSequence && this.gateway.isCurrent(scope)) {
        this.replaceOutcomeSummary(created);
        this.createDialogOpen = false;
        this.createTitle = "";
        this.createObjective = "";
        this.createCriteria = [""];
        this.createRequest = null;
        this.restoreCreateFocus();
      }
    } catch (error) {
      if (sequence === this.createRequestSequence && this.gateway.isCurrent(scope)) {
        this.createError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      if (sequence === this.createRequestSequence && this.gateway.isCurrent(scope)) {
        this.creating = false;
      }
    }
  }

  private openEditDialog() {
    const detail = this.detail;
    if (!detail || this.editing || !this.canEditOutcome()) {
      return;
    }
    this.editError = null;
    this.editTitle = detail.title;
    this.editObjective = detail.objective;
    this.editCriteria = detail.criteria.map(({ id, required, text }) => ({ id, required, text }));
    this.editDialogOpen = true;
  }

  private dismissEditDialog(event?: Event) {
    if (this.editing) {
      event?.preventDefault();
      return;
    }
    this.editDialogOpen = false;
    this.editError = null;
  }

  private updateEditField(field: "title" | "objective", value: string) {
    if (this.editing) {
      return;
    }
    if (field === "title") {
      this.editTitle = value;
    } else {
      this.editObjective = value;
    }
  }

  private updateEditCriterion(index: number, text: string) {
    if (this.editing) {
      return;
    }
    this.editCriteria = this.editCriteria.map((criterion, criterionIndex) =>
      criterionIndex === index ? { ...criterion, text } : criterion,
    );
  }

  private addEditCriterion() {
    if (this.editing || this.editCriteria.length >= 5) {
      return;
    }
    this.editCriteria = [
      ...this.editCriteria,
      { id: crypto.randomUUID(), required: true, text: "" },
    ];
  }

  private removeEditCriterion(index: number) {
    if (this.editing || this.editCriteria.length <= 1) {
      return;
    }
    this.editCriteria = this.editCriteria.filter((_, criterionIndex) => criterionIndex !== index);
  }

  private async submitEditOutcome(event: SubmitEvent) {
    event.preventDefault();
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    const title = this.editTitle.trim();
    const objective = this.editObjective.trim();
    const criteria = this.editCriteria.map((criterion) => ({
      ...criterion,
      text: criterion.text.trim(),
    }));
    if (
      this.editing ||
      !detail ||
      !id ||
      detail.id !== id ||
      !title ||
      !objective ||
      criteria.length < 1 ||
      criteria.length > 5 ||
      criteria.some((criterion) => !criterion.text) ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canEditOutcome()
    ) {
      return;
    }
    const ownerId = snapshot.selfUser.id;
    const expectedRevision = detail.revision;
    const sequence = ++this.editRequestSequence;
    this.editError = null;
    this.editing = true;
    this.detailRequestSequence += 1;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const updated = await updateOutcome(client, id, expectedRevision, {
        criteria,
        objective,
        title,
      });
      if (
        sequence === this.editRequestSequence &&
        id === this.selectedOutcomeId &&
        updated.revision >= expectedRevision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(updated, requestStartedAt);
        this.editDialogOpen = false;
      }
    } catch (error) {
      if (
        sequence === this.editRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.editError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(mutationLock);
      if (!mutationResultWasCurrent) {
        this.revalidateAfterSettledMutation(mutationLock);
      }
      if (
        sequence === this.editRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.editing = false;
      }
    }
  }

  private async openLinkDialog() {
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      !detail ||
      !id ||
      detail.id !== id ||
      this.linking ||
      !client ||
      !scope ||
      !this.canLinkOutcome()
    ) {
      return;
    }
    const sequence = ++this.linkRequestSequence;
    this.linkDialogOpen = true;
    this.linkError = null;
    this.linkCards = [];
    this.linkCardsLoading = true;
    this.linkCriterionId = detail.criteria[0]?.id ?? "";
    this.linkCardId = "";
    try {
      const result = await listAuthorizedWorkboardCards(client);
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.linkCards = result.cards;
      }
    } catch (error) {
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.linkError = t("outcomesPage.loadCardsFailed", { error: formatUiError(error) });
      }
    } finally {
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.linkCardsLoading = false;
      }
    }
  }

  private dismissLinkDialog(event?: Event) {
    if (this.linking) {
      event?.preventDefault();
      return;
    }
    this.linkDialogOpen = false;
    this.linkError = null;
    this.linkCardsLoading = false;
  }

  private updateLinkCriterion(id: string) {
    if (!this.linking) {
      this.linkCriterionId = id;
    }
  }

  private updateLinkCard(id: string) {
    if (!this.linking) {
      this.linkCardId = id;
    }
  }

  private async submitLinkOutcome(event: SubmitEvent) {
    event.preventDefault();
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    const criterionId = this.linkCriterionId;
    const cardId = this.linkCardId;
    if (
      this.linking ||
      !detail ||
      !id ||
      detail.id !== id ||
      !criterionId ||
      !detail.criteria.some((criterion) => criterion.id === criterionId) ||
      !cardId ||
      !this.linkCards.some((card) => card.id === cardId) ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canLinkOutcome() ||
      this.outcomeMutationIsInFlight(id)
    ) {
      return;
    }
    const ownerId = snapshot.selfUser.id;
    const expectedRevision = detail.revision;
    const sequence = ++this.linkRequestSequence;
    this.linkError = null;
    this.linking = true;
    this.detailRequestSequence += 1;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const linked = await linkOutcomeWorkboard(client, {
        cardId,
        criterionId,
        expectedRevision,
        id,
      });
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        linked.revision >= expectedRevision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(linked, requestStartedAt);
        this.linkDialogOpen = false;
      }
    } catch (error) {
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.linkError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(mutationLock);
      if (!mutationResultWasCurrent) {
        this.revalidateAfterSettledMutation(mutationLock);
      }
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        this.linking = false;
      }
    }
  }

  private async unlinkWorkboardCard(criterionId: string, cardId: string) {
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      !detail ||
      !id ||
      detail.id !== id ||
      !detail.criteria.some(
        (criterion) =>
          criterion.id === criterionId &&
          criterion.workRefs.some((reference) => reference.cardId === cardId),
      ) ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canUnlinkOutcome() ||
      this.outcomeMutationIsInFlight(id)
    ) {
      return;
    }
    const ownerId = snapshot.selfUser.id;
    const expectedRevision = detail.revision;
    const sequence = ++this.linkRequestSequence;
    this.mutationError = null;
    this.detailRequestSequence += 1;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const unlinked = await unlinkOutcomeWorkboard(client, {
        cardId,
        criterionId,
        expectedRevision,
        id,
      });
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        unlinked.revision >= expectedRevision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(unlinked, requestStartedAt);
      }
    } catch (error) {
      if (
        sequence === this.linkRequestSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.mutationError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(mutationLock);
      if (!mutationResultWasCurrent) {
        this.revalidateAfterSettledMutation(mutationLock);
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
    const ownerId = snapshot.selfUser.id;
    const sequence = ++this.mutationSequence;
    this.detailRequestSequence += 1;
    this.cancelError = null;
    this.cancelling = true;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const cancelled = await cancelOutcome(client, id, detail.revision);
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        cancelled.revision >= detail.revision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(cancelled, requestStartedAt);
        this.cancelConfirmationOpen = false;
      }
    } catch (error) {
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.cancelError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(mutationLock);
      if (!mutationResultWasCurrent) {
        this.revalidateAfterSettledMutation(mutationLock);
      }
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
    const ownerId = snapshot.selfUser.id;
    const sequence = ++this.mutationSequence;
    this.detailRequestSequence += 1;
    this.mutationError = null;
    this.refreshing = true;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const refreshed = await refreshOutcome(client, id, detail.revision);
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        refreshed.revision >= detail.revision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(refreshed, requestStartedAt);
      }
    } catch (error) {
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.mutationError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(mutationLock);
      if (!mutationResultWasCurrent) {
        this.revalidateAfterSettledMutation(mutationLock);
      }
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
    const ownerId = snapshot.selfUser.id;
    const sequence = ++this.mutationSequence;
    this.detailRequestSequence += 1;
    this.mutationError = null;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    const requestStartedAt = performance.now();
    let mutationResultWasCurrent = false;
    try {
      const activated = await activateOutcome(client, id, detail.revision);
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        activated.revision >= detail.revision &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.detailRequestSequence += 1;
        this.replaceOutcome(activated, requestStartedAt);
      }
    } catch (error) {
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.mutationError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    } finally {
      this.endOutcomeMutation(mutationLock);
      if (!mutationResultWasCurrent) {
        this.revalidateAfterSettledMutation(mutationLock);
      }
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
    const requestStartedAt = performance.now();
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
        this.replaceOutcome(detail, requestStartedAt);
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
        hasMore: this.nextCursor !== null,
        canCreate: this.canCreateOutcome(),
        loadingMore: this.loadingMore,
        loadMoreError: this.loadMoreError,
        onLoadMore: () => void this.loadMoreOutcomes(),
        onRequestCreate: () => this.openCreateDialog(),
        onSelect: (id) => this.selectOutcome(id),
        selectedOutcomeId: this.selectedOutcomeId,
      })}
      ${renderCreateOutcomeDialog({
        criteria: this.createCriteria,
        creating: this.creating,
        error: this.createError,
        objective: this.createObjective,
        pendingRequest: this.createRequest !== null,
        onAbandonPendingRequest: () => this.abandonPendingCreateRequest(),
        onAddCriterion: () => this.addCreateCriterion(),
        onDismiss: (event) => this.dismissCreateDialog(event),
        onInput: (field, value) => this.updateCreateField(field, value),
        onRemoveCriterion: (index) => this.removeCreateCriterion(index),
        onCriterionInput: (index, value) => this.updateCreateCriterion(index, value),
        onSubmit: (event) => void this.submitCreateOutcome(event),
        open: this.createDialogOpen,
        title: this.createTitle,
      })}
      ${renderOutcomeDetail({
        detail: this.detail,
        detailExpired: this.isDetailExpired(),
        error: this.detailError,
        loading: this.detailLoading,
        canActivate: this.canActivateOutcome(),
        canCancel: this.canCancelOutcome(),
        canEdit: this.canEditOutcome(),
        canLink: this.canLinkOutcome(),
        canRefresh: this.canRefreshOutcome(),
        canUnlink: this.canUnlinkOutcome(),
        cancelConfirmationOpen: this.cancelConfirmationOpen,
        cancelError: this.cancelError,
        cancelling: this.cancelling,
        mutationError: this.mutationError,
        mutationInFlight: this.outcomeMutationIsInFlight(this.selectedOutcomeId),
        onActivate: () => void this.activateSelectedOutcome(),
        onDismissEdit: (event) => this.dismissEditDialog(event),
        onEditCriterionInput: (index, value) => this.updateEditCriterion(index, value),
        onEditInput: (field, value) => this.updateEditField(field, value),
        onRequestAddEditCriterion: () => this.addEditCriterion(),
        onRequestEdit: () => this.openEditDialog(),
        onRequestLink: () => void this.openLinkDialog(),
        onRequestRemoveEditCriterion: (index) => this.removeEditCriterion(index),
        onSubmitEdit: (event) => void this.submitEditOutcome(event),
        onDismissLink: (event) => this.dismissLinkDialog(event),
        onLinkCardChange: (id) => this.updateLinkCard(id),
        onLinkCriterionChange: (id) => this.updateLinkCriterion(id),
        onSubmitLink: (event) => void this.submitLinkOutcome(event),
        onUnlink: (criterionId, cardId) => void this.unlinkWorkboardCard(criterionId, cardId),
        onCancelConfirmationDismiss: (event) => this.dismissCancelConfirmation(event),
        onConfirmCancel: () => void this.cancelSelectedOutcome(),
        onRequestCancel: () => this.openCancelConfirmation(),
        onRefresh: () => void this.refreshSelectedOutcome(),
        revalidating: this.detailRevalidating,
        refreshing: this.refreshing,
        onBack: () => this.clearSelectedOutcome(),
        selectedOutcomeId: this.selectedOutcomeId,
        editCriteria: this.editCriteria,
        editDialogOpen: this.editDialogOpen,
        editError: this.editError,
        editing: this.editing,
        editObjective: this.editObjective,
        editTitle: this.editTitle,
        linkCardId: this.linkCardId,
        linkCards: this.linkCards,
        linkCardsLoading: this.linkCardsLoading,
        linkCriterionId: this.linkCriterionId,
        linkDialogOpen: this.linkDialogOpen,
        linkError: this.linkError,
        linking: this.linking,
      })}
    `;
  }
}

if (!customElements.get("openclaw-outcomes-page")) {
  customElements.define("openclaw-outcomes-page", OutcomesPage);
}
