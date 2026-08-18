# HawkView PM Continuity

Last updated: 2026-08-17

This file is the durable product-management handoff for HawkView. Read it before planning or changing the product after a new Codex session, and update it whenever a milestone, scope decision, blocker, deployment, or working agreement changes.

## Product objective

HawkView is a read-only Microsoft 365 multi-tenant investigation and visibility product for MSPs and administrators. Phase 1 must show important tenant, identity, permission, policy, application, Exchange, SharePoint, and security changes; retain collected sign-in and audit evidence for approximately six months; and clearly distinguish Microsoft-supplied facts from HawkView inferences. Phase 2 may add tenant-changing actions similar to CIPP, but Phase 2 is not active.

Initial market: United States and Canada. Pricing and 1,000-tenant scale work are intentionally deferred until the prototype and evidence quality are ready.

## Working agreements

- Dharmik builds the frontend separately in Google Apps Script (GAS).
- Do not edit frontend files unless Dharmik explicitly requests a specific frontend change.
- Dharmik downloads GAS frontend changes and gives them to the Backend task/agent to integrate and publish to `main`. He may instead place the handoff in the Frontend task.
- Before integrating a frontend handoff, record its source, included files, expected behavior, and whether the GAS copy or repository copy is authoritative.
- Backend work must preserve unrelated user changes and must be reviewed and validated before publishing.
- Never claim complete Microsoft 365 coverage, causation, or actor identity when Microsoft did not supply the evidence.
- Sign-ins are authentication evidence, not primary What Changed events. They may be attached only through defensible correlation and must be labelled non-causal.

## Completed milestones

### P0-1 — What Changed evidence boundary

- Added explicit change classifications.
- Excluded ordinary sign-ins from the primary timeline while retaining sign-in storage and APIs.
- Added exact-correlation supporting sign-ins and source provenance.
- Removed silent 5,000-record investigation truncation.
- Added safe raw-audit detail fallback and organization/tenant isolation.
- Merged to `main` in PR #146.

### P0-2 — M365 administrative change coverage

- Added code-owned source/permission catalog.
- Added actorless snapshot differences for supported Entra, license, domain, SharePoint, and Exchange administrative state.
- Added authoritative-completeness contracts, pagination bounds, baseline locking, redaction, idempotency, and cross-organization checks.
- Merged to `main` in PR #147.

### P0-3 — Automatic, cost-bounded M365 audit ingestion

- Added Office 365 Management Activity API polling for the four core content types.
- Added durable subscriptions, page/content checkpoints, bounded retries, tenant verification, retention, cost quotas, and honest backlog health.
- Render runs a five-minute recovery heartbeat. Entra directory audits use incremental watermark polling; M365 Unified Audit normally polls every 15 minutes when caught up.
- Live Entra test succeeded: group creation and PIM role assignment appeared automatically in about seven minutes without manual sync.
- Merged to `main` in PR #148 (`7d80a165`). Database migrations deployed successfully.

## Active milestone

### P0-4 — Security signal quality and compromise reconstruction

Status: backend implementation complete and validated on `codex/p0-4-security-signal-quality`; awaiting publish/review/deploy approval.

Problem observed in production:

- Routine Exchange mailbox-item operations such as `Create`, `MoveToDeletedItems`, and `SoftDelete` are presented as independent tenant changes.
- A snapshot difference can duplicate an authoritative Microsoft audit event and lose the actor.
- A compromised-account investigation must still retain and connect mailbox behavior to app registration, consent, credential, forwarding, inbox-rule, and privileged-role changes.

Required behavior:

1. Classify Unified Audit records as primary change, supporting security activity, or routine noise using workload, record type, operation, item type, object, and parameters—not the operation verb alone.
2. Keep app registrations, application credentials, OAuth consent, mailbox forwarding, inbox rules, mailbox delegation, transport rules, and tenant configuration as primary changes.
3. Keep destructive/suspicious mailbox behavior as supporting evidence without flooding the primary timeline.
4. Group supporting mailbox activity by mailbox, actor, operation, and time window; explicitly state that temporal/identity association does not establish causation.
5. Prefer Microsoft actor-attributed audit evidence over matching actorless snapshot evidence.
6. Keep unknown or ambiguous activity stored only when bounded and useful; never assert it as a change without a reviewed mapping.
7. Add adversarial tests for the scenario: compromised user registers an app, grants access, creates a mailbox rule, and messages are subsequently moved/deleted.

Implemented behavior:

- Unified Audit events are classified as primary changes, security supporting activity, or routine activity with Exchange-specific rules.
- App/consent/credential, inbox-rule, forwarding, delegation, transport-rule, and configuration operations remain primary changes.
- Generic Exchange `Create`, `Update`, `Copy`, and `Send` records are routine noise and are neither stored nor shown by this slice.
- Destructive mailbox movement/deletion, delegated sending, and mailbox-access signals are retained as supporting evidence, not primary changes.
- Supporting activity is summarized into deterministic 15-minute actor/mailbox/operation groups per Microsoft content blob before storage. Counts, first/last times, and up to ten Microsoft record IDs are kept, reducing PostgreSQL rows and quota use.
- Change detail returns grouped `relatedMailboxActivity` plus actor/target-associated primary changes within one hour. Every association is labelled non-causal unless Microsoft supplies an exact correlation ID—and even exact correlation is not claimed as causation.
- Historical Exchange noise that was already projected is hidden dynamically without a destructive database backfill.
- An actorless snapshot is suppressed when Microsoft audit evidence for the same tenant/category/target exists within 45 minutes.
- No frontend, consent, schema, migration, or live-state change was made.

Validation completed:

- Management Activity tests: 21/21 passed.
- Change investigation tests: 34/34 passed.
- Tenant health: 17/17 passed.
- Service sync freshness: 12/12 passed.
- Collection field state: 2/2 passed.
- TypeScript, Prisma schema validation, production backend build, and `git diff --check` passed.

## Known live issues

- Exchange mailbox configuration can return HTTP 403 when Exchange RBAC `Recipient Management` is absent even when `Exchange.ManageAsAppV2` API consent is present.
- At least one connected tenant intermittently reports that the Management Activity tenant does not exist; tenant eligibility/staleness needs a later connection-health repair.
- Render service-initiated bandwidth is the current infrastructure cost warning. Scale architecture is deferred, but per-tenant cost and lag instrumentation is required before a broad beta.
- Current retention is approximately six calendar months. Immutability, tamper resistance, restore drills, and legal-grade archival are not complete.

## Next milestones after P0-4

1. Connection and collection health: actionable permission/RBAC/unsupported-tenant states.
2. Retention and investigations: prove six-month access, export, restore testing, and archival decision.
3. Beta readiness: security/isolation review, MSP roles, onboarding/offboarding, monitoring, support workflow, and a controlled 3–5 MSP pilot.
4. Scale foundation after prototype validation: durable job queue, separate workers, fair scheduling, delta sources where supported, partitioning, cold storage, and load gates at 25/100/250/1,000 tenants.

## Update checklist

When changing this file, record:

- What was decided and why.
- Exact backend/frontend scope.
- Branch, PR, merge commit, and deployment status.
- Validation performed and anything that could not be validated.
- Remaining limitations and the next concrete task.
