import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Outcome-only copy is registered when the lazy Outcomes page loads, keeping
// its workflow labels out of the Control UI startup bundle.
const enOutcomes = {
  outcomesPage: {
    listLabel: "Outcomes",
    phaseLabel: "Phase",
    readinessLabel: "Readiness",
    loadingDetail: "Loading details",
    revalidatingDetail: "Checking outcome details",
    empty: "No outcomes",
    loadFailed: "Couldn't load outcomes: {error}",
    loadDetailFailed: "Couldn't load outcome details: {error}",
    mutationFailed: "Request failed: {error}",
    createOutcome: "Create outcome",
    createHelp: "Start an Outcome with its first required criterion.",
    title: "Title",
    objective: "Objective",
    criterion: "Criterion",
    criterionNumber: "Criterion {number}",
    addCriterion: "Add criterion",
    removeCriterion: "Remove criterion",
    cancelOutcome: "Cancel outcome",
    cancelHelp: "Stops tracking permanently.",
    cancelling: "Cancelling",
    disconnected: "Outcome connection unavailable",
    unauthorized: "Outcome access unavailable",
    viewOutcome: "View",
    criteria: "Criteria",
    requiredCriterion: "Required",
    optionalCriterion: "Optional",
    linkedCards: "Linked cards",
    linkedCard: "Card {cardId}",
    sourceIssue: {
      workboardDisabled: "Workboard disabled",
      unavailable: "Linked source unavailable",
    },
    attentionLabel: "Attention",
    nextActionsLabel: "Next actions",
    attention: {
      ownerUnavailable: "Owner unavailable",
      stale: "Information is stale",
      blocked: "A linked card is blocked",
      contractIncomplete: "The Outcome contract is incomplete",
      evidenceMissing: "Evidence is missing",
      verificationRequired: "Verification is required",
      rejected: "A decision was rejected",
      readyForAcceptance: "Ready for acceptance",
      acceptanceNeedsReview: "Acceptance needs review",
      unknownOperation: "An operation needs observation",
    },
    nextAction: {
      editContract: "Edit contract",
      linkWork: "Link work",
      unlinkWork: "Unlink work",
      activate: "Start tracking",
      reviewEvidence: "Review evidence",
      accept: "Accept",
      observeOperation: "Observe operation",
    },
    phase: {
      draft: "Draft",
      accepted: "Accepted",
      cancelled: "Cancelled",
    },
    readiness: {
      incomplete: "Incomplete",
      blocked: "Blocked",
      ready: "Ready",
      stale: "Stale",
      unavailable: "Unavailable",
    },
  },
} satisfies TranslationMap;

export const registerOutcomesEnglish = Object.assign(
  () => {
    en.outcomesPage = enOutcomes.outcomesPage;
  },
  { catalog: enOutcomes },
);
