# Full inventory and visit ownership release contract

This candidate is inactive by default. It does not change the cron trigger, Microsoft permissions, licence requirements, provider quotas, retention, or failure retry delays.

## Intended behavior

After release qualification, enabling `HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED=true` selects healthy full inventories at their inclusive twenty-minute eligibility boundary. Full USERS enumeration starts without the old delta checkpoint. Existing bounded collector limits and scheduler admission remain in force. A twenty-minute eligibility interval is not a guarantee that a provider-dependent visit finishes in twenty minutes.

Backend service freshness, tenant health and collection readiness use that active inventory cadence: current through twenty minutes, then aging during the existing two-hour inventory grace, and stale after two hours twenty minutes. Activity freshness and failure retry delays retain their existing policies. Exact next-attempt timestamps remain unknown because admission, contention and backoff decide them. The legacy console's per-dataset expected-daily label and due badge are hard-coded in frontend code and remain unchanged by this backend-only package; those labels are not proof of the released cadence.

`HAWKVIEW_TENANT_VISIT_FENCING=enabled` admits one durable owner per tenant visit, renews that ownership, stops subsequent work on known ownership loss, and releases only after admitted work drains. Every owned materialization must verify the exact organization, tenant, token and generation in its transaction. Both switches remain absent from deployment configuration until the entire package passes its release gates.

Provider failures, unavailable permissions and partial responses remain incomplete. Healthy sources may progress while other sources wait for their existing retry delay. A failed domain discovery cannot make DNS inventory appear freshly complete. An incomplete full user response cannot delete unseen users or advance a successful checkpoint.

Audit evidence and refresh requests commit together. A later owned visit can replay unfinished work even when a feed is empty. Completion advances only in the same transaction as a complete authoritative result, for the exact requested revision. A fulfilled promise alone is not completion evidence. Deferred, rejected or unacknowledged work prevents an overall successful result. Existing retry cooldowns also apply to replayed work.

## Qualification and activation

1. Review the exact final source commit independently, including all writes reachable from manual, scheduled, verification and recovery entries.
2. Pass ordinary checks and registered disposable PostgreSQL CI at that exact commit. Include stale-owner rejection, held-write takeover ordering, rollback, renewal uncertainty, admission contention, duplicate M365 events and durable replay after interruption.
3. Verify the existing protected merge checks and configured automatic API and cron release. Do not bypass protection, manually recover deployments or run a manual sync.
4. Verify deployed commit identity, actual health, the authenticated canary, and naturally scheduled freshness across the affected datasets. HTTP health alone does not establish data freshness.
5. Enable the qualified behavior through the authorized normal configuration/release process, then observe natural runs at the initially approved three-eligible-tenant scale. Record duration, completion, deferred sources and resource usage before making any broader capacity guarantee.

The package is not released or tenant-wide protection proven merely because local tests pass. The missed Baseline deadline and separate backend backlog retain their own acceptance criteria.

## Scoped fallback

Before activation, leave both switches off and retain the current deployed behavior. If qualification fails, keep the candidate inactive and fix the failing proof. After activation, use only the normal protected, reviewed release process to disable the two switches or revert the scoped implementation; preserve durable pending work and evidence. Do not clear incomplete markers, reset provider cursors manually, broaden quotas, change Microsoft permissions, or start a manual synchronization as recovery.
