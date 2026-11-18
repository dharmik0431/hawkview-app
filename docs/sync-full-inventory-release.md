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
5. Follow the staged admission cutover below before enabling the qualified behavior. Then observe natural runs at the initially approved three-eligible-tenant scale. Record duration, completion, deferred sources and resource usage before making any broader capacity guarantee.

## Staged admission cutover

An ordinary rolling flag change is insufficient: an old process with fencing off can still write while a new process admits a leased visit. `HAWKVIEW_SYNC_ADMISSION_PAUSED=true` rejects all three visit entries (scheduled, manual and Exchange verification) before database or provider work. It does not claim a successful sync, erase pending work, or drain work already admitted by a prior process. It defaults off and is a deployment control, not a retry-policy change.

1. After source review and exact-head qualification, release the candidate with admission paused and both fencing and twenty-minute inventory switches off. Preserve the existing cron schedule and provider limits. Newly deployed processes must reject sync admission while normal read-only application routes remain available.
2. Establish that every preceding API instance has terminated and its database work has drained. New-instance health alone is insufficient. Render documents an overlap before terminating old instances; retain actual termination/deployment evidence and confirm that it covers the entire old instance set. If that evidence is unavailable, keep admission paused and do not advance.
3. Through the authorized configuration/release process, enable fencing and twenty-minute inventory while removing the admission pause. During this rollout, the preceding version remains paused and only new versions admit owned visits. Verify deployed identity, health, authenticated canary and naturally scheduled full inventories.

The synthetic overlap tests establish application admission behavior only. They do not establish Render instance termination, database-session drainage, or production rollout completion. Those remain release evidence requirements.

The package is not released or tenant-wide protection proven merely because local tests pass. The missed Baseline deadline and separate backend backlog retain their own acceptance criteria.

## Scoped fallback

Before activation, leave both switches off and retain the current deployed behavior. If qualification fails, keep the candidate inactive and fix the failing proof. After activation, first release with admission paused while retaining fencing. Establish termination and drainage of every formerly active instance before a second reviewed release disables the two switches or restores compatible prior behavior. Never roll directly from leased writers to ownerless writers. Preserve durable pending work and evidence. Do not clear incomplete markers, reset provider cursors manually, broaden quotas, change Microsoft permissions, or start a manual synchronization as recovery.
