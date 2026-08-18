# HawkView PM Continuity

Last updated: 2026-08-18 during P0-6 collection-readiness implementation

This file is the durable product-management handoff for HawkView. Read it before planning or changing the product after a new Codex session, and update it whenever a milestone, scope decision, blocker, deployment, or working agreement changes.

Continuity rule: every HawkView task must read this file before making product or implementation decisions. Before finishing a milestone, update this file with the actual merged and deployed state—not merely the planned state. If repository code, GitHub, and this file disagree, verify the external state and correct this file.

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

Status: merged and deployed. The mailbox-rule source/provenance and audit-investigation repair is also merged; remaining live acceptance is product validation, not an unpublished code state.

Live OWA inbox-rule acceptance finding:

- Dharmik created and enabled `HAWKVIEW-P04-TEST` in tenant `MSFT` for `dharmik0417@szlk.onmicrosoft.com` after 22:49 America/Toronto.
- HawkView customer tenant `6facb85e-7a71-472f-b5ea-2938ee25fe3b` maps to Microsoft tenant `320721eb-d16f-4cab-acdd-f7d5578d7a60` (`MSFT`, `szlk.onmicrosoft.com`).
- The rule was absent from What Changed during the acceptance window. Render showed this exact tenant's `M365_AUDIT` collector failing at 22:25, 22:40, 23:00, and 23:15 with Microsoft's HTTP 400 `Tenant ... does not exist` response while starting `Audit.AzureActiveDirectory`.
- Because subscription activation always selected the first missing content type, the failing Entra workload could prevent `Audit.Exchange` from ever being activated. A cooldown run could then appear successful even though subscriptions were missing. The independent Graph mailbox-rule snapshot was only part of the daily full inventory.

P0-4 mailbox-rule detection repair in progress:

- Branch/worktree: `codex/p0-4-mailbox-rule-detection` / `hawkview-p041`, based on `origin/main` at `e56eef1`.
- Backend only; no frontend, tenant, consent, Render, or live configuration changes.
- Exchange subscription activation is attempted first. Missing workloads rotate by oldest/never-attempted state rather than retrying one content type forever.
- A content-type HTTP 400 is persisted for that subscription without blocking polling of already-enabled workloads. Any failed subscription makes `M365_AUDIT` failed/partial instead of healthy.
- Incremental tenant runs independently refresh inbox-rule Graph snapshots every 15 minutes for tenants with at most 250 active directory users. Both interval and cap are environment-configurable; larger tenants retain the daily full-inventory fallback until a scalable sharded/risk-based scanner is implemented.
- Validation so far: Management Activity 23/23, What Changed/snapshot 36/36, tenant health 17/17, service freshness 13/13, collection field state 2/2; TypeScript, Prisma validation, production build, and diff check pass.
- Repair committed and pushed on `codex/p0-4-mailbox-rule-detection`; draft PR #151 is open. It is not merged or deployed. Live acceptance must be repeated after deployment; leave `HAWKVIEW-P04-TEST` enabled so the new snapshot path can detect it.

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
- No frontend, consent, schema, or migration change was required.

Validation completed:

- Management Activity tests: 21/21 passed.
- Change investigation tests: 34/34 passed.
- Tenant health: 17/17 passed.
- Service sync freshness: 12/12 passed.
- Collection field state: 2/2 passed.
- TypeScript, Prisma schema validation, production backend build, and `git diff --check` passed.

Publish and deployment:

- Source commit: `96851ea` (`Improve M365 security signal quality`).
- Merged to `main` in PR #149.
- Merge commit: `c81bddaec74f891479b47ceb6f37ac83211b7096`.
- The live Render `hawkview-api-dev` service is linked to `dharmik0431/hawkview-app`, branch `main`, and marked the `c81bdda` deployment live after `New commit via Auto-Deploy`.
- The Render `hawkview-sync-dev` cron is also linked to `main`; its build for `c81bdda` succeeded through Auto-Deploy. A successful build is not the same as a successful tenant sync run.
- Final live acceptance still required: create or change an inbox rule, generate controlled mailbox move/delete activity, then confirm HawkView shows the rule as a primary change and groups the mailbox operations only as supporting evidence.

## Known live issues

- MSFT currently has no reliable Unified Audit coverage: Microsoft rejects subscription activation with `Tenant ... does not exist`. This affects the exact tenant used for the live inbox-rule test and must be shown as incomplete audit coverage, not healthy.
- Inbox-rule Graph snapshots were daily-only in the deployed build. The P0-4 repair adds a bounded 15-minute small-tenant safety scan, but tenants above the configured user cap still need a sharded/risk-based fast scanner before broad beta.
- Exchange mailbox configuration can return HTTP 403 when Exchange RBAC `Recipient Management` is absent even when `Exchange.ManageAsAppV2` API consent is present.
- Render service-initiated bandwidth is the current infrastructure cost warning. Scale architecture is deferred, but per-tenant cost and lag instrumentation is required before a broad beta.
- Current retention is approximately six calendar months. Immutability, tamper resistance, restore drills, and legal-grade archival are not complete.

## Next milestones after P0-4

1. Complete the controlled live P0-4 acceptance scenario and record event delay, grouping, provenance, and any false positives.
2. Connection and collection health: actionable permission/RBAC/unsupported-tenant states.
3. Retention and investigations: prove six-month access, export, restore testing, and archival decision.
4. Beta readiness: security/isolation review, MSP roles, onboarding/offboarding, monitoring, support workflow, and a controlled 3–5 MSP pilot.
5. Scale foundation after prototype validation: durable job queue, separate workers, fair scheduling, delta sources where supported, partitioning, cold storage, and load gates at 25/100/250/1,000 tenants.

## Update checklist

When changing this file, record:

- What was decided and why.
- Exact backend/frontend scope.
- Branch, PR, merge commit, and deployment status.
- Validation performed and anything that could not be validated.
- Remaining limitations and the next concrete task.

## Scoped repair — What Changed provenance and audit-sync investigation

Status: merged to `main` and deployed as part of the current baseline. It remains a response-presentation and operational-navigation repair; it does not make Management Activity ingestion realtime.

- The What Changed API now derives a sanitized presentation DTO from immutable stored evidence. Directory Audit remains `Entra`; Unified Audit retains its declared workload; snapshot evidence now retains its workload, so Exchange mailbox-rule differences display `Exchange Online` with `HawkView snapshot comparison` provenance and a sanitized `Microsoft Graph mailbox rules` source.
- M365 Audit health findings now point to `/tenants/{id}/settings?section=sync&resource=M365_AUDIT`. The settings page recognizes that deep link, scrolls to synchronization health, and displays read-only state, last attempt, last success, and a redacted current reason. It adds no retry or permission behavior.
- Dashboard and alert modal navigation preserve backend-provided same-origin action URLs.

QA status: final independent QA passed (P0=0, P1=0) before publish.

Validation: frontend sanitizer/navigation 15/15; tenant health 26/26; changes 38/38; root and backend TypeScript checks; Prisma validation with a non-production placeholder `DATABASE_URL`; and `git diff --check` pass. Both full production builds passed in the immediately preceding independent QA environment; no build configuration changed. Direct objects now use the identical case-insensitive, underscore/hyphen-tolerant safe-field projection as parsed JSON; only bounded primitive status/error-code/message/correlation/tenant/URL fields survive, and URLs retain origin plus pathname only. Arbitrary/nested/prototype-like data and secret-like keys remain dropped.

Limitations: this changes only response presentation and collection-failure navigation. It does not create evidence for failed audit collection, change RBAC, update historic stored records, or make Microsoft audit ingestion realtime. P2: a credential expression inside an otherwise approved message can consume later safe correlation, tenant, or URL context, reducing diagnostic usefulness; frontend and backend handle it equivalently and do not leak credentials.

## Scoped implementation — P0-5 tenant configuration history

Status: merged in PR #153 and deployed from `main` at `e542a860b7be22d3c86ea472f7f5dc1880c0396d`. The matching database migration was part of the deployed release. No Microsoft consent or tenant configuration was changed by this release.

- Added a transactional `ORGANIZATION_CONFIGURATION` snapshot resource backed by Microsoft Graph `/organization` under the existing `Organization.Read.All` permission. It tracks organization display name and stable tenant identity, with first-baseline protection, tenant/resource advisory locking, provenance, before/after values, and actor-honest snapshot evidence. The repair now rejects missing, partial, multi-record, or mismatched Graph organization IDs before any snapshot/baseline write.
- Existing verified-domain and subscribed-SKU snapshots now have explicit product-guidance impact metadata in What Changed list/detail. Supported differences include domain add/remove/default-state transitions and subscription SKU add/remove/purchased-capacity/capability/status transitions. Consumed-seat utilization is deliberately excluded from the primary subscription snapshot to avoid treating ordinary per-user assignment changes as tenant configuration events. Guidance intentionally does not claim external DNS, a billing event, or a per-user/group license assignment.
- The directory-audit reconciliation map now refreshes organization configuration only for an exact allowlist of display-name/profile operations. It does not treat operational collector health, generic tenant updates, or unrelated organization settings as a tenant setting change.
- The code-owned configuration coverage catalog records the Exchange organization customization (`Get-OrganizationConfig IsDehydrated`) and Unified Audit ingestion (`Get-AdminAuditLogConfig UnifiedAuditLogIngestionEnabled`) semantics and impact guidance, but marks both source-dependent and **not collected**: the current app-only Exchange Admin API path has not been verified to execute those cmdlets safely under the deployed Exchange RBAC. No guessed collector, permission, or live PowerShell call was added.
- The What Changed detail drawer renders a bounded `Potential impact` block only when the backend derives a trusted, static catalog match from snapshot source/resource/workload/category/operation. Stored evidence cannot supply or override impact text, labels, or product-guidance flags. Historical, directory-audit, Unified Audit, and unknown records without an exact catalog match continue to render without impact guidance. The frontend accepts only the discriminated bounded product-guidance DTO. The frontend API boundary normalizes every currently emitted backend workload/source label through an explicit closed map, with an `Unknown` fallback for malformed or unrecognized values.

Live UAL incident note: the P0-4 subscription-start failure/root-cause and the user-completed remediation are recorded as an operational collection-health matter. They are not manufactured as tenant configuration-change evidence. P0-5 does not alter M365 Management Activity subscriptions or polling.

Validation after repair: final focused frontend What Changed tests 7/7; backend What Changed tests 45/45; root and backend TypeScript; Prisma validation with a placeholder non-production `DATABASE_URL`; and `git diff --check` all pass. Both full production builds passed during the implementation repair; no build configuration changed.

Deployment note: `OrganizationConfigurationSnapshot` migration must precede matching backend deployments. It was included in the P0-5 deployment; future environment rebuilds must preserve that ordering.

Cadence/cost: organization/domain/SKU configuration snapshots are lightweight Graph collection suitable for the existing daily authoritative inventory plus exact-audit-triggered reconciliation. They must not introduce mailbox- or per-user-scale polling. Exchange organization/audit setting collection is deferred until its read API/RBAC behavior is verified. Remaining gaps include direct Exchange configuration evidence, SharePoint/OneDrive and Teams administrative settings outside the existing catalog, external DNS changes, and any unsupported Microsoft audit workload.

## Active milestone — P0-6 onboarding and collection readiness

Status: final independent QA PASS (`P0=0`, `P1=0`); the local work in `codex/p0-6-onboarding-readiness` is safe to publish but remains uncommitted, unpublished, undeployed, and unapplied to any live tenant.

- Adds a read-only, versioned collection-readiness contract derived exclusively from durable per-resource sync states, verified consent records, and the four existing Management Activity subscription rows. It makes no Microsoft request while listing a tenant and never equates OAuth verification or a successful cron process with workload readiness.
- Readiness rows cover Entra directory audit, sign-ins, Graph configuration snapshots, SharePoint/OneDrive, Exchange mailbox/configuration, and Microsoft 365 Unified Audit. States distinguish READY, INITIALIZING, PARTIAL, BLOCKED_PERMISSION, BLOCKED_TENANT_CONFIGURATION, UNSUPPORTED, STALE, BACKLOGGED, FAILED_TRANSIENT, and NEVER_SUCCEEDED.
- Management Activity exposes `Audit.Exchange`, `Audit.AzureActiveDirectory`, `Audit.SharePoint`, and `Audit.General` independently. Provisioning is not presented as a permanent failure; a bounded backlog is distinct from a completed collector. Existing normal scheduler checks continue after Microsoft/admin remediation.
- Exchange Graph permission readiness and Exchange Admin API RBAC are shown separately. A successful Admin API collection can confirm RBAC, a recognized RBAC/Recipient Management failure is blocked, and all other cases remain explicitly unverified; an unverified promised Exchange Admin capability prevents Exchange from reporting READY. No new Exchange command, RBAC role, consent, or PowerShell execution was added.
- Minimal tenant Settings UI renders the safe normalized matrix with state, permission/capability status, last attempt/success, current sanitized reason, remediation, M365 components, and Exchange RBAC. It adds no retry action and operational health remains outside What Changed.

Cost/cadence: readiness is derived from data already persisted during onboarding, relevant sync outcomes, reconnect/permission failures, and the existing bounded scheduler cadence (15-minute M365 catch-up and daily inventory). It adds no per-user, per-mailbox, or per-site readiness probe and is suitable for a 1,000-tenant scheduler design with existing jitter/backoff.

Final QA validation: independent verification passed frontend readiness tests (6/6), backend readiness tests (15/15), adjacent backend tests (107/107), root and backend TypeScript, Prisma validation, both production builds, and diff/scope checks. The matrix includes the current Secure Score, devices, directory-role, authentication-method policy, named-location, Security Defaults, Exchange usage/accepted-domain/admin-RBAC, and tenant configuration collectors with their actual required grants, including `SecurityEvents.Read.All` and `Member.Read.Hidden`. Licensing failures are distinct from tenant configuration; an absent permission-verification record is UNVERIFIED rather than missing; revoked/failed connection evidence overrides historical readiness without deleting prior-success timestamps; invalid/future Exchange Admin timestamps cannot confirm RBAC; and Graph mailbox permission blockers survive Exchange RBAC aggregation. Unknown, oversized, duplicate, and malformed client readiness data becomes visibly unsupported rather than silently disappearing, and a worst nested component deterministically drives its parent/global readiness diagnostics. Management Activity verification time is displayed separately from first successful polling. A scheduler heartbeat is no longer presented as a per-resource retry promise.

Known limits: the current contract cannot prove a permission grant when no verification record exists; it says UNVERIFIED/MISSING rather than guessing. `Exchange.ManageAsAppV2` and Exchange RBAC are not represented as Graph consent and require a successful existing Admin API collection to confirm. The existing Management Activity collector remains subject to Microsoft provisioning/latency and does not guarantee every admin event. Nonblocking P2 follow-up: harden the legacy retry-time contract, version the permission manifest, and use stricter date parsing.
