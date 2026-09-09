# Risky Users operational acceptance and support runbook

Status: **merged and publicly routed; real-tenant source acceptance pending**

Audience: release engineers, support, security reviewers, and on-call operators

This runbook contains procedures and acceptance gates, not current production
configuration or private operational attestations. Keep customer records,
credentials, keys, raw audit events, user names, addresses, and internal provider
details out of repository documentation and handoffs.

## Release states

Record these independently for an exact revision:

1. source reviewed;
2. integrated;
3. required CI passed;
4. deployed;
5. backend routes and scheduled evaluation verified;
6. frontend published; and
7. user verified.

Never summarize incomplete evidence as “live.” A health endpoint alone does not
verify an authenticated risk route or usable source evaluation.

## Sanitized release record

Keep the four evidence layers separate:

| Layer | Established evidence | Remaining limit |
| --- | --- | --- |
| Source and tests | Reviewed PR #236 head `39eb90965c61e6edfcb4f6d29d2f5872099163c3` is an ancestor of protected merge `8e3a94c01b68175c92ce4f4fdd379c20c2aa8455`. Required-quality run [34298951213](https://github.com/dharmik0431/hawkview-app/actions/runs/34298951213) passed for the reviewed head. | Automated and isolated evidence does not prove usable evidence in a real tenant. |
| Infrastructure deployment | API and scheduler were verified at the merge revision; both audit-risk migrations were applied, and the natural scheduled run succeeded. API smoke [34300213203](https://github.com/dharmik0431/hawkview-app/actions/runs/34300213203) and authenticated two-MSP canary [34300213250](https://github.com/dharmik0431/hawkview-app/actions/runs/34300213250) passed for the merge. | Infrastructure success does not establish per-rule source readiness or a tenant finding. |
| Public route and UI | After an owner publication correction, independent public QA confirmed that the active public bundle references `GET /api/tenants/:tenantId/identity-signals/assessment` and implements the new **HawkView Risky Users** card. | This is not an authenticated tenant API call. The exact clean frontend source SHA is not proven. Do not use a shared static literal or chunk filename/hash as substitute evidence. |
| Real tenant acceptance | **Unverified.** | No independent privacy-authorized non-P2 tenant inspection has established audit-source usability, rule readiness, findings, or full tenant coverage. |

Rule delivery status:

| Rule | Source status | Real-tenant status |
| --- | --- | --- |
| `HV-ID-AUTH-010.v1` — repeated invalid credentials, Low | Implemented and tested with qualified synthetic/isolated audit and sign-in evidence. | Unverified on independent real-tenant evidence. |
| `HV-ID-AUTH-005.v2` — failures followed by verified success, Medium | Implemented and tested with its exact application/client-source qualification. | Unverified on independent real-tenant evidence. |
| `HV-ID-MBX-001.v1` — external forwarding, retained High | Existing rule integrated and tested with pinned mailbox evidence. | Current independent real-tenant readiness/finding status unverified. |

The original September 8 target acceptance time was missed. The feature is not a
full Microsoft-equivalent risk product and does not have universal telemetry.
Independent source QA found the type-declaration move semantically equivalent and
build-neutral under the unchanged recursive TypeScript configuration. The full
hosted `bun.lock` was captured. Among the compared direct dependencies, Supabase
is the differing dependency. QA and the delivery lead confirmed the operative
public evidence chain: the active tenant route loads startup chunk
`8369-11283d63063e2047.js` and new assessment chunk `453`, and chunk `8369`
constructs the Supabase client marker at 2.116.0, including its realtime/storage
family. The canonical reviewed production route instead loads
`1421-45e195a2ff83baab.js` with 2.112.0, matching the reviewed npm lock and CI
production artifact.
This is confirmed runtime dependency drift and a P1 release-provenance issue,
not merely an unused alternative-lock difference. No vulnerability or
authentication regression has been demonstrated. A minimal exact-version and
both-lock correction is pending Lead and QA review. Until that correction is
merged and deployed, overall acceptance and a clean exact frontend SHA remain
unproven. Do not perform a blind or routine republish. The reviewed dependency
correction requires controlled publication followed by a public version check.

## Required acceptance matrix

- A non-P2 synthetic fixture with qualified audit STS events produces
  `HV-ID-AUTH-010.v1` and `HV-ID-AUTH-005.v2`
  without calling Graph sign-ins or `riskyUsers`.
- A real existing non-P2 audit path is demonstrated before non-P2 production
  coverage is called verified.
- Qualified Graph sign-ins produce equivalent rule behavior without duplicate
  inflation when audit evidence also exists.
- Microsoft `riskyUsers` remains separate and cannot alter HawkView priority.
- Threshold and edge tests cover 9/10, 4/5, rolling-window boundaries, the final
  failure two-minute boundary, mismatched identity/app/source, reversed order,
  unsupported failures, and inconsistent success/error fields.
- Duplicate, conflicting, late, future, malformed, app-only, and unresolved-user
  events cannot inflate counts or bind to a human by guesswork.
- Mailbox/user roll-up requires fresh scoped `EXCHANGE_MAILBOX_SETTINGS`, an
  exact mailbox-user-directory GUID binding, and exactly one matching
  `userPurpose='user'` record. A GUID alone is insufficient. Shared, room,
  equipment, missing, stale, failed, duplicate, or ambiguous-purpose cases stay
  `MAILBOX`; independent findings remain visible. UPNs, names, and labels never
  merge subjects, and evidence references stay opaque.
- Finding context enforces structured application, device, and client-source
  states. Persisted application labels are null pending authorized resolution;
  device labels are always null; client sources are opaque references. Raw IPs,
  unverified device names, and provider descriptions never enter the finding.
- Missing mailbox evidence does not block authentication rules; missing auth
  evidence does not erase a mailbox finding.
- Protection states cover enforced, conditional, report-only, excluded, stale,
  ambiguous assignment, alternative grants, registration-only, and missing
  event-MFA evidence.
- Conditional Access, Security Defaults, legacy per-user MFA, and registration
  retain separate source, observation, freshness, and reason evidence. One source
  cannot silently fill another's gap.
- Findings, evaluated-empty, partial, stale, and unavailable are visibly distinct.
- Reprocessing is idempotent and historical findings do not become fresh alerts.
- Two synthetic MSP organizations cannot read each other's findings, reasons,
  protection references, or exports.
- Database integration, production builds, bounded load/concurrency, and safe GET
  routes pass. No GET request performs heavy evaluation.
- Logs and handoffs contain no customer events, identities, addresses, tokens,
  content, or keys. No Microsoft write or unrelated retention/key change occurs.
- Response metadata is full/current only when every selected rule source and its
  rule evidence are ready/current. Unselected alternatives add no coverage.

## Source readiness checks

For each source and rule, verify the selected adapter, safe reason code, evidence
window, last successful collection, last evaluation, and freshness. Confirm:

- audit STS outcomes require qualified operation and authentication-error fields;
  generic success alone is insufficient;
- Graph sign-in licensing and permission are reported separately;
- mailbox-rule failure affects only the mailbox rule;
- Microsoft-risk licensing/permission affects only the Microsoft channel;
- duplicate audit/Graph representations do not raise severity; and
- malformed, ambiguous, capped, or future records fail closed.

Evaluate after successful relevant ingestion and through a bounded scheduled
catch-up. Do not trigger an all-tenant backfill, perform heavy evaluation in GET,
or create synthetic positive events in customer accounts.

## Database and read-path gate

The release requires two additive database migrations before the new backend
revision starts. Migration 44 adds the required unknown lifecycle state.
Migration 45 adds only the exact `HV-ID-AUTH-005.v2` rule/version tuple and makes
the confidence check permit Low, Medium, and High to match the existing evaluator
and DTO contract. It does not rewrite an existing rule's priority or confidence.
Do not loosen checks to accept arbitrary rule versions. The resulting expected
total is 45 migrations for this frozen backend.

Apply and verify the migration through the ordinary protected release path before
starting the dependent backend. A migration file in source is not evidence that
the database is ready.

The assessment GET route performs a bounded read of persisted derived results.
It must not parse or evaluate raw sign-in/audit events, scan history without a
bound, provision customer data, create risk rows, or write customer state.
Authorized private labels and current protection context are resolved at read
time with organization/tenant scope; lookup failure stays unknown or not
reported. The persisted document retains opaque scoped references. Existing
managed key pin/reference handling may record bounded operational key-audit
events; that is not source-rule evaluation or a customer-state mutation. Reading
or replaying an incident does not renew the existing 90-day derived-risk
retention age.

The retention reliability repair keeps the fixed 1,000 ms absolute monotonic
ceiling, or a shorter caller deadline. Only the retention allocation may lend
unused SQL time to connection acquisition within that same ceiling. It does not
change pool size, retries, or any global timeout.

For the mailbox rule, the bounded GET validates the exact two mailbox source
snapshot/attestation generation pins recorded by the assessment. Missing or
changed proof yields unknown current mailbox state while authentication rules
remain independent. For authentication rules, verify that the evaluated lookback
is a bounded subset of the retained captured source window. Normal collection
delay must not be labeled as capacity exhaustion.

## Support triage

1. Confirm the MSP session and organization/tenant scope before reading details.
2. Record the rule ID/version, channel, readiness state, source, evidence window,
   collection/evaluation times, and safe correlation.
   Treat absent application/device/client fields as **Not reported** or
   **Insufficient fields** exactly as returned; do not enrich them from logs.
3. Determine whether the issue is collection, permission, licensing, unsupported
   fields, staleness, evaluation, authorization, or frontend presentation.
4. Confirm the other channel and unrelated rules remain independent.
5. Reproduce with deterministic synthetic fixtures or isolated staging data.
6. Escalate with aggregate status and safe reason codes only.

Never use a public Swagger, debug, admin, or database route as a customer support
surface. Never bypass cross-MSP authorization or manually relink evidence.

## Release verification

Before merge, require independent Backend, Frontend, Test, and documentation
review of the exact integrated head. Required protected checks must pass without
bypass. After ordinary deployment:

- confirm the exact backend revision and current database schema;
- run bounded health, fresh smoke, authenticated two-MSP isolation, and exact
  risk-route checks;
- verify the actual authenticated assessment endpoint and the new assessment
  component; shared static literals, generic page HTML, or a chunk hash alone are
  insufficient;
- verify a natural or explicitly authorized bounded evaluation path;
- verify findings, evaluated-empty, and unavailable behavior using isolated test
  or staging data;
- confirm rollback readiness; and
- publish the frontend separately only from the reviewed frontend revision.

If frontend publication requires an owner-managed step, request it once after the
final frontend commit is ready. Provide the exact commit and a short checklist.

## Rollback and stop conditions

Use the documented backend hard stop and an explicit frontend hide independently.
Preserve existing data and key material. Do not add deletion, backfill, or
Microsoft mutation as a rollback shortcut.

Stop release and report evidence immediately for:

- cross-MSP exposure or ambiguous tenant binding;
- false “safe,” “zero,” “protected,” or “remediated” presentation;
- unbounded memory, concurrency, history scan, or request-time evaluation;
- duplicate inflation or unsupported STS outcome interpretation;
- required CI, database, build, or authorization failure;
- missing usable non-P2 audit route when that release requirement is claimed;
- secret/customer content in logs or handoffs; or
- a needed permission, license, consent, or owner-managed publication step that
  has not been authorized.

## Release handoff

Report the shipped revision, status of all three rules, verified source categories,
isolated positive/negative results, cross-MSP outcome, remaining limitations,
documentation links, and any exact owner action. Clearly label target, staged,
deployed, backend-verified, frontend-published, and user-verified states.
