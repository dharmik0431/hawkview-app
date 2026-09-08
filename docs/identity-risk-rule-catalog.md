# Risky Users rule catalog

Status: **target contract; implementation and deployment not yet verified**

Owner: HawkView engineering and product documentation

Update this document when a rule version, threshold, evidence requirement,
reason code, priority, or source adapter changes. The delivery lead has frozen
the public schema as `hawkview-risk-assessment/v1`; implementation and deployment
remain pending. The closed rule tuples are:

| Rule | Version | Priority | Permitted source |
| --- | --- | --- | --- |
| `HV-ID-AUTH-010.v1` | `v1` | Low | Microsoft 365 audit STS or Graph sign-ins |
| `HV-ID-AUTH-005.v2` | `v2` | Medium | Microsoft 365 audit STS or Graph sign-ins |
| `HV-ID-MBX-001.v1` | `v1` | High | Mailbox rules |

Aggregation and protection do not change those priorities. The v1 response has
only Low, Medium, and High priorities; it does not define Critical.

## Product boundary

HawkView Risky Users produces explainable investigation leads from supported
Microsoft audit, sign-in, and mailbox evidence. It does not estimate a
probability of compromise, reproduce Microsoft's proprietary detection models,
or change a Microsoft account or policy.

Microsoft Entra Risky Users is a separate channel. Microsoft severity and state
do not raise, lower, clear, or replace a HawkView finding.

Priority, evidence confidence, and verified protection are separate fields. A
protection control can reduce concern or guide the next step, but it does not
erase observed activity.

## Target rules

### `HV-ID-AUTH-010.v1` — repeated invalid credentials

Target priority: **Low**

Match only when at least 10 distinct qualified invalid-credential failures occur
within a rolling 15-minute window for the same organization, customer tenant,
resolved human user, and application.

Qualification and bounds:

- Count distinct source events after deduplication. Nine events do not match.
- A source IP address is not required.
- Exclude MFA-required or interrupted prompts, expired tokens, infrastructure
  failures, unknown outcomes, retries, and duplicate deliveries.
- Do not attach unresolved usernames, service/application events, or ambiguous
  identities to a person.
- Reject malformed, inconsistent, unsupported, or future-dated records.
- A generic successful audit result alone does not prove authentication success.

Target explanation:

> 10 invalid-credential attempts were recorded for this account in 15 minutes.
> This may reflect mistyped or outdated credentials or attempted unauthorized
> access; no successful access is established by this finding.

False-positive limits: stale saved passwords, typing mistakes, repeated client
retries, and expected application behavior may cause failures. The finding must
not claim one attacker, one origin, password spraying, compromise, or successful
access. Ask the MSP to validate the application and timing before escalating.

### `HV-ID-AUTH-005.v2` — invalid credentials followed by verified success

Target priority: **Medium**

Match only when at least five distinct qualified invalid-credential failures
occur during the 10 minutes before a verified successful sign-in, and the final
failure is no more than two minutes before that success.

All counted events must have the same organization, customer tenant, resolved
human user, application, and qualified client-source address. Four failures do
not match. A missing, ambiguous, or proxy-only source does not qualify for this
rule; `HV-ID-AUTH-010.v1` can still be evaluated independently.

The explanation must state the failure count, time window, verified success,
selected source, and uncertainty. It must not claim the same person or attacker
performed every event. Event-specific proof that MFA succeeded is a mitigating
fact. Current MFA policy or registration is not proof that the historical event
used MFA.

False-positive limits include a user correcting an old password, expected token
refresh behavior, and shared or proxy egress. Deduplication, exact identity/app/
source binding, verified-success semantics, and the two-minute edge are required
before this rule can match.

### `HV-ID-MBX-001.v1` — external mailbox forwarding

Priority: **High**, preserving the existing published severity. This is not a
new escalation and remains an investigation lead, not a compromise verdict.

The existing rule identifies an enabled mailbox rule that forwards or redirects
messages to a domain outside the Microsoft Graph verified-domain set collected
for that tenant. It requires qualified, current mailbox-rule and domain evidence.

This is an investigation lead. It does not prove delivery, exfiltration, or
account compromise. Approved partner forwarding can be legitimate. If mailbox
evidence is unavailable, this rule is unavailable; the two authentication rules
continue when their own evidence is usable.

## User roll-up

- Show the highest current priority as the summary and retain every independent
  reason.
- Never add points for duplicate events or repeated versions of one incident.
- `HV-ID-AUTH-010.v1` and `HV-ID-AUTH-005.v2` can describe the same sequence;
  their combination does not create a High result.
- Group repeated detections of one incident and show first seen, last seen, and
  evidence count.
- When a rolling window ends, retain the item as history with its last-seen time.
  Do not label it remediated merely because time passed.
- A source outage makes coverage unknown or stale. It never resolves a finding.

## Source and licensing capability

| Source | HawkView use | Requirement and limitation | When unavailable |
| --- | --- | --- | --- |
| Microsoft 365 Unified Audit / Management Activity, including qualified STS logon records | Target non-P2 authentication route for `HV-ID-AUTH-010.v1` and `HV-ID-AUTH-005.v2` | Appropriate Microsoft 365 audit entitlement, existing consent, enabled collection, and valid event fields. Audit is not a complete substitute for Graph sign-ins. | Only affected authentication evaluations are unavailable or partial. Do not diagnose licensing from a missing permission alone. |
| Microsoft Graph sign-in logs | Authentication rules for appropriately licensed and authorized tenants | Graph sign-in download requires Entra ID P1 or P2 and suitable permission. | Authentication rules can use another independently qualified source; otherwise they are unavailable. |
| Qualified mailbox-rule evidence and Graph verified domains | `HV-ID-MBX-001.v1` | Requires current, bounded, authoritative evidence. The verified-domain set is not the complete Exchange transport-domain inventory. | Mailbox rule is unavailable; authentication rules continue. |
| Microsoft Graph `riskyUsers` | Separate Microsoft channel only | Requires Entra ID P2 and appropriate read permission. | Show Microsoft channel unavailable. HawkView rules continue. |

For one tenant/user/window, select one qualified authentication source and retain
its attribution. Do not count duplicate audit and Graph representations twice or
increase severity because two feeds describe the same activity.

The response-level coverage and freshness summary is conservative. It is full
and current only when every selected rule source and its rule evidence are ready
and current. An unused alternative feed adds no coverage. Any required missing
or stale source prevents a complete/current claim.

## Frozen readiness and action vocabulary

Source and rule readiness values are `READY`, `PARTIAL`, `WAITING`,
`MISSING_PERMISSION`, `LICENSE_REQUIRED`, `STALE`, `FAILED`,
`INSUFFICIENT_FIELDS`, `UNSUPPORTED`, and `DISABLED`. `INSUFFICIENT_FIELDS`
means records exist but cannot safely qualify the rule. In particular,
`HV-ID-AUTH-005.v2` requires a qualified client source;
`HV-ID-AUTH-010.v1` does not require an IP address.

The frozen recommended-action codes are `CONFIRM_EXPECTED_ACTIVITY`,
`REVIEW_SIGN_INS`, `CHECK_SAVED_CREDENTIALS`, `VERIFY_MFA_ENFORCEMENT`,
`REVIEW_MAILBOX_FORWARDING`, and `FOLLOW_INCIDENT_PROCEDURE`. The UI presents
plain-language text with these codes; HawkView does not execute the action.

## Evidence and protection interpretation

“No findings” means no rule matched within the explicitly named evaluated scope
and time window. It does not mean the account is safe. Missing, partial, stale,
malformed, capped, unsupported, or licensing-restricted evidence is not evaluated
or unavailable—never zero.

Protection labels must come from the existing effective-MFA evaluator:

- verified enforced Conditional Access can name the applicable policy;
- conditional coverage must name relevant conditions or exclusions;
- verified Security Defaults or authoritative per-user MFA state can be shown;
- registration alone is not enforcement;
- report-only/disabled policies and unresolved assignments are not coverage;
- event-specific “blocked by policy” or “MFA satisfied” requires event evidence;
- missing or stale evidence is **Protection not verified**.

Conditional Access evidence includes its source, freshness, observation and
evaluation times, and reason codes. Security Defaults, legacy per-user MFA, and
registration each carry their own state, source, observation time, freshness,
and reason code. Unknown, stale, failed, missing-permission, or incomplete
evidence must remain explicit; one protection source cannot fill another's gap.

Only an authorized, resolved directory subject can form a user or mailbox row.
Do not merge rows by display label, guess a human from an unresolved identifier,
or expose a raw provider identifier. Evidence references remain opaque and
tenant-scoped.

Each finding has structured context. Application state is `RESOLVED` or
`NOT_REPORTED`; a label is allowed only after an authorized resolved lookup, and
the derived persisted document stores the opaque application ID with a null
label. Device state is `NOT_REPORTED` or `INSUFFICIENT_FIELDS` and its label is
always null in this release. Client source is an opaque reference with
`QUALIFIED`, `NOT_REPORTED`, or `INSUFFICIENT_FIELDS`. Never copy a raw IP,
unverified device name, or provider description into the finding.

Persisted derived findings keep opaque scoped references and bounded evidence,
not private display labels or a copied protection snapshot. Authorized directory
labels and current protection context are resolved conservatively at read time.
Failure, staleness, or ambiguity during that lookup stays unknown or not reported;
it must not change the persisted rule result or priority.

The existing 90-day derived-risk retention remains unchanged. Replaying or
reading an old incident does not renew its retention age or make it current.

## Final reconciliation gate

Before release, verify every field, reason, priority, explanation, action,
source state, and edge
against integrated code and independent tests. Record separately whether each
rule is implemented, staged, deployed, and verified on usable evidence.
