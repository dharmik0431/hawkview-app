# Risky Users operational acceptance and support runbook

Status: **release target; implementation and production acceptance pending**

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
- Only resolved directory subjects form user/mailbox rows. Display labels never
  merge subjects; evidence references are opaque and tenant-scoped.
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

## Support triage

1. Confirm the MSP session and organization/tenant scope before reading details.
2. Record the rule ID/version, channel, readiness state, source, evidence window,
   collection/evaluation times, and safe correlation.
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
