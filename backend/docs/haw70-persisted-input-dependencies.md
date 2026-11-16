# HAW-70: distinguish saved health inputs from neighboring response fields

## Decision and scope

Source audit is against `f25334fe5b19cee82519b030565aa62f21aca714`. Its registered
CI passed the lifecycle/audit/sync-state slice; the complete health protocol is
still inactive. This checkpoint adds synthetic dependency witnesses and corrects
the proposed next source slice. It changes no runtime, schema, health policy,
cadence, permissions or reconciliation generation.

Do not add a `tenant_collection_field_states` invalidator merely because the
tenant mapper selects that relation. The existing history writer persists
`{ ...health, syncFreshness }`, not the whole tenant response or
`collectionReadiness`. At this head the two selected usage projection fields
change readiness without changing that saved projection. This distinction does
not assert that partial usage coverage ought to leave health unchanged; changing
that product policy would require its own reviewed behavior and dependency update.

## Traced input boundary

The relevant chain is `tenantSelect` -> `mapTenant` ->
`deriveCollectionReadiness` / `deriveTenantSyncFreshness` / `deriveTenantHealth`
-> `persistTenantHealthSnapshot` in
[`tenants.service.ts`](../src/tenants/tenants.service.ts). Trace the entire saved
payload, not only `overallStatus`: MFA coverage, risk details and timestamps can
change while an overall label stays the same.

| Selected source | Current consumer and saved-health dependency |
| --- | --- |
| `tenant_collection_field_states`: `sharepoint.usage-projection`, `onedrive.usage-projection` | Maps state/reason to usage evidence. [`collection-readiness.ts`](../src/tenants/collection-readiness.ts) changes READY usage datasets to UNVERIFIED or PARTIAL. The mapper forwards only NOT_LICENSED/UNSUPPORTED applicability lists to health; these usage changes do not change those lists, sign-in evidence or risky-identity evidence. Readiness changes, saved health/freshness does not. |
| `tenant_entra_snapshots`: `AUTH_REGISTRATIONS` | Payload drives MFA coverage and security attention; observation time participates in security evaluation metadata. Both mutation and removal are health inputs. |
| `tenant_entra_snapshots`: `RISKY_USERS` | Payload/observation time join the connection, license and sync-state eligibility inputs to produce the Microsoft risk summary and attention. Both mutation and removal are health inputs. |
| `tenant_entra_snapshots`: `SECURE_SCORES` | Produces neighboring score fields. The snapshot payload is not an input to current saved health. Its separate sync-state status/freshness still is. |
| `tenant_entra_snapshots`: `CONDITIONAL_ACCESS`, `SECURITY_DEFAULTS` | Produces neighboring readiness evidence counts/values. Their snapshot payloads are not current saved-health inputs; their separate sync-state/applicability inputs must not be excluded. |

This is a focused dependency audit, not an exhaustive inventory. Connection,
tenant lifecycle/status/scope, license service plans, audit evidence, sync states,
evaluation time and reducer/model changes still need the complete protocol.
Other selected relations, including activity subscriptions, need their own exact
transitive trace before adding or excluding a writer. A source selected by another
endpoint or a later model cannot inherit this audit's exclusions.

## Writer boundaries and next source slice

Follow-up: the [inactive snapshot writer candidate](haw70-snapshot-source-participation.md)
implements the two-resource boundary below with registered but unexecuted physical
witnesses. The dependency evidence here remains synthetic; it does not acquire the
follow-up's missing physical or complete-protocol proof.

`refreshCollectionFieldStates` in
[`tenant-sync.service.ts`](../src/tenants/tenant-sync.service.ts) performs separate
upserts for its field definitions after reading sync states and selected payloads.
A whole-table field invalidator would acquire health authority for those writes,
including fields outside the persisted projection. The mailbox-source attestation
upsert inside `saveSnapshot` uses different keys (`identity-risk/v1/...`), after
the mailbox snapshot write in the same transaction. No field trigger is added here.

The next justified snapshot slice is the two demonstrated saved-health inputs:
AUTH_REGISTRATIONS and RISKY_USERS. Their normal `saveSnapshot` writer takes the
resource advisory lock, reads the old baseline, writes change evidence and any
inventory callback, then upserts the snapshot. `runSnapshotSync` starts and
finishes the resource in separate transactions. Merely covering sync-state writes
does not cover the intervening snapshot commit, rollback or later deletion.

The same table also contains SIGN_INS metadata written by
[`authentication-window-collector.ts`](../src/identity-risk/authentication-window-collector.ts)
and DIRECTORY_ROLES publications written by
[`directory-role-receipt-store.ts`](../src/tenants/directory-role-receipt-store.ts).
The latter locks its parent scope and sync-state row before the snapshot boundary.
A whole-table invalidator would include those unrelated paths. A resource-filtered
design must instead include both OLD and NEW membership and scope when a resource
or tenant changes, and bind its dependency set to the reviewed reader/model and
complete reconciliation generation. Neither design is proved safe by this audit.

Before implementing that slice, specify insert/update/delete, zero-row/upsert,
both directions of included/excluded resource moves, old/new tenant scope,
overflow rollback, missing/dead authority, permissions/RLS and cascade behavior.
The existing truncation guards cover neither `tenant_entra_snapshots` nor
`tenant_collection_field_states`; any newly participating source needs explicit
truncation refusal or invalidation and registered proof. Force real competing
writers/parent deletion and observable lock edges in hosted disposable PostgreSQL.
No concrete new deadlock was established by this source-only inspection.

Retain the HAW-21 ownership boundary; this step introduces no alternate visit
lease and does not integrate or review unpublished HAW-21 source. The separately
documented customer-managed connection lock-order dependency remains open.

## Evidence, limits and fallback

[`tenant-health-input-dependency.test.ts`](../src/tenants/tenant-health-input-dependency.test.ts)
freezes the clock and calls the real mapper and history writer with a synthetic
storage sink. It checks both usage keys across missing, legacy, partial and
rejected evidence, demonstrates real readiness changes, and compares the actual
saved payload. Positive controls change/remove MFA and risk snapshots and
separately vary only their observation times, requiring saved health to change.
Score/policy controls require their
neighboring response values to change while saved health stays equal.

These examples complement the source trace; they do not exhaust every input or
future model. The synthetic sink returns no previous history, deliberately
avoiding the existing deduplication path. Thus they do not prove query selection,
history deduplication, current-pointer admission, coherent database reads, source
ordering, takeover, crash recovery, fleet cost or any physical lock behavior.
No physical PostgreSQL or new hosted CI is run for this local checkpoint.

Keep the public draft frozen at its approved head. This unpublished test/design
child needs new exact-source authorization before external publication. Protected
main remains the operational fallback. Keep all local checkpoints; discard or
revert only this isolated test/design child if its contract is superseded. HAW-70,
Baseline and full SYNC remain incomplete, and no release gate is waived.
