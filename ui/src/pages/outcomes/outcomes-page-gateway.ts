import type { OutcomeDetail } from "@openclaw/outcomes-contract";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { getOutcome, listOutcomes } from "./client.ts";
import { isOutcomeDetailFresh, outcomeDetailFreshnessDeadline } from "./freshness.ts";
import {
  mergeOutcomeSummaries,
  replaceOutcomeSummary,
  type OutcomeGatewayIdentity,
  type OutcomeMutationLock,
} from "./outcomes-page-model.ts";
import { OutcomesPageState } from "./outcomes-page-state.ts";

export abstract class OutcomesPageGateway extends OutcomesPageState {
  protected readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      this.revalidateAfterPageResume();
    } else {
      this.stopDetailFreshnessTimer();
    }
  };

  protected readonly handlePageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      this.revalidateAfterPageResume();
    }
  };

  protected readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetGatewayState(),
    ensureInitialData: () => {
      void this.loadOutcomes();
    },
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

  protected observeGatewaySnapshot(snapshot: ApplicationContext["gateway"]["snapshot"]) {
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

  protected authorizationKey(snapshot: ApplicationContext["gateway"]["snapshot"]): string {
    const auth = snapshot.hello?.auth;
    const scopes = auth?.scopes?.toSorted().join("\u0000") ?? "";
    const methods = snapshot.hello?.features?.methods?.toSorted().join("\u0000") ?? "";
    return `${auth?.role ?? ""}\u0001${scopes}\u0001${methods}`;
  }

  protected sameGatewayIdentity(
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

  protected resetGatewayState(preserveSelection = false) {
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

  protected async loadOutcomes() {
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

  protected async loadMoreOutcomes() {
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

  protected selectOutcome(id: string) {
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

  protected clearSelectedOutcome() {
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

  protected restoreListFocus(id: string) {
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

  protected restoreCreateFocus() {
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

  protected canOutcomeAction(
    action: "refresh" | "edit-contract" | "unlink-work" | "activate" | "cancel",
    method:
      | "outcomes.refresh"
      | "outcomes.update"
      | "outcomes.unlinkWorkboard"
      | "outcomes.activate"
      | "outcomes.cancel",
    requireFresh = false,
  ): boolean {
    return Boolean(
      this.detail &&
      this.detail.nextActions.includes(action) &&
      (!requireFresh || !this.isDetailExpired()) &&
      this.gatewayIdentity?.canRead &&
      canCallGatewayMethod(this.gateway.snapshot, method, "operator.write"),
    );
  }

  protected canCreateOutcome(): boolean {
    return Boolean(
      this.gatewayIdentity?.canRead &&
      canCallGatewayMethod(this.gateway.snapshot, "outcomes.create", "operator.write"),
    );
  }

  protected canLinkOutcome(): boolean {
    return Boolean(
      this.detail &&
      this.detail.nextActions.includes("link-work") &&
      this.gatewayIdentity?.canRead &&
      canCallGatewayMethod(this.gateway.snapshot, "outcomes.linkWorkboard", "operator.write") &&
      canCallGatewayMethod(this.gateway.snapshot, "workboard.cards.list", "operator.read"),
    );
  }

  protected outcomeMutationIsInFlight(id: string | null): boolean {
    const ownerId = this.gatewayIdentity?.selfUserId;
    return (
      id !== null &&
      ownerId !== null &&
      this.mutationInFlightOutcomeLocks.some((lock) => lock.id === id && lock.ownerId === ownerId)
    );
  }

  protected beginOutcomeMutation(id: string, ownerId: string): OutcomeMutationLock {
    const lock = { id, ownerId, sequence: ++this.outcomeMutationLockSequence };
    this.mutationInFlightOutcomeLocks = [...this.mutationInFlightOutcomeLocks, lock];
    return lock;
  }

  protected endOutcomeMutation(lock: OutcomeMutationLock) {
    this.mutationInFlightOutcomeLocks = this.mutationInFlightOutcomeLocks.filter(
      (currentLock) => currentLock.sequence !== lock.sequence,
    );
  }

  protected revalidateAfterSettledMutation(lock: OutcomeMutationLock) {
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

  protected replaceOutcome(detail: OutcomeDetail, requestStartedAt = performance.now()) {
    this.detail = detail;
    this.setDetailFreshness(detail, requestStartedAt);
    this.outcomes = replaceOutcomeSummary(this.outcomes, detail);
  }

  protected clearDetailFreshness() {
    this.stopDetailFreshnessTimer();
    this.detailFreshnessDeadline = null;
    this.detailExpired = false;
  }

  protected stopDetailFreshnessTimer() {
    if (this.detailFreshnessTimer !== undefined) {
      globalThis.clearTimeout(this.detailFreshnessTimer);
      this.detailFreshnessTimer = undefined;
    }
  }

  protected setDetailFreshness(detail: OutcomeDetail, requestStartedAt: number) {
    this.clearDetailFreshness();
    const deadline = outcomeDetailFreshnessDeadline(detail, requestStartedAt);
    this.detailFreshnessDeadline = deadline;
    this.detailExpired = !isOutcomeDetailFresh(deadline, performance.now());
    if (deadline === null || this.detailExpired) {
      return;
    }
    this.detailFreshnessTimer = globalThis.setTimeout(
      () => {
        // The delay was calculated from the monotonic request-start deadline.
        // A rendered page needs an observable state transition when that deadline
        // passes, including when the browser advances timers before its monotonic
        // clock is reflected by a subsequent render.
        this.detailExpired = true;
      },
      Math.max(0, deadline - performance.now()),
    );
  }

  protected isDetailExpired(): boolean {
    return (
      this.detailExpired || !isOutcomeDetailFresh(this.detailFreshnessDeadline, performance.now())
    );
  }

  protected revalidateAfterPageResume() {
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

  protected async loadSelectedOutcome() {
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

}
