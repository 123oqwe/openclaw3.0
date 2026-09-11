import { Type } from "typebox";

const outcomeId = Type.String({ minLength: 1, maxLength: 160 });
const outcomeTitle = Type.String({ minLength: 1, maxLength: 160 });
const outcomeObjective = Type.String({ minLength: 1, maxLength: 4000 });

const criterion = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 160 }),
    text: Type.String({ minLength: 1, maxLength: 1000 }),
    required: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Public P-02 inputs deliberately omit server-owned state, refs, and timestamps. */
export const outcomeCreateParamsSchema = Type.Object(
  {
    id: outcomeId,
    title: outcomeTitle,
    objective: outcomeObjective,
    criteria: Type.Array(criterion, { minItems: 1, maxItems: 5 }),
  },
  { additionalProperties: false },
);

export const outcomeIdParamsSchema = Type.Object({ id: outcomeId }, { additionalProperties: false });

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
    expectedRevision: Type.Integer({ minimum: 1 }),
    title: Type.Optional(outcomeTitle),
    objective: Type.Optional(outcomeObjective),
    criteria: Type.Optional(Type.Array(criterion, { minItems: 1, maxItems: 5 })),
  },
  { additionalProperties: false },
);

export const outcomeCancelParamsSchema = Type.Object(
  {
    id: outcomeId,
    expectedRevision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
