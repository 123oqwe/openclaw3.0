import type {
  OutcomeCreateParams,
  OutcomeCriterionInput,
  OutcomeUpdateParams,
  OutcomeWorkboardLinkParams,
} from "@openclaw/outcomes-contract";
import { stableStringify } from "openclaw/plugin-sdk/normalization-runtime";
import type { Criterion } from "../domain/types.js";

const MAX_REQUEST_BYTES = 64 * 1024;

type PublicCriterion = OutcomeCriterionInput;
type PublicCreate = OutcomeCreateParams;
type PublicPatch = OutcomeUpdateParams["patch"];
type PublicWorkboardLink = OutcomeWorkboardLinkParams;

export function normalizedUuid(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const id = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? id
    : undefined;
}

function normalizedText(value: unknown, min: number, max: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  const length = Array.from(text).length;
  return length >= min && length <= max ? text : undefined;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function normalizeCriteria(value: unknown): PublicCriterion[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    return undefined;
  }
  const criteria: PublicCriterion[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return undefined;
    }
    const input = item as Record<string, unknown>; // SAFETY: item passed the object guard above.
    const id = normalizedUuid(input.id);
    const text = normalizedText(input.text, 1, 1000);
    if (!id || !text || typeof input.required !== "boolean") {
      return undefined;
    }
    criteria.push({ id, text, required: input.required });
  }
  return criteria.some((criterion) => criterion.required) &&
    new Set(criteria.map((criterion) => criterion.id)).size === criteria.length
    ? criteria
    : undefined;
}

function withinBudget(value: unknown): boolean {
  return Buffer.byteLength(stableStringify(value), "utf8") <= MAX_REQUEST_BYTES;
}

export function normalizeCreate(params: unknown): PublicCreate | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const input = params as Record<string, unknown>; // SAFETY: params passed the object guard above.
  const id = normalizedUuid(input.id);
  const title = normalizedText(input.title, 1, 160);
  const objective = normalizedText(input.objective, 1, 4000);
  const criteria = normalizeCriteria(input.criteria);
  const result =
    id && title && objective && criteria ? { id, title, objective, criteria } : undefined;
  return result && withinBudget(result) ? result : undefined;
}

export function normalizePatch(
  params: unknown,
): { id: string; expectedRevision: number; patch: PublicPatch } | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const input = params as Record<string, unknown>; // SAFETY: params passed the object guard above.
  const id = normalizedUuid(input.id);
  const patchInput = input.patch;
  if (
    !id ||
    !positiveSafeInteger(input.expectedRevision) ||
    !patchInput ||
    typeof patchInput !== "object"
  ) {
    return undefined;
  }
  const raw = patchInput as Record<string, unknown>; // SAFETY: patchInput passed the object guard above.
  const patch: PublicPatch = {};
  if (Object.hasOwn(raw, "title")) {
    const title = normalizedText(raw.title, 1, 160);
    if (!title) {
      return undefined;
    }
    patch.title = title;
  }
  if (Object.hasOwn(raw, "objective")) {
    const objective = normalizedText(raw.objective, 1, 4000);
    if (!objective) {
      return undefined;
    }
    patch.objective = objective;
  }
  if (Object.hasOwn(raw, "criteria")) {
    const criteria = normalizeCriteria(raw.criteria);
    if (!criteria) {
      return undefined;
    }
    patch.criteria = criteria;
  }
  const result = { id, expectedRevision: input.expectedRevision, patch };
  return Object.keys(patch).length > 0 && withinBudget(result) ? result : undefined;
}

export function normalizeWorkboardLink(params: unknown): PublicWorkboardLink | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const input = params as Record<string, unknown>; // SAFETY: params passed the object guard above.
  const id = normalizedUuid(input.id);
  const criterionId = normalizedUuid(input.criterionId);
  const cardId = typeof input.cardId === "string" ? input.cardId.trim() : "";
  if (!id || !criterionId || !cardId || !positiveSafeInteger(input.expectedRevision)) {
    return undefined;
  }
  const result = { id, expectedRevision: input.expectedRevision, criterionId, cardId };
  return withinBudget(result) ? result : undefined;
}

export function withRefs(criteria: PublicCriterion[], current: Criterion[]): Criterion[] {
  return criteria.map((criterion) => ({
    ...criterion,
    workRefs: current.find((item) => item.id === criterion.id)?.workRefs ?? [],
  }));
}
