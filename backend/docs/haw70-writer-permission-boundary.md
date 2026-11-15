# HAW-70 writer permission boundary

Design checkpoint, 14 November 2026. Reviewed source parent:
`416c81baaf2e7dbb6d66ff4c4586869b362f29d3`, based on protected main
`a15951997b6734b9fc612717cf965c9f9651176c`.
This document changes no permissions, migrations, reader gate or receipt generation.
The incomplete candidate remains inactive. No physical database was used for this review.

Follow-up local implementation: an unpublished forward migration now adds the
function-local error-on-RLS guard to all four authority-writing trigger functions.
Three additional registered physical cases specify audit/sync source denial,
committed unguarded negative controls, guarded INSERT/UPDATE/DELETE rollback,
missing-ACL rejection, owner invalidation and tenant lifecycle rejection. The
negative controls restore the guard before committing their fixture writes.
These cases have not executed in PostgreSQL. SET LOCAL ROLE probes effective DML
rights only; an administrator session cannot prove production login containment.
At that checkpoint, TRUNCATE guards, actual runtime role attestation, complete activation/preflight
and cross-scope restricted-writer coverage remain open. The earlier design below
states the full acceptance target; this slice does not complete it.

A further unpublished slice adds BEFORE STATEMENT TRUNCATE refusal guards on
audit logs, sync states, tenants, organizations, health snapshots and source
authorities. Only these six guards use ENABLE ALWAYS, so their refusal also
applies in replica mode; other triggers are unchanged. A registered physical
witness specifies a rollback-only unguarded audit truncation, direct and parent
CASCADE refusal, both source-table orders, a preceding temporary-table sentinel,
and effective roles with explicit TRUNCATE grants but no RLS-visible source rows.
Every truncation attempt is rolled back even if its expected refusal fails.
This witness has not executed. Owners can still disable or drop guards, runtime
role attestation is absent, and future health sources need their own coverage.
The partial receipt and inactive reader/preflight remain unchanged.

## Observed source contract

- The [historical RLS migration](../prisma/migrations/20260909120000_lock_down_public_schema_grants_and_rls/migration.sql)
  describes a Prisma backend using the postgres owner/BYPASSRLS identity. It enables
  RLS without FORCE or policies on the source tables, including audit logs, sync
  states, tenants and organizations. This comment is historical intent, not an
  attestation of today's API, cron or maintenance identities.
- The [authority table](../prisma/migrations/20261109150300_tenant_health_source_authority_table/migration.sql)
  also enables RLS without FORCE or policies. Its public, anon and authenticated
  grants are revoked. Authority has an organization cascade FK but no tenant FK,
  permitting a deleted tenant's tombstone to survive.
- The [audit invalidator](../prisma/migrations/20261113031300_tenant_health_audit_source_revision/migration.sql),
  [sync-state invalidator](../prisma/migrations/20261114191500_tenant_health_sync_state_source_revision/migration.sql),
  [tenant tombstone](../prisma/migrations/20261113021500_tenant_health_tenant_deletion_tombstone/migration.sql)
  and [tenant insertion](../prisma/migrations/20261113144000_tenant_health_authority_on_tenant_insert/migration.sql)
  functions use default invoker security, qualified authority references and
  `search_path = pg_catalog`. At the reviewed parent, none sets
  `row_security = off`. Invalidation permits
  zero authority updates intentionally: missing/dead authority stays untrusted.
- At the reviewed parent, source invalidation covers INSERT/UPDATE/DELETE without source TRUNCATE guards.
  The [receipt mutation guard](../prisma/migrations/20261113170000_tenant_health_reconciliation_marker/migration.sql)
  rejects TRUNCATE only on its receipt table. It does not guard source tables.
- [Registered database CI](../../.github/workflows/quality-gates.yml) uses a
  PostgreSQL 16 container bootstrap identity for migrations and database tests.
  That owner/admin fixture alone cannot prove a restricted runtime writer contract.

## Distinguish permission outcomes

PostgreSQL applies default-deny RLS when no policy applies; table owners normally
bypass RLS, as do superusers and BYPASSRLS roles. Bypass does not grant missing table
privileges. Whole-table TRUNCATE is outside RLS.
[PostgreSQL 16 RLS](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)

The following are source-derived predictions, not executed database results:

| Effective writer access | Required distinction in the witness |
| --- | --- |
| Source grants but source RLS denies rows | UPDATE/DELETE changes zero source rows; INSERT is rejected. This is not a reproduced stale-authority write. |
| Source write allowed; authority ACL missing | Authority access fails with insufficient privilege and rolls back the source mutation. |
| Source write allowed; authority SELECT/UPDATE granted; live authority hidden by RLS | An invoker UPDATE can affect zero authority rows while the source mutation commits. A privileged reader can still see the previous current pointer. |
| Supported owner/bypass identity with required ACL | Ordinary trigger invalidation should update the exact live authority atomically; this still needs physical proof. |

The third row requires a real source-side exception, such as a scoped source policy
or source ownership, plus authority ACLs without authority row visibility. Mere
grants on today's default-deny source tables do not reproduce it. Missing/dead
authority and a hidden live row must be tested separately. This is a conditional
unsupported-role configuration gap, not evidence that production uses that role.

Function EXECUTE revocations do not establish the effective writer contract.
Test installed-trigger execution under each writer identity; do not infer the
result solely from the trigger function's ACL.

## Proposed bounded correction

For a follow-up migration, evaluate a function-local `SET row_security = off` on
each authority-writing trigger function. PostgreSQL then errors where row policies
would apply; it does not grant visibility or bypass RLS. Even an all-allow policy
does not make that role exempt from the error. This would reject unsupported
RLS-dependent writers instead of silently filtering the authority update, while
retaining the documented owner/bypass contract. The exact exception and full
transaction rollback must be established by registered CI.
[PostgreSQL 16 row_security](https://www.postgresql.org/docs/16/runtime-config-client.html#GUC-ROW-SECURITY)

Do not replace the legitimate zero-row missing/dead-authority behavior with an
unqualified row-count assertion. Do not broadly FORCE RLS or introduce grants as
part of this correction. SECURITY DEFINER is a separate design option requiring
explicit ownership, minimum privileges, safe name resolution and adversarial
temporary-object tests; it is not approved by this audit.
[Function security](https://www.postgresql.org/docs/16/sql-createfunction.html)

## Operations that bypass ordinary invalidation

TRUNCATE requires its own privilege and fires TRUNCATE triggers instead of DELETE
triggers; CASCADE may extend the affected table set. Before activation, either
install explicit refusal guards on all participating source/parent truncation
paths or prove that every supported runtime/maintenance identity is denied those
operations. A receipt-table guard is insufficient.
[PostgreSQL 16 TRUNCATE](https://www.postgresql.org/docs/16/sql-truncate.html)

An owner can disable ordinary source triggers. A superuser or appropriately
authorized parameter setter can select replica mode, suppressing default-mode
triggers and FK checks. BYPASSRLS alone does neither. The protocol cannot protect
itself against an administrator who can replace or disable its enforcement.
[ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html),
[replication role](https://www.postgresql.org/docs/16/runtime-config-client.html#GUC-SESSION-REPLICATION-ROLE)

Consequently, enumerate the trusted DDL/maintenance boundary. An eventual authorized
attestation must cover API, cron, older writers and maintenance identities, effective
role membership/SET ROLE, ownership, ACLs, RLS policies/FORCE, parameter privileges
and trigger enablement. No production identity has been inspected in this step.
A historical receipt is not a perpetual proof against later privilege/DDL drift.

## Registered disposable-PostgreSQL acceptance

1. Establish the intended owner/bypass positive control with real audit and sync
   source mutations, exact revision changes and a second client's committed read.
2. Build a restricted, source-allowed fixture with authority ACL but hidden live
   authority. Verify the role is neither superuser, BYPASSRLS nor authority owner,
   and cannot inherit those rights. In an isolated negative-control fixture using
   the unguarded function, require exactly one committed source change and the
   old pointer visible to a privileged observer. No zero-source-row success.
3. Under the guarded candidate, require an error and complete rollback of the
   same source change and authority state. Cover source INSERT/UPDATE/DELETE and
   both tenant lifecycle functions, including cross-scope source movement.
4. Separate controls must prove missing authority ACL produces a permission error,
   source-side RLS denial does not count as invalidation, and missing/dead authority
   retains the intended untrusted behavior for the supported role.
5. For every supported role, test direct source and parent CASCADE TRUNCATE refusal
   with unchanged source/authority state. Cover multi-table requests and unrelated
   tenant isolation; do not rely on DELETE triggers for this assertion.
6. Require denied trigger disabling/replica-mode changes for ordinary writer roles,
   or a separately reviewed maintenance protocol. Deliberately corrupted disposable
   fixtures must fail the future activation/preflight check; restoring them cannot
   create production proof. This document does not implement that check.
7. Verify installed function settings, role preconditions, trigger modes and the
   expected migration generation on the exact tested head. Skipped tests, zero
   mutations or owner-only tests do not satisfy the restricted-role cases.

Fixtures may create uniquely named NOLOGIN roles only in the registered disposable
CI database. Use explicit grants and scoped policies, independent writer/observer
connections, bounded waits and guaranteed RESET ROLE/transaction cleanup; remove
only test-created objects and roles. Never exercise this matrix on local/live DBs.

## Release state and fallback

This audit adds no database test execution. The parent still has eighteen skipped
top-level physical tests, including sixteen prepared cascade subcases. Its existing
repair generation is partial and unchanged; do not extend its receipt to cover
permission safety or the later sync-state migration. Keep the reader inactive until
the complete writer set, repair, reader aging and failure cases pass exact-head CI
and authorized independent source review. Follow the protected merge and configured
automatic release path, then verify actual health and authenticated freshness.
The operational fallback remains protected main; preserve this inactive branch and
archives without installing partial migrations or manually repairing production.
