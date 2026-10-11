# Database backup and restore evidence procedure

Owner role: platform/database operator. Reviewed: 2026-10-11.

This internal procedure and blank receipt template **authorize no operation and
attest no usable backup or successful restore**. Operational status remains
unconfirmed in the reviewed repository evidence. Missing attestation does not
mean that backups are absent.

Review this document after a backup provider or plan change, a schema/migration
change affecting restore compatibility, a change to the linked key-recovery
procedure, or any completed restore attempt, successful or not. Update the
restricted operational record when facts change; keep completed receipts out of
the repository.

## What existing evidence establishes

| Evidence | Supported conclusion | Limit |
| --- | --- | --- |
| Committed migrations and accepted disposable-database CI | The tested schema can be reconstructed in an empty isolated database | No production data was restored; this is not a backup receipt |
| Accepted synthetic recovery drill | The model enforces recovery ordering and rejects stale or missing protected prerequisites | It does not verify a real backup, key copy, or restore |
| [Wrapping-key recovery procedure](identity-risk-recovery.md) | Describes prerequisites for affected encrypted/history data | It explicitly leaves actual database recovery status unconfirmed |
| Actual backup, restore, and integrity receipts | No such operational attestation is supplied by this document | Provider, successful backup, recovery availability, and restore outcome remain unconfirmed here |

Reuse accepted evidence without rerunning tests to manufacture operational
proof. A configured backup policy or a healthy API is not evidence of a
successful usable backup. Record existing schedule and retention facts without
changing them. Point-in-time recovery is a fact to record if applicable, not a
new requirement. This procedure introduces no RPO/RTO target or broader
disaster-recovery programme.

## Review existing receipts first

The authorized operator first reconciles any existing non-secret receipts in
the established restricted operational record. Reuse adequate evidence before
proposing a new restore. Do not discover credentials, inspect providers, access
databases, or download backup material on the authority of this document.

| Acceptance item | Required evidence and boundary |
| --- | --- |
| Intended database scope | A private reference identifies what the backup and recovery assessment are intended to cover; this is distinct from the subset actually verified |
| Successful backup | Receipt binds that scope to backup identity, creation time, mechanism, successful result, and operator-confirmed recovery availability |
| Completed isolated restore | Receipt binds that backup to an isolated recovery target, completion time, result, and compatible schema; empty-schema reconstruction alone is insufficient |
| Original key version | Mandatory for affected encrypted data: the authorized operator attests availability of the matching original key version through the restricted custody process; a replacement or regenerated key does not satisfy this requirement |
| Current independent revocation/deletion state | Mandatory when the restored scope includes wrapped or encrypted history: attest reconciliation through the authoritative current independent checkpoint, preserving revoked/destroyed state and tombstones; an older backup must not resurrect that history |
| Actually verified subset and integrity | Record the checked dataset subset, expected baseline/reference, schema/data reconciliation result, and representative tenant-scoped read with its expected access boundary; one read is not full integrity or completeness |
| Operator sign-off | Record the accountable operator role, time, verdict, and limitations tied to those receipts; qualify acceptance to the actually verified scope |

For wrapped or encrypted history, **both** the original-key and independent
revocation/deletion rows are required. Applicability is a condition to establish,
not discretion to omit a required check. Unknown applicability or missing,
stale, ambiguous, or wrong-scope prerequisites prevent acceptance of that
affected stage. See the [key-recovery procedure](identity-risk-recovery.md) for
the protected ordering; its incident-wide mode/UI instructions do not authorize
changes during this bounded verification. Restoring a database does not renew
data expiry or reverse current deletion and revocation decisions.

## If existing proof is insufficient

Prepare a concrete private proposal before seeking separate authorization for
any real restore. It must name the operator role, exact backup reference and
isolated target, permitted restore/read actions, access and network isolation,
data handling and cleanup responsibility, cost and approved limit, reconciliation
baseline, protected prerequisites, observation time bound, stop conditions, and
handling of an unsuccessful target.

The target must not overwrite production or place production data/keys in
ordinary development or test fixtures. Commands depend on the actual operator,
provider, backup, and target; no executable restore commands or new operational
tools are supplied here. The proposal must not infer authority for provider
discovery, backup export, paid infrastructure, policy changes, or production
resume from existing source/release approval.

Only a separately authorized operation can produce a new operational receipt.
Do not replace missing facts with guessed values or turn a procedure, synthetic
test, or proposed operation into an attestation.

## Failure and incomplete evidence

Missing evidence remains **UNCONFIRMED**; an evidenced failed operation is
recorded as **FAILED**, with its actual scope and limitations. Stop the affected
stage and preserve non-secret evidence privately. Do not blindly retry, destroy
restore material, rotate the shared root, repair a database, or automatically
resume production. Any follow-up action needs its own concrete disposition
within the authorized scope. A code revert does not undo restored data or prove
recoverability.

## Blank non-secret receipt

Copy this template into the established restricted operational record. Do not
fill the repository copy. **Completed copies must never be committed or placed
in CI output, Linear, or chat.** Keep real target/provider/operator identities,
tenant identifiers, customer rows, credentials, connection strings, secret
references, and custody locations out of this document. Private references in
the completed record point to evidence under the existing authorized access
boundary; they are not permission to retrieve it.

Keep intended scope and verified subset separate. Preserve an unknown result as
unknown; record a limited successful check with its limitations. A completed
form alone is insufficient without the underlying receipts and sign-off.

```json
{
  "templateOnly": true,
  "handling": "Template only. A completed copy must never be committed or placed in CI, Linear, or chat; use the existing restricted operational record.",
  "status": "UNCONFIRMED",
  "operatorRole": null,
  "intendedDatabaseScopePrivateReference": null,
  "backup": {
    "receiptReference": null,
    "createdAtUtc": null,
    "mechanism": null,
    "result": null,
    "recoveryAvailabilityAttestedAtUtc": null
  },
  "existingPolicyFacts": {
    "schedule": null,
    "retention": null,
    "pitrIfApplicable": null
  },
  "isolatedRestore": {
    "receiptReference": null,
    "completedAtUtc": null,
    "isolatedTargetPrivateReference": null,
    "result": null,
    "schemaCompatibility": null
  },
  "protectedRecoveryPrerequisites": {
    "includesEncryptedData": null,
    "includesWrappedOrEncryptedHistory": null,
    "matchingOriginalKeyVersionAttested": null,
    "currentDeletionRevocationReconciliationReceipt": null
  },
  "boundedIntegrity": {
    "actuallyVerifiedSubsetPrivateReference": null,
    "expectedBaselinePrivateReference": null,
    "reconciliationResult": null,
    "tenantScopedReadAndAccessBoundaryResult": null,
    "limitations": null
  },
  "signOff": {
    "operatorRole": null,
    "atUtc": null,
    "verdict": null
  }
}
```

Maintaining this procedure closes a documentation gap only. Usable backup,
restore success, and bounded data integrity remain unconfirmed until adequate
operational evidence establishes them.
