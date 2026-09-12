# P-02 admission and DTO contract test map

This map records the actual P-02 registration and test boundary. Runtime registration
lives in `registrar.ts` and is exposed only through `runtime-api.ts`; the executable
admission tests use the host registrar/authentication fixtures rather than a parallel
authorization abstraction.

## Shared admission fixture

- Capture plugin registration with the SDK's `createTestPluginApi` from
  `src/plugin-sdk/plugin-test-api.ts`; use its captured `registerGatewayMethod`
  callback only to assert plugin descriptors. It is not the admission harness.
- Exercise the actual in-process admission path used by
  `src/gateway/server-plugin-in-process-dispatch.authorization.dispatch.test.ts`:
  `createGatewayMethodRegistry`, `withPluginRuntimeGatewayRequestScope`,
  `withOperatorToolGatewayAuthority`, and `dispatchGatewayMethodInProcess`.
  The test's local `createOperatorClient` and `createContext` show the required
  authenticated profile and request-context shape; P-02 must build that host shape
  rather than invent a parallel auth abstraction.
- Obtain the request-scoped authenticated profile from that Gateway context; never
  accept a profile id from request params or ambient process state.
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

The owner seam is `registerWorkboardGatewayMethods` in
`extensions/workboard/src/gateway.ts`, whose `workboard.cards.list` handler calls
`listWorkboardCards` from `extensions/workboard/src/gateway-helpers.ts`. P-02 calls
the public Gateway method through `api.runtime.gateway.request`; it does not import
either owner store helper.

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

## Implemented handler and test map

The current P-02 registrar registers `outcomes.create`, `outcomes.get`,
`outcomes.list`, `outcomes.update`, `outcomes.linkWorkboard`,
`outcomes.unlinkWorkboard`, `outcomes.activate`, `outcomes.refresh`, and
`outcomes.cancel`. It uses the strict P-01 repository and redacted read model; only
the Workboard link/unlink/get/refresh paths call the authenticated public owner
method. P-04/P-05/P-06 methods remain unregistered.

The Hosted test suite covers:

1. Registration/admission: capture every registered P-02 descriptor with `createTestPluginApi`, then
   dispatch each through the host registry/scope helpers above. Assert unauthenticated,
   expired, revoked, and insufficient-scope requests fail with the host typed error;
   `operator.write` also reaches read methods through normal scope implication.
2. DTO/clock boundary: strict TypeBox request DTOs reject unknown fields, invalid UUIDs,
   invalid limits, oversized UTF-8 payloads, duplicate criteria, and missing required
   criteria. Client-supplied timestamp/server-time fields are invalid input: handlers obtain
   timestamps from the trusted Gateway clock, and spoofed time cannot affect persisted
   timestamps. Replay and no-op paths remain zero-write.
3. `create`: client-supplied id, title, objective, and criteria form the canonical request;
   the authenticated handler constructs its hash and initial draft record. Same owner/id/hash
   replays its original receipt before any revision/CAS path; same id with a different hash is
   conflict; a foreign owner never receives the existing record.
4. `get`/`list`: filter by authenticated manager, make a foreign record indistinguishable
   from missing, perform zero state writes, and keep `updatedAt desc, id asc` ordering while
   validating limit/cursor without owner RPCs.
5. `update`: require expectedRevision, reject an old revision atomically, preserve existing
   links when patching definitions, and treat an empty patch/duplicate ids as typed invalid
   input with zero writes.
6. `cancel`: require expectedRevision; permit only draft/active; preserve history and plan
   identity; reject accepted/cancelled or in-flight operations; and perform no write on every
   rejection.
7. Response DTOs are explicit allowlists: no manager profile, request hash, raw refs/evidence,
   database paths, or internal operation fields are exposed.

Link/unlink require expectedRevision and obtain card identity only through the
authenticated Workboard adapter. They retain historical evidence while changing
active/accepted contracts into the next active generation, and reject missing,
inaccessible, colliding, or stale identity without a write. Activate requires
expectedRevision and only accepts a draft whose required criteria have at least one
link; it freezes generation one and the canonical plan hash without accepting a
caller-supplied phase, generation, hash, or timestamp.

Refresh requires expectedRevision and performs at most one authenticated
`workboard.cards.list` request per Outcome. It maps disabled, timeout, not-found,
and identity-conflict distinctly; a failed refresh preserves displayable cached
projection fields, clears `sourceFingerprint`, and cannot make prior evidence current.

All packages keep typed mappings distinct for unauthenticated, forbidden, not-found,
revision-conflict, invalid-input, capacity, and internal failures without leaking exceptions.

## Executable test locations

`extensions/outcomes/src/gateway/methods.test.ts` covers handler DTO, owner-scoped
repository, zero-write, clock, pagination, mutation and Workboard behavior.
`extensions/outcomes/src/gateway/workboard.integration.test.ts` covers registered
runtime access to the frozen public Workboard response. The real host dispatcher,
scope implication and effective authority-revocation cases live in
`src/gateway/outcomes-methods.dispatch.test.ts`; it loads the bundled public runtime
surface through the existing facade loader and does not statically import extension
source into the core type graph.

## Evidence requirements

Each executable test must record source SHA, actual checkout SHA, job URL, test file
and case names, and whether the corresponding production file changed since the
last evidence. RED tests must fail on a real missing behavior, never on a missing
import or schema-invalid fixture. This map does not authorize Workboard calls or
`verifyCriterion`, `accept`, `startWorkboardCard`, `export`, or `delete`.
