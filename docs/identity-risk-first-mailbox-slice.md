# First mailbox investigation slice — local implementation, not live activation

This slice connects the existing version-1 identity-risk evaluator, durable platform,
API and UI. Only `HV-ID-MBX-001.v1` is selected. No new Microsoft requests,
permissions, collection schedules, other detectors, probabilities, or automated
customer alerts are introduced. Microsoft Identity Protection remains a separate
channel and is never lowered by this indicator.

## Source contract and compatibility

`TenantSyncService.saveSnapshot` keeps the existing snapshot array unchanged.
For the two already collected resources it atomically writes a companion
`TenantCollectionFieldState` with field key `identity-risk/v1/<resource>`:

- source: `mailbox-investigation-source/v1`;
- state: `COMPLETE` only for a successfully bounded, validated collection;
- correlationId: SHA-256 integrity digest over version, organization, tenant,
  resource, observation timestamp and canonical snapshot content;
- lastSuccessfulAt: exactly the snapshot's observedAt;
- no raw names, identifiers, provider diagnostics, tokens or content in metadata.

This digest checks integrity; it is **not** an identity pseudonym. Identity
references use only the managed-MAC provider. Missing legacy metadata, bad digest,
wrong scope/version/time, failed or newer-in-progress sync, malformed data, limits,
staleness and any mailbox 404 abstain. Existing legacy arrays are never backfilled
with invented authority. New metadata requires a subsequent natural successful
collection. A complete empty rules array is distinct from a filtered/missing one.

The existing Graph organization request additionally selects `id`; exactly one
organization must match the scoped connection's Microsoft tenant ID. Domain rows
are validated before projection, never filtered into success. The old internal
resource name `EXCHANGE_ACCEPTED_DOMAINS` is retained for compatibility, but the
actual source is **Microsoft Graph verified tenant domains**, not the complete
Exchange accepted-domain/transport inventory. The indicator says a rule targets
a domain outside that verified set. It does not prove delivery, exfiltration or
compromise; approved partner forwarding remains a possible benign explanation.

Rules need explicit identity, boolean isEnabled, hasError=false and valid action
recipients. Missing fields are not invented. Only known forwarding/redirect
actions are used. Conditions, execution, transport blocking and legitimacy are
not inferred. MBX002/003 are not enabled.

## Bounded execution

The existing evaluator checks OFF and hard-stop before its lazy loader. The
default provider is unconfigured and throws a closed error before even registry
or tenant-source reads, and before any risk run is written. There is no app-secret,
cursor-secret, random runtime key or SHA subject fallback.

The post-sync bridge holds the existing shared memory lane through source read,
MAC projection and evaluation. It adds no collector concurrency. The reader uses
a read-only repeatable-read transaction with SQL-side JSON row/byte checks **before**
driver deserialization: at most 2,000 rules, 1,000 domains, 2 MiB per snapshot;
5-second statement limits and a 12-second transaction limit. Larger existing
snapshots remain usable by their existing consumers, but this slice abstains.
Registry and snapshot reads each use one short-lived dedicated connection,
sequentially under that lane, with no shared Prisma pool/configuration changes.
Connection-string TLS settings are preserved. Acquisition is bounded to at most
one second; registry execution to six seconds, source execution to twelve, and
both fit the remaining 30-second loader deadline. Server statement timeouts and
an actively destroyed owned socket terminate blocked/stalled work, including
connection establishment and idle cleanup; there is no race-and-abandon request
or unbounded pool queue. Every success/failure releases its connection. Registry
errors remain closed codes and never disclose the connection string or query.
The reader sets TimeZone=UTC only with SET LOCAL inside its own transaction;
shared Prisma, server, database and caller connection settings are not changed.
Native timestamptz parsing preserves the stored instant and source-based expiry.
The installed Prisma adapter assumes UTC when mapping timestamp strings; existing
collector/evaluator connections must therefore be UTC-compatible. Non-UTC legacy
writer drift is not repaired or guessed: mismatched attestation/time fails closed.
Before live activation, verify UTC-compatible collection/persistence sessions and
fresh matching attestation; changing a test fixture alone is not that evidence.
After that source-read bound, a separate evaluator preflight admits at most 1,000
candidates and validates every actual closed candidate against the established
runtime/projection validators (including the 256-domain limit and normalized
recipient length). It uses the adapter's actual approved context and the engine's
bounded input accounting: context once plus every candidate, including repeated
domain lists, within 2,000,000 aggregate bytes and existing per-input node/depth
bounds. A complete but oversized source returns an empty UNAVAILABLE batch, never
a truncated FULL batch or a fabricated SECRET_EXPOSURE incident. No evaluator
limit is increased. Complete empty rules remain distinct from unavailable data.
Preflight runs before MAC generation using fixed-width shape-only measurement
references that are never emitted as identities, then checks the real MAC-bearing
candidates again before evaluator cloning. Oversized input makes zero MAC calls.
Managed calls are sequential, bounded to a 30-second loading/projection deadline,
5 seconds per call, at most 6,002 calls, with run-local deduplication only. The SDK
transport requires maxAttempts=1 and passes AbortSignal; no retry amplification.
Source-derived expiry is the older dependency observation plus 36 hours, never
extended by replay. sourceObservedAt is persisted separately from completion time.

## Key identity and retention

The additive migration creates `IdentityRiskPseudonymKeyVersion` and nullable,
organization/tenant-scoped `IdentityRiskEvaluationRun.pseudonymKeyVersionId`.
Legacy runs remain NULL; there is no false key backfill. Each new projected run
pins one immutable version. Scope, physical ARN, environment, provider and version
cannot be changed in place. One active version per tenant/environment is enforced;
one physical key cannot be shared across registry versions/scopes. Activation and
retirement are operator-controlled, not collector actions. Active status is checked
again under a database lock at claim and immediately before result persistence.
The Prisma schema includes the migration's scoped run-to-key lookup index.
Real two-connection PostgreSQL regressions pause immediately before/after each
production FOR SHARE query. Revocation winning before claim creates no run;
winning before persistence leaves only a failed run and no coverage/matches/
findings. Revocation waits while a claim/persistence lock is held; persistence
winning first may complete with historical provenance before revocation commits.

Recoverable provenance is:
`finding.matchedResult -> matchedResult.evaluationRun -> run.pseudonymKeyVersion`.
All joins/FKs include organization and tenant. The public `hvr1_kind_64hex` shape
and API version remain unchanged. Canonical MAC messages include environment,
organization, tenant, purpose, immutable version and bounded identifier tuple.
No raw reverse lookup table is introduced. Rotation creates a new physical key
and version; historical findings retain their original version. Registry deletion
is blocked while dependent runs exist. Organization deletion cascades scoped
derived records; physical cloud-key disable/deletion is a separate authorized
operator process. Registry retention does not authorize extending source expiry.

## Activation prerequisites — NOT completed by this change

AWS direct GenerateMac is a candidate design, not proof of an existing account,
region, role, key or approved budget. Runtime Nest wiring deliberately retains the
unconfigured provider. A separately reviewed activation must supply an explicitly
configured workload-authenticated KMS client/transport/provider (no default/static
credential shortcut), approved environment and actual per-tenant key-version
records. No KMS request is made by these tests or this rollout preparation.

Owner/security/operator decisions still required: cloud account/region and costs,
Render workload identity eligibility, least-privilege IAM and key ownership,
privacy review of identifier processing, rotation/deletion/outage procedures,
realistic managed-MAC latency/call-budget validation, and authorized deployment of
the migration/client wiring. Direct per-tenant keys have ongoing per-key/request
costs; obtain a current region/tier-specific quote before provisioning. Never reuse
existing encryption/cursor secrets to avoid that decision.

Only after independently reviewed deployment, new natural source attestation,
key configuration and exact-SHA verification may an owner authorize scoped shadow
activation. Synthetic success means local integration readiness, **not live risk
coverage**. No feature flag or production setting is changed here.

## Local validation

Run normal frontend tests, typecheck, lint/build and canary **contract** tests.
Run backend Prisma generate/validate, typecheck/build and all `src/**/*.test.ts`.
For database tests use only a disposable loopback PostgreSQL database using UTC
(matching CI), apply all
committed migrations, and set `HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS=1` for that
test process. New key tests explicitly reject remote database hosts. They verify
legacy NULLs, actual reference-to-key lookup, rotation, immutable keys, foreign FK
rejection, scoped deletion, SQL reader through actual evaluator/storage/API, and
absent attestation/disabled keys. Mock MAC implementations are test-only; SDK tests
stub send and never create a real AWS client or use credentials.

Required GitHub gates and final Docker cron-image tests remain publication gates.
Do not infer deployed behavior from local tests or a merge.

Local candidate validation (2026-09-04): frontend 285/285; backend 615 passed,
two pre-existing superseded legacy tests skipped, no failures; all 39 migrations
applied to a fresh disposable PostgreSQL 15 database, including the new real-DB
reader/evaluator/API and key-lifecycle tests. Frontend/backend production builds,
typecheck, frontend lint, Prisma generate/validate and diff checks passed. Canary
contracts 4/4; backend script contracts 10 passed with the final Docker-image test
pending. Local Node is 24.18.0; protected CI must still validate Node 22/PostgreSQL
16 and the final Docker image before any publication approval. No live API or
Microsoft/AWS calls, browser validation, feature activation or deployment occurred.

Bounds-repair revalidation (2026-09-04): backend 623 passed, two pre-existing
legacy skips, zero failures (625 total); frontend 285 passed; canary contracts 4/4.
Both production builds, TypeScript, frontend lint, Prisma generate/validate and
diff checks passed. Backend script contracts: 10 passed, final Docker test pending.
All four actual database tests cover migration/registry/API plus cancellation and
four coordinated key-revocation races. All 39 migrations applied to a separate
fresh disposable PostgreSQL 15 database. Regressions cover attested 257 domains,
1,001 candidates, normalized address expansion, repeated-domain aggregate input
overrun, exact adjacent fitting/non-fitting batches, and the actual scheduler/API
UNAVAILABLE path without safety activation. A loopback protocol stub verifies
actual socket closure during stalled acquisition/query transport; PostgreSQL
tests verify real held-lock cancellation, enforced READ ONLY, and clean subsequent
reads. The fixture rejects mismatched timestamp eligibility; its local database
was explicitly set to UTC after detecting the host-inherited timezone. No live
database timezone/configuration was changed. The real-reader matrix separately
varies writer session, reader startup and Node process timezones across UTC,
America/New_York and Asia/Kolkata. It checks exact sourceObservedAt/expiry against
the UTC Prisma reader and unchanged 36-hour/+5-minute boundaries and boundary+1;
the new scoped read connection remains UTC and timestamp drift never becomes FULL.
Node 22/PostgreSQL 16 and final
Docker image validation remain protected CI requirements, not local claims.
