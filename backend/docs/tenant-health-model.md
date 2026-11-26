# Tenant health model (v3)

Tenant health is evaluated on the backend from connection, collector, security,
and operational evidence. A connected tenant is not automatically healthy.

## Rules

- Required collectors are: directory inventory, identity configuration, audit
  evidence, and application posture. Exchange, SharePoint, sign-in, devices,
  roles, and secure-score collectors are optional because availability can be
  license/workload dependent.
- `SUCCESS` is distinct from a successful zero-record collection (`EMPTY`, for
  collectors that record it). A failed, pending, stale, or permission-blocked
  collector is never counted as complete.
- A collector is `CURRENT` for 15 minutes, `AGING` until two hours, then
  `STALE`. These windows are centralized in `TENANT_HEALTH_FRESHNESS`.
- Unsupported/not-licensed collectors affect completeness evidence but are not
  failures and never imply a disconnected tenant.
- Overall status precedence is: disconnected, critical, degraded, attention,
  pending, healthy, unknown. `HEALTHY` requires a healthy connection, complete
  current required data, healthy security evidence, no failed jobs, and a
  completely read audit window.
- Audit evidence is read per tenant, each tenant with its own 500-event cap, and
  the read reports itself as `COMPLETE`, `CAPPED` or `UNREAD`. `CAPPED`,
  `UNREAD` and any withheld payload leave the window unknown, which makes
  security evidence `UNKNOWN` and refuses `HEALTHY`. Unknown coverage never
  lowers the severity of a finding that WAS observed, and never outranks
  disconnected, critical or degraded. A mapper path that performs no audit read
  reports `UNREAD`/`NOT_READ` rather than an empty complete window; a call that
  supplies no completeness at all fails closed the same way.
- `COMPLETE` means only that this persisted 24-hour audit window was read for
  that tenant without reaching its cap and without a value being withheld. It is
  not provider completeness, not source-version coherence, not authority
  admission, and not permission to assert that a tenant is healthy.

## Version 3

Version 3 exists because audit-window completeness changed what `HEALTHY`
MEANS. A version 2 `HEALTHY` row could come from a workspace-wide audit read
that one noisy tenant had consumed, or from a tenant the read omitted entirely,
so it did not assert that the tenant's audit window had been read; a version 3
`HEALTHY` row does. Comparing the two across the boundary would compare
different claims, so the number changed rather than the meaning of an unchanged
number.

Compatibility: every version 2 field keeps its name and meaning, and version 3
only ADDS `auditEvidence` (`status`, `reason`, `windowComplete`,
`observedCount`, `withheldPayloads`, `assessedAt`). That summary never carries
SQL, a database or source error, a credential, or an event payload. Snapshot
rows keep the version they were written with and are never rewritten or
backfilled, and the version participates in history deduplication so the first
evaluation under this model is retained rather than suppressed by an unchanged
status and label set.

Every list evaluation returns the legacy `healthScore`, `mfaCoverage`, and
`attention` fields plus a versioned `tenantHealth` object. It also saves an
immutable, tenant-and-workspace-scoped row in `tenant_health_snapshots`.

## API examples

```json
{ "tenantHealth": { "healthModelVersion": 3, "overallStatus": "HEALTHY", "connection": { "status": "HEALTHY" }, "data": { "status": "COMPLETE", "freshnessStatus": "CURRENT", "completenessPercent": 100 }, "security": { "status": "HEALTHY" }, "operations": { "status": "HEALTHY" } } }
```

```json
{ "tenantHealth": { "healthModelVersion": 3, "overallStatus": "ATTENTION", "connection": { "status": "HEALTHY" }, "data": { "status": "PARTIAL", "freshnessStatus": "CURRENT", "completenessPercent": 82 }, "security": { "status": "NEEDS_REVIEW", "recommendationCount": 2 } } }
```

```json
{ "tenantHealth": { "healthModelVersion": 3, "overallStatus": "DEGRADED", "connection": { "status": "HEALTHY" }, "data": { "status": "STALE", "staleResources": 1 }, "operations": { "status": "DEGRADED", "failedJobs": 1 } } }
```

```json
{ "tenantHealth": { "healthModelVersion": 3, "overallStatus": "DISCONNECTED", "connection": { "status": "DISCONNECTED", "reasonCode": "revoked" }, "data": { "status": "NOT_COLLECTED" } } }
```

Each list evaluation captures ONE internal assessment time and threads it
unchanged through audit eligibility, collection readiness, sync freshness and
health evaluation. HTTP callers never supply it. Audit evidence is read as
bounded sequential pages of at most 16 exact `(organization, tenant)` pairs,
one read in flight at a time, and the matching history work stays within the
page rather than fanning out over the whole fleet.

`resourceHealth` contains the timestamp, reason code, and classification that
led to each decision. Logs use internal and Microsoft tenant IDs only; they do
not contain credentials or tokens.
