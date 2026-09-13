import type { OutcomeDetail, OutcomeSummary } from "@openclaw/outcomes-contract";
import type { ApplicationContext } from "../../app/context.ts";

export type OutcomeGatewayIdentity = {
  authorizationKey: string;
  canRead: boolean;
  client: ApplicationContext["gateway"]["snapshot"]["client"];
  connectionRevision: number;
  gateway: ApplicationContext["gateway"] | undefined;
  phase: ApplicationContext["gateway"]["snapshot"]["phase"];
  selfUserId: string | null;
};

export type OutcomeMutationLock = {
  id: string;
  ownerId: string;
  sequence: number;
};

type OutcomeCreateDraft = {
  criteria: readonly string[];
  objective: string;
  title: string;
};

function compareOutcomeSummaries(left: OutcomeSummary, right: OutcomeSummary): number {
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function mergeOutcomeSummaries(
  existing: readonly OutcomeSummary[],
  incoming: readonly OutcomeSummary[],
): OutcomeSummary[] {
  const byId = new Map(existing.map((outcome) => [outcome.id, outcome]));
  for (const outcome of incoming) {
    byId.set(outcome.id, outcome);
  }
  return [...byId.values()].toSorted(compareOutcomeSummaries);
}

export function replaceOutcomeSummary(
  outcomes: readonly OutcomeSummary[],
  detail: OutcomeDetail,
): OutcomeSummary[] {
  const summary: OutcomeSummary = {
    acceptanceValidity: detail.acceptanceValidity,
    id: detail.id,
    phase: detail.phase,
    readiness: detail.readiness,
    revision: detail.revision,
    title: detail.title,
    updatedAt: detail.updatedAt,
  };
  const hasOutcome = outcomes.some((outcome) => outcome.id === detail.id);
  const updated = hasOutcome
    ? outcomes.map((outcome) => (outcome.id === detail.id ? summary : outcome))
    : [...outcomes, summary];
  return [...updated].toSorted(compareOutcomeSummaries);
}

export function updateCreateDraftField(
  draft: OutcomeCreateDraft,
  field: "title" | "objective",
  value: string,
): OutcomeCreateDraft {
  return { ...draft, [field]: value };
}

export function updateCreateDraftCriterion(
  draft: OutcomeCreateDraft,
  index: number,
  value: string,
): OutcomeCreateDraft {
  return {
    ...draft,
    criteria: draft.criteria.map((criterion, criterionIndex) =>
      criterionIndex === index ? value : criterion,
    ),
  };
}

export function addCreateDraftCriterion(draft: OutcomeCreateDraft): OutcomeCreateDraft {
  return { ...draft, criteria: [...draft.criteria, ""] };
}

export function removeCreateDraftCriterion(
  draft: OutcomeCreateDraft,
  index: number,
): OutcomeCreateDraft {
  return {
    ...draft,
    criteria: draft.criteria.filter((_, criterionIndex) => criterionIndex !== index),
  };
}
