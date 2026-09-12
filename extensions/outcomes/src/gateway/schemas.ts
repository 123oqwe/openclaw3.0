import { Type } from "typebox";
import { OUTCOME_MAX_CRITERIA } from "../domain/constants.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

const outcomeId = Type.String({ pattern: UUID_PATTERN });
// TypeBox string lengths are UTF-16 code units. These bounds admit every valid
// Unicode code-point-length input; normalizeText performs the exact protocol limit.
const outcomeTitle = Type.String({ minLength: 1, maxLength: 160 * 2 });
const outcomeObjective = Type.String({ minLength: 1, maxLength: 4000 * 2 });

const criterion = Type.Object(
  {
    id: Type.String({ pattern: UUID_PATTERN }),
    text: Type.String({ minLength: 1, maxLength: 1000 * 2 }),
    required: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const outcomeHealthParamsSchema = Type.Object({}, { additionalProperties: false });

/** Public P-02 inputs deliberately omit server-owned state, refs, and timestamps. */
export const outcomeCreateParamsSchema = Type.Object(
  {
    id: outcomeId,
    title: outcomeTitle,
    objective: outcomeObjective,
    criteria: Type.Array(criterion, { minItems: 1, maxItems: OUTCOME_MAX_CRITERIA }),
  },
  { additionalProperties: false },
);

export const outcomeIdParamsSchema = Type.Object(
  { id: outcomeId },
  { additionalProperties: false },
);

export const outcomeListParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);

export const outcomeUpdateParamsSchema = Type.Object(
  {
    id: outcomeId,
    expectedRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    patch: Type.Object(
      {
        title: Type.Optional(outcomeTitle),
        objective: Type.Optional(outcomeObjective),
        criteria: Type.Optional(
          Type.Array(criterion, { minItems: 1, maxItems: OUTCOME_MAX_CRITERIA }),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const outcomeCancelParamsSchema = Type.Object(
  {
    id: outcomeId,
    expectedRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

export const outcomeActivateParamsSchema = Type.Object(
  {
    id: outcomeId,
    expectedRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

export const outcomeRefreshParamsSchema = Type.Object(
  {
    id: outcomeId,
    expectedRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

const outcomeWorkboardLinkFields = {
  id: outcomeId,
  expectedRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  criterionId: Type.String({ pattern: UUID_PATTERN }),
  // Workboard IDs are opaque owner values: validate only non-emptiness here.
  cardId: Type.String({ minLength: 1 }),
};

export const outcomeWorkboardLinkParamsSchema = Type.Object(outcomeWorkboardLinkFields, {
  additionalProperties: false,
});

export const outcomeWorkboardUnlinkParamsSchema = Type.Object(outcomeWorkboardLinkFields, {
  additionalProperties: false,
});
