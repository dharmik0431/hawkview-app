# SYNC admission-pause release record

This record prepares stage 2 of the staged cutover in `sync-full-inventory-release.md`. It is a release candidate until its protected merge and automatic deployments are verified. The candidate also adds one physical regression case to an existing registered database suite. Its only runtime change is best-effort refusal logging at the existing admission gate: observability that does not control admission. Admission semantics, the 503 response and its failure policy, provider limits, cron schedule, resource plan and Blueprint configuration are all unchanged. That runtime delta requires independent review and exact-head CI like any other runtime change.

## Preparation evidence

- Preparation source `f86040863c4ee8e5d05fb2d2b275a044333afe7e` passed [exact-source CI](https://github.com/dharmik0431/hawkview-app/actions/runs/44871035463) and [PR CI](https://github.com/dharmik0431/hawkview-app/actions/runs/44870996294), including all 496 physical database cases with zero failures or skips. The PR merge tree matches the exact source tree.
- Independent preparation source review completed; the migration lock guard and explicit notification behavior documentation were included before merge.
- [PR 374](https://github.com/dharmik0431/hawkview-app/pull/374) merged normally as `8928934406fdcaf5fdb911d2003ac03439b05145` on 21 November 2026 at 05:36 UTC. Both configured Render services automatically deployed that revision. All three additive migrations applied successfully.
- The API reported that exact revision and a connected database with current schema. The automatic [authenticated two-MSP canary](https://github.com/dharmik0431/hawkview-app/actions/runs/44871772285) and [exact deployment smoke check](https://github.com/dharmik0431/hawkview-app/actions/runs/44871772071) passed their actual test steps.
- One current instrumented API instance was observed. Its startup event identifies the preparation revision and Node running as process 1. The prior pre-instrumentation instance is absent from the current instance selector. The private operational record retains the exact boot and instance identifiers for stage-2 reconciliation.

## Stage-2 intent and release gate

Independent activation-source review has covered tenant materialization, M365 reconciliation, risk continuity, renewal, takeover and recovery. Download-byte accounting is a separate additive ledger: bytes already downloaded remain charged even when a visit loses ownership, and unused reservation settlement must preserve successor charges. The added physical case forces a takeover before the old refund, runs and settles a successor download, verifies the exact remaining byte charge and rejected old materialization, and tests the daily ceiling against a control ledger containing only the successor charge. Its quota override is confined to the disposable test process and restored during cleanup. Require this case to pass in registered disposable PostgreSQL CI at the final candidate head; a local typecheck is not execution evidence.

After remaining activation-source qualification, save only these API settings through the authorized configuration process, preserving all other settings:

| Setting | Value for this stage |
| --- | --- |
| HAWKVIEW_SYNC_ADMISSION_PAUSED | true |
| HAWKVIEW_TENANT_VISIT_FENCING | disabled |
| HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED | false |

The scheduler remains every five minutes, the existing batch limit remains ten, and existing instance sizes remain unchanged. The three switches belong to the API service; do not copy credentials or replace either service's environment. An environment save is not proof of deployment. Normal protected merge of this release record is intended to trigger the existing automatic API and cron deployments; no manual deployment or sync is part of this stage.

Before merging, require exact-head CI and independent review of the runtime delta relative to the previously reviewed preparation package. That delta is limited to best-effort refusal logging at the admission gate with unchanged admission semantics; the application source is otherwise identical. Do not pause production while remaining activation-source qualification is blocked. Preserve the current working sync until the cutover can proceed.

## Required observations before activation

1. Confirm the deployed API and cron revisions, actual health and authenticated canary.
2. Reconcile every preceding instrumented API instance with its recorded startup boot ID and revision. Require its matching shutdown-drain completion with zero tracked work and shared Prisma disconnected, followed by actual instance retirement.
3. Confirm the new revision rejects scheduled, manual and Exchange-verification SYNC admissions without beginning collection. Observe the natural scheduler; do not trigger a manual sync. Confirm this from the API-side refusal witness described below, not from the cron run result.
4. Keep fencing and twenty-minute inventory off until every source and cutover proof is present. A missing acknowledgement, failed migration/deployment or missing instance evidence blocks activation. No manual recovery is authorized.

While admissions are paused the scheduled cron run fails every five minutes by design: the API answers 503 and `scheduled-sync-trigger.mjs` treats any non-success response as a failure, while its log summary deliberately omits the response body. A red cron run inside the pause window is therefore expected and is not evidence of a fault, and the cron log alone cannot separate the pause from an unrelated 5xx. The API now emits a bounded structured witness at the admission gate, `{"event":"tenant_sync_admission","outcome":"REFUSED","reasonCode":"TENANT_SYNC_ADMISSION_PAUSED"}`, carrying no tenant identifier, caller detail, secret or response body; it is the positive evidence for observation 3. The refusal precedes every database write, so it changes no collector state, failure counter or notification, and the 503 response, failure policy, quotas and cadence are unchanged. Keep a liveness signal that does not run through the scheduled path: the health check and the authenticated canary already serve this.

Twenty-minute synchronization is not active merely because this record exists or is merged. Activation is a separate normal release, followed by naturally scheduled inventory and resource-use observations. Before activation, the scoped fallback retains the existing ownerless behavior with fencing and full20 off. Returning from a paused state also requires the normal authorized release process.
