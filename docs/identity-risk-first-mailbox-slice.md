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
one repeatable-read transaction with SQL-side JSON row/byte checks **before**
driver deserialization: at most 2,000 rules, 1,000 domains, 2 MiB per snapshot;
5-second statement limits and a 12-second transaction limit. Larger existing
snapshots remain usable by their existing consumers, but this slice abstains.
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
For database tests use only a disposable loopback PostgreSQL database, apply all
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
