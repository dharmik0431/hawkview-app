# Tenant health model (v2)

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
  current required data, healthy security evidence, and no failed jobs.

Every list evaluation returns the legacy `healthScore`, `mfaCoverage`, and
`attention` fields plus a versioned `tenantHealth` object. It also saves an
immutable, tenant-and-workspace-scoped row in `tenant_health_snapshots`.

## API examples

```json
{ "tenantHealth": { "healthModelVersion": 2, "overallStatus": "HEALTHY", "connection": { "status": "HEALTHY" }, "data": { "status": "COMPLETE", "freshnessStatus": "CURRENT", "completenessPercent": 100 }, "security": { "status": "HEALTHY" }, "operations": { "status": "HEALTHY" } } }
```

```json
{ "tenantHealth": { "healthModelVersion": 2, "overallStatus": "ATTENTION", "connection": { "status": "HEALTHY" }, "data": { "status": "PARTIAL", "freshnessStatus": "CURRENT", "completenessPercent": 82 }, "security": { "status": "NEEDS_REVIEW", "recommendationCount": 2 } } }
```

```json
{ "tenantHealth": { "healthModelVersion": 2, "overallStatus": "DEGRADED", "connection": { "status": "HEALTHY" }, "data": { "status": "STALE", "staleResources": 1 }, "operations": { "status": "DEGRADED", "failedJobs": 1 } } }
```

```json
{ "tenantHealth": { "healthModelVersion": 2, "overallStatus": "DISCONNECTED", "connection": { "status": "DISCONNECTED", "reasonCode": "revoked" }, "data": { "status": "NOT_COLLECTED" } } }
```

`resourceHealth` contains the timestamp, reason code, and classification that
led to each decision. Logs use internal and Microsoft tenant IDs only; they do
not contain credentials or tokens.
