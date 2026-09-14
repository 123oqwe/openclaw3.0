import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { deleteOutcome, exportOutcome } from "./client.ts";
import { OutcomesPageAssuranceMutations } from "./outcomes-page-assurance-mutations.ts";

/** Owns the destructive export/delete UI flows and their stale-response guards. */
export abstract class OutcomesPageExportDeleteMutations extends OutcomesPageAssuranceMutations {
  protected async exportSelectedOutcome() {
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (!detail || !id || detail.id !== id || !client || !scope || !this.canExportOutcome()) {
      return;
    }
    this.mutationError = null;
    try {
      const exported = await exportOutcome(client, id);
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `outcome-${id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.mutationError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
      }
    }
  }

  protected openDeleteConfirmation() {
    if (
      !this.canDeleteOutcome() ||
      this.deleting ||
      this.outcomeMutationIsInFlight(this.selectedOutcomeId)
    ) {
      return;
    }
    this.deleteError = null;
    this.deleteConfirmationOpen = true;
  }

  protected dismissDeleteConfirmation(event?: Event) {
    if (this.deleting) {
      event?.preventDefault();
      return;
    }
    this.deleteConfirmationOpen = false;
    this.deleteError = null;
  }

  protected async deleteSelectedOutcome() {
    const detail = this.detail;
    const id = this.selectedOutcomeId;
    const snapshot = this.gateway.snapshot;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      this.deleting ||
      !detail ||
      !id ||
      detail.id !== id ||
      !snapshot?.selfUser?.id ||
      !client ||
      !scope ||
      !this.canDeleteOutcome() ||
      this.outcomeMutationIsInFlight(id)
    ) {
      return;
    }
    const ownerId = snapshot.selfUser.id;
    const sequence = ++this.mutationSequence;
    this.detailRequestSequence += 1;
    this.deleteError = null;
    this.deleting = true;
    const mutationLock = this.beginOutcomeMutation(id, ownerId);
    let mutationResultWasCurrent = false;
    try {
      await deleteOutcome(client, id, detail.revision);
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.outcomes = this.outcomes.filter((outcome) => outcome.id !== id);
        this.deleteConfirmationOpen = false;
        this.clearSelectedOutcome();
      }
    } catch (error) {
      if (
        sequence === this.mutationSequence &&
        id === this.selectedOutcomeId &&
        this.gateway.isCurrent(scope)
      ) {
        mutationResultWasCurrent = true;
        this.deleteError = t("outcomesPage.mutationFailed", { error: formatUiError(error) });
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
        this.deleting = false;
      }
    }
  }
}
