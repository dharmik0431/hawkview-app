# Optional wrapped-key mailbox pilot (code candidate, not activated)

This change is separate from PR #222 / reviewed `00912323`. #222 remains open
because its production-triggering merge requires direct owner confirmation.
This document is not authorization to merge, deploy, provision, or enable anything.

## Product scope

Only `HV-ID-MBX-001.v1`: an enabled mailbox rule forwards to an address outside
the verified tenant-domain set. This is an investigation lead, **not proof of
compromise**, broad behavior scoring, or Microsoft Identity Protection parity.
Microsoft risk remains a separate channel; no Microsoft risk value is lowered.
Notifications and automatic remediation are not part of this pilot.

## Runtime boundaries

- Default: unconfigured, no implicit key provisioning or app-secret-derived MAC.
- Nest selects the optional wrapped provider only with `HAWKVIEW_IDENTITY_RISK_MODE=shadow`,
  `HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER=wrapped-pilot-v1`, a valid
  `HAWKVIEW_IDENTITY_RISK_ENVIRONMENT`, an existing valid `SECRET_ENCRYPTION_KEY`,
  and `HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE` containing **exactly**
  `organizationId`, `customerTenantId`, and `expiresAt` (canonical UTC ISO time).
  Only one exact organization/tenant is allowed; expiry must be in the next
  seven days. Missing, malformed, wildcard or expired configuration fails closed.
- The managed-KMS adapter remains available under `managed-kms` through explicit
  `IDENTITY_RISK_MANAGED_MAC_TRANSPORT` dependency injection. It has no implicit
  credential-chain/region client. The default binding is null, not production-ready KMS.
- No HTTP key-management endpoint, startup creation, provisioning script, change
  to generic SecretStore, or new dependency/service/subscription is introduced.
- `WrappedRiskKeyStore.createVersion` is an internal explicit control-plane
  primitive, exercised only with synthetic keys in local/CI tests here. It uses
  independent CSPRNG 32-byte keys and atomically inserts a create-only registry
  association plus AES-256-GCM ciphertext. Concurrent callers reload the existing
  active winner. It never overwrites or silently rotates an active key.
- Wrapping AAD and names are reconstructed from trusted environment/org/tenant/
  version, not ciphertext-row claims. Database constraints enforce length,
  association, immutability, one active key, no reactivation, and deletion tombstones.
  Current finding -> matched result -> run -> immutable key version association is retained.
- A bounded session decrypts once, limits MAC count/time/input, does not cache
  raw identifiers, and clears owned buffers in `finally`/close and on deadline.
  JavaScript strings, VM/crypto implementation copies, dumps and GC prevent a
  guarantee of complete memory zeroization.
- Source reads retain aggregate/row/input bounds and freshness checks. An explicit
  mailbox lookup shares the collector memory lane with **no waiting queue**: busy
  returns unavailable. Queries are bounded and cancel actual connections on timeout.

## Authorized mailbox investigation

Finding lists remain pseudonymous. An explicit owner/admin-only, no-store request
to `/api/tenants/:tenantId/identity-signals/findings/:findingId/mailbox-investigation`
joins only the current organization's current tenant inventory with the finding's
pinned key version. Both authorization and operational controls are rechecked.
There is no HawkView-staff bypass or global reversal API. Role revocation, missing
keys, stale/failed/incomplete inventory, no match, duplicates or unsafe labels
yield unavailable, not a guessed identity.

The UI shows the mailbox address only after the authorized click, in local
component state (not the query cache), with Hide and an existing tenant-scoped
Exchange inventory link. It clears on scope/remount changes. There is currently
no mailbox-specific inventory deep link. Inventory over 1,000 mailboxes or 2 MiB
is unavailable; no truncated lookup pretending to be complete. Labels over the
UI's safe 160-character bound are unavailable. These are honest pilot limits.

## UTC and historical data

The Prisma pg adapter used here assumes UTC timestamp strings. Relevant snapshot,
attestation, SyncState/USERS lease, evaluator claim/persistence and risk API reads
set and verify `SET LOCAL TIME ZONE 'UTC'` **inside scoped transactions**. Native
key/source connections likewise verify transaction-local UTC. No global server,
pool or process timezone is changed and no historical timestamps are rewritten.
Existing historically miswritten snapshots fail attestation and require a fresh
natural collection. Tests vary process and database session timezones; this does
not retrospectively repair old evidence.

## Security decision and activation prerequisites

The existing SecretStore is PostgreSQL AES-GCM ciphertext wrapped by an API
environment root, **not Google Secret Manager**. The optional pilot shares this
root custody, not generic mutable SecretStore records.

Compared with managed KMS/HSM, this option has **exportable plaintext tenant keys
in API memory**. Database plus API/root compromise can recover wrapped keys,
including backups. It lacks KMS non-exportability and independent trustworthy
key-use auditing. Live ciphertext deletion does not erase backups, WAL, snapshots
or extracted keys. The existing root also protects Microsoft credentials: never
destroy or rotate it as a tenant-selective risk-key deletion shortcut.

No live acceptance of these tradeoffs has been established. Before any activation:

1. Obtain explicit approval of infrastructure/custody choice and exact pilot scope.
2. Verify actual root custody and separation across environments; prevent secret
   and response-body logging, crash/core dumps, and staff access outside policy.
3. Define backup expiry and restoration/deletion replay. A **whole-database restore**
   can restore tombstones and deleted ciphertext together to an older state; SQL
   constraints alone cannot detect that. Disable risk before restoration, reconcile
   an independently retained deletion ledger, then review before renewing opt-in.
4. Apply the additive migration through the approved release path; explicitly
   create/register a synthetic-validated pilot key through a reviewed controlled
   operation. No production invocation is supplied or performed in this task.
5. Verify UTC-compatible fresh natural collection and exact deployed source; check
   current flags remain off until explicitly authorized to activate.
6. Exercise the actual opt-in UI with owner-controlled evidence and two-MSP
   isolation. Confirm a real finding or honest no-findings/insufficient state,
   identity, reason, timestamps, freshness and limitations separately from Microsoft.

Lifecycle/session/failure evidence stores only key-version references, closed kind,
minute bucket, random correlation ID and 90-day expiry. It is deduplicated per
kind/version/minute. No raw identity, MAC, plaintext/ciphertext, root or exception
payload is recorded. It is **application evidence, not tamper-resistant auditing**.
Existing authenticated maintenance prunes up to 500 expired events for the exact
configured pilot scope, including retired versions; key access also prunes expired
events for that version. If pilot configuration expires/is removed or maintenance
is disabled, physical pruning pauses. A reviewed offboarding/retention operation
must finish deletion; `expires_at` alone is not proof of physical erasure.

## Verification evidence

Local/CI regressions exercise exact scoped config, missing root/key, hostile
references/prototypes, AAD/tag/ciphertext substitution, size bounds, session closure,
creation races, replay/rotation/revocation/deletion and tombstone reinsertion,
real database constraints, source-to-finding-to-mailbox resolution, authorization
and stale/unavailable behavior. Nine process/session UTC/New York/Kolkata combinations
exercise real Prisma writes/reads and timezone reset. Passing synthetic tests is
not evidence of live activation, tenant source quality, root custody or backup erasure.

Local candidate validation (Node 24.18.0, disposable PostgreSQL 15): frontend
289/289; mocked authenticated-canary contracts 4/4; backend 644 passed, zero
failed, two pre-existing skips (646 total), including real database integrations.
Both production builds, frontend full lint/typecheck, backend typecheck, Prisma
generate/validate and diff checks passed. Standalone scripts: 10 passed, with
the Docker-image case explicitly pending locally. Node 22/PostgreSQL 16 and the
enabled actual final-container smoke remain required future protected CI gates;
the parent PR's green checks are not this candidate's checks. esbuild needed a
narrow local sandbox read permission; no source workaround was used. Frontend
build emitted non-fatal old Browserslist and dependency-junction cache warnings.
Explicit new-provider lint passed. A broader explicit backend lint invocation
also reports three pre-existing `no-assign-module-variable` errors in the tenant
sync module and change-evidence test; they are not new findings or a claimed clean
full-backend lint gate.

Independent source review of the initial local candidate found no P0/P1 and one
P2 test-fixture issue: the UTC matrix combined normally separate evaluator claim
and persist transactions, retaining locks unrealistically during concurrent tests.
The test-only repair uses actual per-operation transactions and narrowly scoped
synthetic cleanup. All nine timezone combinations and commit/rollback restoration
checks remain. The previously failing concurrent pair passed three consecutive
runs after repair. No production locks/timeouts were weakened; a PostgreSQL
deadlock SQLSTATE was not captured and is not claimed as observed evidence.
