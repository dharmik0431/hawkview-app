# HAW-70: owned license collector qualification

Prepared physical witness, 21 November 2026. This extends inactive integration
`e473273c4e68105c6670e13307dd14d4f696c0c4`, based on protected main
`8928934406fdcaf5fdb911d2003ac03439b05145`. The new physical case has not run.
It adds no runtime caller, migration, invalidation trigger, workflow flag,
retry policy, production setting or provider request.

## Scope

The existing registered
[authority suite](../src/tenants/tenant-health-source-authority.database-integration.test.ts)
now runs the same actual license-collector controls in two separately named
physical cases. The original ownerless case retains its name and assertions.
The new owned case acquires a real fixture lease with the existing admission
helper and standard visit duration, then passes that exact owner to the actual
`syncLicenses` method. It does not enable the global fencing flag or exercise
the scheduler/lifecycle wrapper. Admission uses the unwrapped Prisma client;
cleanup requires successful exact-owner release before disconnecting, and the
existing fixture cleanup removes its isolated organization and dependent rows.

Both cases use real Prisma transactions and the real change-evidence builder.
Only provider responses and unrelated external sinks are synthetic. The five
sequential controls remain acknowledged commit, known precommit rollback,
positive retry after that known rollback, complete empty inventory, and
unchanged empty inventory. Inventory, evidence and baseline are compared from
the real transaction and a separate committed observer. Sibling inventory and
another organization's authority remain unchanged. RUNNING and terminal
sync-state writes remain separate from the materialization transaction; the
two authority advances come from those state writes, not license invalidation.

## Owned lock observations

At the existing boundary immediately before the final LICENSES baseline upsert,
three distinct PostgreSQL sessions are asserted: the actual Prisma transaction,
the committed-state observer and the fixture writer used only for lock probes.
The owned case probes these exact fixture rows without waiting:

| Probe | Expected observation while materialization is held |
| --- | --- |
| Organization `FOR UPDATE NOWAIT` | Exact SQLSTATE `55P03`; a conflicting organization lock exists. |
| Tenant `FOR SHARE NOWAIT` | Exact `55P03`; this conflicts with the owner check's `NO KEY UPDATE`, while ordinary foreign-key `KEY SHARE` alone is compatible. |
| Visit lease `FOR NO KEY UPDATE NOWAIT` | Exact `55P03`; the materialization transaction holds the lease row against this conflicting lock. |

Each probe runs under a savepoint and rolls back to it, including after an
expected refusal. The outer probe transaction also always rolls back. Before
the first collector call and after each complete outcome, the same probes must
succeed and return exactly one row, then roll back. Empty or wrong scopes,
timeouts and unrelated errors cannot satisfy the refusal oracle. These controls
check both fixture validity and release of conflicting locks after each outcome.

The organization probe alone cannot attribute its lock to the explicit owner
check: ordinary inventory/evidence foreign-key checks can also take an
organization key-share lock. Interpret the combined observations, especially
the exact lease row and stronger tenant mode, with source inspection. This
fixture does not prove the complete order in which PostgreSQL acquired every
lock, nor does it run a competing materialization or delete operation.

The additional observer work must fit the unchanged Prisma interactive
transaction lifetime in registered CI. No timeout was relaxed. All probes use
immediate refusal rather than an arbitrary wait or production retry policy.

## Required execution and remaining gaps

Only the registered hosted disposable PostgreSQL job may execute either
physical case. The existing shared guard and the fixture's explicit hosted
port check remain before client construction. The suite now contains 35
physical top-level cases, plus its separate non-database adapter case. The new
case contains five sequential controls, not five extra test declarations.
Earlier CI/Claude evidence on an older public commit does not qualify this
new source or the integrated current-main schema.

Exact-head CI must execute the original and new names once with no skips,
alongside the complete required inventory, dependency/build/image checks, and
fresh-schema plus current-main upgrade migration proof. A source-only or local
skip run is not physical evidence.

Audit-replay acknowledgment after the baseline, lease expiry/takeover and lost
ownership, independent direct writers, both parent-deletion orders, uncertain
commit recovery, installed license invalidation, restricted roles and fleet
cost remain unproved by this slice. The synthetic notification sink does not
prove the actual notification writer. Full SYNC activation belongs to its
separate task. Keep the HAW-70 package inactive and protected main as fallback;
no partial migration deployment or manual recovery is authorized by this test.
