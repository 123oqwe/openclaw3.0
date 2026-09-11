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

## First handler package

The first executable package is `outcomes.create`, `outcomes.get`, `outcomes.list`,
`outcomes.update`, and `outcomes.cancel` only. It must cover:

1. Strict TypeBox request DTOs reject unknown fields, invalid UUIDs, invalid limits,
   oversized UTF-8 payloads, duplicate criteria, and missing required criteria.
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
7. `cancel` requires expectedRevision, permits only draft/active records, preserves
   history and plan identity, rejects accepted/cancelled or in-flight operations,
   and performs no write on every rejection.
8. Typed mappings distinguish unauthenticated/forbidden/not-found/revision-conflict/
   invalid-input/capacity/internal without leaking underlying exceptions.

## Evidence requirements

Each executable test must record source SHA, actual checkout SHA, job URL, test file
and case names, and whether the corresponding production file changed since the
last evidence. RED tests must fail on a real missing behavior, never on a missing
import or schema-invalid fixture. This map does not authorize Workboard calls or
`verifyCriterion`, `accept`, `startWorkboardCard`, `export`, or `delete`.
