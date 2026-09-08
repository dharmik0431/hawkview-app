# Wrapping-key recovery inventory and synthetic drill

## Status and boundary

This is a **procedure/template and local synthetic drill**, not a production
backup, custody attestation, restore command, restore test, or activation
approval. No real
root, tenant identifier, customer data, or backup location belongs in this file.
An environment label in source or an example file is not proof of the live
namespace. Confirm the exact approved label through the restricted operator
process without exposing key material.

The existing API uses a protected Render `SECRET_ENCRYPTION_KEY` variable and
PostgreSQL wrapped ciphertext. A runtime variable is not an independent recovery
copy. The same root also protects Microsoft credentials: replacing it to repair
risk keys can break unrelated credentials. Preserve the current root.

Backup, custody, point-in-time recovery, and restore-test status are restricted
operational facts and are not attested in this repository.
Database recovery plus the correct root and current revocation/deletion state
are all required; none alone proves recoverability.

## Non-secret inventory (owner/platform completes)

| Field | Required record; current status |
| --- | --- |
| Accountable owner / recovery operator | Record the permitted operator at execution; do not publish identity here |
| Production risk namespace | Confirm the exact approved label privately at execution |
| Development namespace and custody | Separate root, database and destination/access boundary; unconfirmed |
| Protected key-backup destination | Confirm an approved private destination through the custody process |
| Access and audit | Who can recover, least-privilege roles, access-log location; unconfirmed |
| Version protection | Version/immutability/deletion protection and retention facts; unconfirmed |
| Backup verification | Record creation and verification evidence privately; repository status unconfirmed |
| Database recovery dependency | Confirm backup/PITR and restore-test evidence privately; repository status unconfirmed |
| Independent revocation inventory | Location/checkpoint of revoke/destroy/deletion records that survives database rollback; unconfirmed |
| Restore reconciliation | Operator sign-off and verification evidence before resume; unconfirmed |

Never put root values, recovery codes, ciphertext exports, database credentials,
raw provider responses, or customer records in the inventory, tickets, CI output,
Git, chat, command arguments or shell history. A synthetic digest is used only
inside the drill; this procedure does not publish a real-root fingerprint.

The repository does not identify the live secret host, database provider,
recovery-copy location, or their current operational status. A duplicate runtime
variable or database backup alone is not independent key recovery. Authorize
destination access through the private custody process before a real-key
operation. Do not search password managers or secret files from this runbook,
and do not provision a new paid service as a workaround.

## Fail-closed recovery order (future controlled operation)

1. Record the incident, accountable operator, exact environment and target
   database. Stop risk evaluation (`MODE=off`) and hide the risk UI if needed;
   verify those effective states before restoring. Do not run a production drill.
2. Identify the approved database restore point, matching existing wrapping-key
   version and independent latest revocation/deletion checkpoint. Database and
   root are both required; either alone is insufficient. Namespace must be
   explicitly chosen from the inventory, never inferred from a service name.
3. In isolated recovery infrastructure, restore only the selected environment.
   Never copy production keys/data into ordinary development or test fixtures.
   Retrieve recovery material only through the approved protected process, not
   a chat/terminal export. Verify the selected root is the original required
   version: no replacement, regeneration, fallback root or trial rotation.
4. Before enabling evaluation or serving recovered evidence, replay/reconcile
   revoke/destroy/deletion state from the independent inventory through its
   authoritative latest checkpoint. An older database can restore an ACTIVE
   key and ciphertext that were subsequently revoked/destroyed. Preserve all
   tombstones and history; do not revive/recreate those keys. Missing, stale,
   ambiguous or wrong-environment inventory blocks recovery. Database constraints
   alone cannot prove the independent inventory is complete.
5. Verify scope/namespace, authenticated ciphertext integrity, root availability,
   and key status. Missing/corrupt ciphertext, wrong root, inconsistent namespace,
   or revoked/destroyed keys fail closed; they do not trigger key creation.
   Reconcile expired/deleted derived history under the separately approved
   retention procedure; a database restore does not renew evidence timestamps.
6. Validate isolation, freshness and current source/attempt provenance before
   any verdict. A decryptable key is not source readiness. Obtain recorded
   operator review, then resume only the explicitly approved evaluation/UI
   configuration. Wrong/unknown evidence remains unavailable, never clean.
7. On failure, keep evaluation/UI off and preserve evidence for diagnosis. Do
   not automatically restore old ciphertext, relax retention, recreate revoked
   keys, rotate the shared root, or claim a failed acknowledgement rolled back.

The drill below models these ordering/checkpoint gates. It does **not** implement
the operational replay tool, prove live backup permissions/immutability, validate
a real backup, or replace the separate runtime database/isolation tests.

## Reproducible local synthetic drill

From the repository's `backend` directory with normal locked dependencies:

```powershell
node --import tsx --test src/identity-risk/risk-recovery.drill.test.ts
```

The fixture is disposable **in memory**, not a live database. Every root/key and
opaque ID is freshly generated. No environment secrets are read, no network or
filesystem data is loaded, and no API/SMTP/Graph/provider call is made. Independent
database snapshots and revocation-ledger copies simulate a rollback and replay.
The actual `wrapRiskKey` / `unwrapRiskKey` implementation is exercised; recovery
ordering is an explicitly test-only model, not a newly shipped recovery service.

Tests cover original-root recovery, missing database/root, wrong root/namespace,
corrupt ciphertext, production-like/development separation, pre-reconciliation
resume denial, stale/missing ledger, revoked/destroyed keys restored ACTIVE in an
old snapshot, duplicate/foreign ledger entries, and absence of resurrection.
Synthetic buffers are cleared on fixture teardown on a best-effort basis;
JavaScript garbage collection is not a secure-erasure guarantee. TAP output has
only static test names and counts, never fixture material.

Record the exact commit and test result in the restricted delivery handoff.
Record backup custody, recoverability, access control, version protection,
revocation inventory, and restore evidence there—not in this repository.
Passing this drill closes only the synthetic procedure gate, not actual key
custody or production restore readiness.
