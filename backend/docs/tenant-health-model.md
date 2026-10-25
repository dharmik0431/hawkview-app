# Tenant health model (v3)

Tenant health is evaluated on the backend from connection, collector, security,
and operational evidence. A connected tenant is not automatically healthy.

## Rules

- Required collectors include directory inventory, identity configuration,
  audit evidence, application posture, and SharePoint site inventory. Other
  workloads are assessed according to the registry and authoritative
  applicability evidence; a disconnected collector is never inferred from an
  unavailable licence alone.
- `SUCCESS` is distinct from a successful zero-record collection (`EMPTY`, for
  collectors that record it). A failed, pending, stale, or permission-blocked
  collector is never counted as complete.
- Incremental collectors are `CURRENT` for 15 minutes and `AGING` until two
  hours. Daily inventory collectors are `CURRENT` for 24 hours and `AGING`
  until 26 hours. These windows are centralized in
  `TENANT_HEALTH_FRESHNESS`.
- Unsupported/not-licensed collectors affect completeness evidence but are not
  failures and never imply a disconnected tenant.
- Overall status precedence is: disconnected, critical, degraded, attention,
  pending, healthy, unknown. `HEALTHY` requires a healthy connection, complete
  current required data, healthy security evidence, and no failed jobs.
- `security.directoryAuditRead.status` describes the local retained-event
  read, separately from Microsoft collector completeness. It is `COMPLETE`
  only when that tenant's bounded audit query did not truncate its eligible
  24-hour window. The tenant-directory query uses one parameterized lateral
  read for the authorized tenant pairs and reads at most 17 eligible events
  per tenant: an exact 16 is complete and a 17th makes that tenant `CAPPED`.
  The event and saved-expiry predicates run before the per-tenant limit, and
  ordering is by event time then row ID. A query error makes all returned
  tenant windows `NOT_READ`; other tenant mapping paths also use `NOT_READ`.
  For `CAPPED` or `NOT_READ`, `eligibleEventCount` is `null` and absent audit findings cannot
  make security or overall status healthy. Observed high or critical findings
  still take precedence. One noisy tenant no longer consumes a quiet tenant's
  event allowance. The 16-event threshold still limits deep per-tenant review;
  1,000-tenant throughput and row size need disposable-CI measurements. The
  separate per-tenant health snapshot writes remain a scaling issue.

Every list evaluation returns the legacy `healthScore`, `mfaCoverage`, and
`attention` fields plus a versioned `tenantHealth` object. It also saves an
immutable, tenant-and-workspace-scoped row in `tenant_health_snapshots`.
The numeric `healthScore` remains an observed-attention score for API
compatibility and may be 100 with incomplete audit read coverage. Consumers
must use `tenantHealth.overallStatus` and `security.directoryAuditRead` for a
health claim.

## API examples

```json
{ "tenantHealth": { "healthModelVersion": 3, "overallStatus": "HEALTHY", "connection": { "status": "HEALTHY" }, "data": { "status": "COMPLETE", "freshnessStatus": "CURRENT", "completenessPercent": 100 }, "security": { "status": "HEALTHY", "directoryAuditRead": { "status": "COMPLETE", "eligibleEventCount": 0 } }, "operations": { "status": "HEALTHY" } } }
```

```json
{ "tenantHealth": { "healthModelVersion": 3, "overallStatus": "ATTENTION", "connection": { "status": "HEALTHY" }, "data": { "status": "PARTIAL", "freshnessStatus": "CURRENT", "completenessPercent": 82 }, "security": { "status": "NEEDS_REVIEW", "recommendationCount": 2, "directoryAuditRead": { "status": "COMPLETE", "eligibleEventCount": 0 } } } }
```

```json
{ "tenantHealth": { "healthModelVersion": 3, "overallStatus": "DEGRADED", "connection": { "status": "HEALTHY" }, "data": { "status": "STALE", "staleResources": 1 }, "operations": { "status": "DEGRADED", "failedJobs": 1 } } }
```

```json
{ "tenantHealth": { "healthModelVersion": 3, "overallStatus": "DISCONNECTED", "connection": { "status": "DISCONNECTED", "reasonCode": "revoked" }, "data": { "status": "NOT_COLLECTED" } } }
```

```json
{ "tenantHealth": { "healthModelVersion": 3, "overallStatus": "UNKNOWN", "connection": { "status": "HEALTHY" }, "data": { "status": "COMPLETE" }, "security": { "status": "UNKNOWN", "directoryAuditRead": { "status": "CAPPED", "eligibleEventCount": null } } } }
```

`resourceHealth` contains the timestamp, reason code, and classification that
led to each decision. Logs use internal and Microsoft tenant IDs only; they do
not contain credentials or tokens.
