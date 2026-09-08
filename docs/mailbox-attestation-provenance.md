# Mailbox attestation refusal provenance

This change explains future normal collections. It does not repair historical
collection failures, backfill provenance, prove usable risk coverage, or trigger
collection. No schema, UI, API, eligibility, permission, flag or retention change.

An ordinary mailbox-rules snapshot can be collected successfully without being
attestable for identity-risk evaluation. The existing all-or-nothing safety gate
is unchanged. An accepted 404 is not proof of a missing license or permission,
nor proof that the affected directory object is safely outside mailbox scope.

## Stored closed reasons, in deterministic priority order

Only the existing `tenant_collection_field_states.reason_code` is enriched for
`identity-risk/v1/EXCHANGE_MAILBOX_RULES`. No raw response, exception, account,
mailbox/rule identifier, address, or diagnostic payload is stored as a reason.

1. `DIRECTORY_SYNC_MISSING`: no scoped USERS sync state.
2. `DIRECTORY_SYNC_NOT_SUCCEEDED`: state is not SUCCEEDED (including unknown).
3. `DIRECTORY_SYNC_UNDATED`: missing successful timestamp.
4. `DIRECTORY_SYNC_STALE`: successful timestamp older than the existing 36h bound.
5. `DIRECTORY_SYNC_NEWER_ATTEMPT`: attempt is later than that successful timestamp.
6. `RULE_ENDPOINT_NOT_FOUND`: at least one rules request returned accepted 404.
7. `RULE_VALIDATION_UNATTESTABLE`: prerequisites passed and no 404 occurred, but
   the unchanged bounded digest/semantic validation refused the collected rows.

The first applicable directory category wins, then any accepted 404 (independent
of mailbox order), then validation refusal. This is a primary reason, not an
exhaustive list of all failures. Existing predicates and bounds are preserved.
Thrown collection errors still follow the existing failed-sync path; they do not
advance the snapshot or fabricate new attestation provenance.

`ATTESTED_COMPLETE` is written only when the existing gated digest succeeds.
Otherwise state remains UNAVAILABLE with null digest/success timestamp and
isStale=true. A complete empty rules collection can still attest. Snapshot and
attestation are persisted in the same existing transaction, and later refusal
clears prior COMPLETE evidence. Accepted-domain provenance is unchanged.

Legacy/untyped callers without a recognized collection reason retain
`SOURCE_NOT_ATTESTED`; arbitrary text is rejected by a runtime allowlist. Existing
generic rows stay unknown; never infer a historical category from current USERS
state or from these new codes. Existing scoped digest storage is unchanged.

## Validation and release boundary

Synthetic collector-to-save tests exercise each category, deterministic priority,
complete-empty success, unknown/404/invalid refusal, prior COMPLETE clearing,
legacy fallback, foreign-baseline refusal, and transaction rollback simulation.
Mocks are not proof of a real PostgreSQL rollback or live customer coverage.
Existing PostgreSQL isolation/transaction tests remain part of protected CI.

After review and normal release, only subsequent normal collections can record
the specific reason. No manual sync or automatic diagnostic retry is prescribed.
Do not mark this observability correction as resolving the pilot's risk-evidence
availability or Microsoft risky-user display configuration.
