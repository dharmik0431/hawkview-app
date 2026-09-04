# Scoped wrapped pilot key operator

This command provisions only a pseudonym key for the existing MBX001 pilot. It
does not activate evaluation, alter frontend flags, collect data, change Microsoft
permissions, rotate/delete keys or the shared wrapping root, or send notifications.
No production use was performed while implementing it.

## Operator procedure

Use the deployed backend image with its normal database/secret access, but run
`node /app/dist/provision-risk-key.js` explicitly instead of the API entrypoint.
Do not invoke the normal image CMD for this operation: CMD applies migrations and
starts the API. Do not copy secrets into arguments, shell history, tickets or logs.
Use the approved host's protected environment injection. Only opaque IDs appear
in the arguments/output; never substitute email addresses or tenant names.

The isolated operator process requires the existing `DATABASE_URL` and
`SECRET_ENCRYPTION_KEY`, plus `HAWKVIEW_IDENTITY_RISK_MODE=shadow`,
`HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER=wrapped-pilot-v1`, the matching
`HAWKVIEW_IDENTITY_RISK_ENVIRONMENT`, and the existing strict
`HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE` (exact organizationId/customerTenantId/expiresAt,
expiry within seven days). These process-local prerequisites do not require turning
on the running API. Never change the shared root to make this command work.

1. Confirm the one approved organization/customer-tenant pair and environment;
   choose a canonical UUID for the requested version. These are internal IDs.
2. Default preflight, **no database writes or audit events**:

   ```text
   node /app/dist/provision-risk-key.js --environment ENV --organization ORG_UUID --tenant TENANT_UUID --version VERSION_UUID
   ```

   `PREFLIGHT_OK` reports `WOULD_CREATE` or `REUSE_ACTIVE_VERSION`. It checks scope
   ownership and registry/ciphertext association, not live collection readiness or
   cryptographic usability of an existing ciphertext. No decryption occurs.
3. Only after checking the output, repeat with the explicit mutation switch and
   the exact four-part confirmation:

   ```text
   node /app/dist/provision-risk-key.js --environment ENV --organization ORG_UUID --tenant TENANT_UUID --version VERSION_UUID --apply --confirm-scope ENV/ORG_UUID/TENANT_UUID/VERSION_UUID
   ```

   `ENSURED` reports the actual active version, which can differ from the requested
   version if another authorized caller already created the active winner. It never
   overwrites an active key. Repeating the same invocation is idempotent. Requested
   IDs already belonging to another scope, or retired/destroyed requested versions,
   fail closed without revealing their details.

Exactly one bounded JSON line is printed. Exit 0 means successful preflight/help or
ensure; exit 1 means failure. `APPLY_UNCONFIRMED` can mean a commit acknowledgement
was lost: do not claim rollback or choose a new ID. Repeat read-only preflight with
the same scope/version, then reconcile. Raw errors and credentials are never echoed.
Connections have bounded acquisition/query lifetimes, transaction-local timeouts,
and cleanup; the total operation uses a ten-second deadline. No permanent pool or
background process is created.

## Packaging and validation

The existing backend build creates `dist/main.js` and the independent
`dist/provision-risk-key.js` bundle. The runtime Docker stage already copies dist;
normal API CMD and cron scripts are unchanged. Existing Node/pg dependencies are
reused. The required final-image cron smoke also executes operator help and a
configuration-missing default dry-run with network disabled and a read-only
filesystem. When image tests are enabled, missing Docker/image/command is a failure,
not a passing skip. Actual image execution must be reported separately from local
bundle tests.

Pilot choice/expiry, existing-root custody, backup retention/deletion replay,
fresh scoped evidence, backend configuration and frontend/GAS publication remain
separate activation work. See [wrapped pilot limits](identity-risk-wrapped-pilot.md).
This does not impose a KMS requirement or add a platform/subscription.

## Local candidate evidence (not deployment evidence)

Node 24/PostgreSQL 15 disposable fixture: backend 646 passed, zero failed, two
existing legacy SharePoint skips; frontend 289 passed; mocked canary contracts
4 passed. Backend production bundles, both typechecks, frontend lint, changed
backend-file lint, Prisma generation/validation, all 40 migrations and diff checks
passed. Built-command process tests and real database command-process success/
connection-failure cleanup passed. Standalone scripts passed 11 tests with the
image case explicitly pending by default.

Enabling the actual final-image test locally produced a hard failure
`spawnSync docker ENOENT`: Docker is absent and WSL is not installed. Therefore
actual final-image execution and Node22/PostgreSQL16 CI are **not yet proven** for
this candidate. No timeout, test, safety lock or default startup was weakened.
The independent reviewer must retain this validation limitation; the earlier
merged image's success is not evidence for this new operator bundle.
