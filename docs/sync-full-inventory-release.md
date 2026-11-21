# Full inventory and visit ownership release contract

This candidate is inactive by default. It does not change the cron trigger, Microsoft permissions, licence requirements, provider quotas, retention, or failure retry delays.

The preparation release also contains two notification changes that apply while the switches are off. Recurring incident updates refresh category, severity, title, description, action links and expiry from the current incident payload, alongside the existing metadata, occurrence and resolution updates. An omitted expiry clears a previously stored expiry; severity follows the current payload rather than retaining the first occurrence's value. Directory-audit security titles state that a change occurred only when the audit result is successful; failed and unknown outcomes use outcome-appropriate titles while retaining the existing severity and routing rules. These changes must be included in preparation source review and must not be described as switch-gated.

The lease and audit-ledger migrations include SQL-only CHECK constraints and a monotonic-revision trigger that are not represented by the Prisma models. Preserve these protections when changing the schema or its migration history. All three additive migrations use bounded lock and statement waits; a migration failure blocks rollout and does not authorize manual recovery.

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
5. Follow the staged admission cutover below before enabling the qualified behavior. Then observe natural runs for the existing eligible tenant fleet under its existing batch and resource limits. The 21 November preflight recorded six listed tenants and an unchanged batch limit of ten; this is not proof that all six are eligible or that every provider can finish within twenty minutes. Record duration, completion, deferred sources and resource usage before making any broader capacity guarantee.

## Staged admission cutover

An ordinary rolling flag change is insufficient: an old process with fencing off can still write while a new process admits a leased visit. `HAWKVIEW_SYNC_ADMISSION_PAUSED=true` rejects all three visit entries (scheduled, manual and Exchange verification) before collection or provider work. Authentication and session guards may still query the database before the controller gate. The pause does not claim a successful sync, erase pending work, or drain work already admitted by a prior process. It defaults off and is a deployment control, not a retry-policy change.

1. After source review and exact-head qualification, first release the drain-instrumented code with admission, fencing and twenty-minute inventory switches all off. The old pre-instrumentation process may still overlap this release, so this stage cannot activate fencing. Verify the exact deployed revision and direct Node signal delivery before using its shutdown evidence in a later stage.
2. In a second normal release set admission paused while keeping fencing and twenty-minute inventory off. Preserve the cron schedule and provider limits. Reconcile the preceding instance inventory against each `sync_instance_started` boot ID. Every preceding instrumented instance must emit its own `sync_shutdown_drain_completed` event with the same boot ID and revision, zero tracked SYNC work and `sharedPrismaDisconnected=true`, then actually terminate. The event follows the tracked work and shared Prisma disconnect; it does not prove unrelated HTTP/DB work drained. Process retirement supplies the remaining boundary. An in-flight visit can exceed the platform shutdown grace: a missing event or missing old-instance inventory blocks activation, without manual recovery or a presumed successful visit. Newly deployed paused processes must reject all three SYNC entries.
3. Through the authorized configuration/release process, enable fencing and twenty-minute inventory while removing the admission pause. During this rollout, the preceding version remains paused and only new versions admit owned visits. Verify deployed identity, health, authenticated canary and naturally scheduled full inventories.

The process signal smoke proves the tested Nest shutdown ordering and direct shell `exec` signal delivery with a fake Prisma disconnect. It does not establish Render instance termination, real database-session drainage, or production rollout completion. Those remain release evidence requirements.

The package is not released or tenant-wide protection proven merely because local tests pass. The missed Baseline deadline and separate backend backlog retain their own acceptance criteria.

## Scoped fallback

Before activation, leave both switches off and retain the current deployed behavior. If qualification fails, keep the candidate inactive and fix the failing proof. After activation, first release with admission paused while retaining fencing. Establish termination and drainage of every formerly active instance before a second reviewed release disables the two switches or restores compatible prior behavior. Never roll directly from leased writers to ownerless writers. Preserve durable pending work and evidence. Do not clear incomplete markers, reset provider cursors manually, broaden quotas, change Microsoft permissions, or start a manual synchronization as recovery.
