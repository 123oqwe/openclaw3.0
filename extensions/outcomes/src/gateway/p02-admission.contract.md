# P-02 admission and DTO contract test map

This is a test-only implementation map. It deliberately adds no runtime entrypoint,
Gateway registration, or placeholder import. The executable tests are added with the
first real P-02 handler and must use the host registrar/authentication fixtures.

## Shared admission fixture

- Obtain the request-scoped authenticated profile from the existing Gateway test
  context; never accept a profile id from request params or ambient process state.
- Exercise `operator.read` and `operator.write` with the host
  `authorizeOperatorScopesForRequiredScope` semantics. `operator.write` must inherit
  read; admin inheritance is covered by the host contract rather than reimplemented.
- Assert unauthenticated, expired, revoked, and missing-scope requests fail closed
  using the existing typed Gateway error contract.

## Frozen Workboard owner-response fixture

The P-02 adapter test uses
`adapters/fixtures/workboard-list.v1.json`, a public `workboard.cards.list`
response shape as it exists today: `{ cards, boards, statuses }`. The compatibility fixture must retain
the top-level `boards` and `statuses` fields even though the adapter consumes only
`cards`; this proves it accepts permitted owner-response additions rather than
silently assuming a private store shape.

- Include a visible card with `id`, `status`, `createdAt`, `updatedAt`, and
  `metadata.automation.boardId`, plus at least one proof and one artifact. The
  fixture must exercise the canonical proof fields
  (`id/status/createdAt/label/command/url/note`) and artifact fields
  (`id/createdAt/label/url/path/mimeType`).
- Include a card without `metadata.automation.boardId` to prove the adapter uses
  the specified `"default"` fallback, not a Workboard store helper or a client
  supplied board id.
- Include harmless extra card/metadata fields. The Zod owner-response boundary
  permits those fields, but malformed required identity fields, malformed proof or
  artifact IDs, and an unknown card status must fail closed.
- Keep card identity assertions on `(id, createdAt)`, not position or display
  order. A reordered response must produce the same source digest/fingerprint;
  a changed proof/artifact field or a changed current board must produce a new
  digest.

## First handler package

The first executable package is the complete P-02 method set:
`outcomes.create`, `outcomes.get`, `outcomes.list`, `outcomes.update`,
`outcomes.linkWorkboard`, `outcomes.unlinkWorkboard`, `outcomes.activate`,
`outcomes.refresh`, and `outcomes.cancel`. It must cover:

1. Strict TypeBox request DTOs reject unknown fields, invalid UUIDs, invalid limits,
   oversized UTF-8 payloads, duplicate criteria, and missing required criteria.
   In particular, client-supplied timestamp/server-time fields are invalid input:
   handlers obtain timestamps from the trusted Gateway clock, and a spoofed time
   cannot affect persisted timestamps. Replay and no-op paths remain zero-write.
2. Response DTOs are explicit allowlists: no manager profile, request hash, raw
   refs/evidence, database paths, or internal operation fields are exposed.
3. `get` and `list` filter by the authenticated manager. A record owned by another
   profile is indistinguishable from missing to the caller (same typed not-found).
4. `get` and `list` perform zero state writes; list uses stable `updatedAt desc, id asc`
   ordering and validates limit/cursor without owner RPCs.
5. `create` uses client-supplied id and canonical request hash. Same owner/id/hash
   replays the original receipt before any revision/CAS path; same id with a different
   hash is conflict; a foreign owner never receives the existing record.
6. `update` requires expectedRevision, rejects an old revision atomically, preserves
   existing links when patching definitions, and treats an empty patch/duplicate ids
   as typed invalid input with zero writes.
7. `linkWorkboard` and `unlinkWorkboard` require expectedRevision and obtain card identity
   only through the authenticated Workboard adapter. They retain historical evidence while
   changing active/accepted contracts into the next active generation, and reject missing,
   inaccessible, colliding, or stale card identity without a write.
8. `activate` requires expectedRevision and only accepts a draft whose required criteria
   have at least one link. It freezes generation one and the canonical plan hash; it never
   accepts a caller-supplied phase, generation, hash, or timestamp.
9. `refresh` requires expectedRevision and performs at most one authenticated
   `workboard.cards.list` request per Outcome. It maps disabled, timeout, not-found, and
   identity-conflict distinctly; a failed refresh preserves displayable cached projection
   fields but cannot make prior evidence current.
10. `cancel` requires expectedRevision, permits only draft/active records, preserves
    history and plan identity, rejects accepted/cancelled or in-flight operations,
    and performs no write on every rejection.
11. Typed mappings distinguish unauthenticated/forbidden/not-found/revision-conflict/
    invalid-input/capacity/internal without leaking underlying exceptions.

## Evidence requirements

Each executable test must record source SHA, actual checkout SHA, job URL, test file
and case names, and whether the corresponding production file changed since the
last evidence. RED tests must fail on a real missing behavior, never on a missing
import or schema-invalid fixture. This map does not authorize Workboard calls or
`verifyCriterion`, `accept`, `startWorkboardCard`, `export`, or `delete`.
