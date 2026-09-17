# Alert preferences: scope and delivery guarantees

## Status

This document defines the approved Phase 1 behavior for the local
`codex/alert-preferences-controls` implementation. It is not evidence of deployment,
email activation, delivery, or completed validation. Before release, compare this
contract with the final implementation and record the exact tested commit.

Phase 1 repairs existing preferences and their availability reporting. It adds no
detector, Microsoft permission, database migration, sending-domain configuration,
or new delivery channel. Broader alert coverage and independent personal channel
choices for each alert type remain follow-on work.

## Two different scopes

| Scope | Who may change it | Meaning |
| --- | --- | --- |
| Workspace alert policy | Active `MSP_OWNER` in the selected active organization | Which supported alert types are Act now, Act today, or Record only |
| My delivery preferences | The authenticated active user, for their own selected active organization | Personal in-app visibility, existing category preferences, minimum severity, and email opt-in |

`MSP_ADMIN`, `MSP_TECHNICIAN`, and `MSP_VIEWER` must not change workspace policy.
An owner in one organization is not thereby an owner in another. The server checks
membership and role on every mutation; a hidden or disabled button is not an
authorization boundary. Disabled users and inactive memberships or organizations
do not gain access through previously loaded settings.

The workspace policy is at `/settings/alerts`. Personal preferences are at
`/profile/notifications` and also appear in the Notifications tab of
`/settings/team`. That tab still edits the current user's preferences, not a
workspace-wide delivery policy.

UI requests explicitly identify the selected organization. Legacy requests without
an organization may retain single-workspace compatibility. A mutation with
ambiguous organization scope must fail rather than choose the first membership.
Personal preferences must never accept a different target user from the client.

## Availability is not a finding, and a finding is not delivery

The server must distinguish:

1. A catalog entry exists.
2. An intake mapping exists and consults its policy.
3. A production producer is supported end to end for that type.
4. The organization has observed input.
5. A delivery channel is configured and this particular delivery is eligible.

None of these facts alone proves the next. In particular, an OPEN finding may be
old; it does not prove fresh coverage or an imminent alert. No findings does not
mean a proven producer is unsupported. A failed settings request is not evidence
that defaults are active.

Source audit at base `9973b7228d18629a1c098a2a9bbf13402a81e40a` found:

| Catalog type | Intake mapping | Phase 1 availability decision |
| --- | --- | --- |
| `security.suspected_credential_attack` | `REVIEW_ACTIVITY` | Supported producer paths established; policy may be configured for future eligible findings |
| `security.privileged_directory_change` | `REVIEW_ACCESS` | Mapping exists, but an active end-to-end privilege/MFA producer was not established by this audit; do not present as working coverage |
| `security.routine_directory_change` | None | Unavailable for new policy writes |
| `monitoring.tenant_disconnected` | None | Unavailable for new policy writes |
| `monitoring.collector_failing` | None | Unavailable for new policy writes |
| `monitoring.consent_expiring` | None | Unavailable for new policy writes |
| `monitoring.recovered` | None | Unavailable for new policy writes |

`HV-ID-AUTH-010.v1`, `HV-ID-AUTH-005.v2`, and native `HV-ID-AUTH-011.v1`
map to suspected credential activity. These rules have different conditions; they
are not interchangeable detections or proof of compromise. The collected mailbox
rule `HV-ID-MBX-001.v1` uses `REVIEW_MAILBOX_RULE`, which currently maps to no
typed alert. It must not be advertised as typed email coverage.

Legacy connection, synchronization, and directory-change notifications are
separate from this typed intake. Broad category preferences do not prove that
every advertised event has a dedicated detector. In particular, collecting an MFA
or directory-role change does not establish detection of MFA enforcement being
disabled or a successful active Global Administrator assignment.

Unsupported policy rows remain readable with an explanation, but not editable;
the server also rejects unsupported new writes. Existing stored settings are
preserved, not silently deleted or translated. Capability/read errors must show
unavailable/retry and prevent unsupported writes, not invent working controls.

### Additive read contract

The agreed version-1 capability contract separates `intakeWiring`
(`MAPPED`/`UNMAPPED`), `producerSupport` (`PROVEN`/`NOT_ESTABLISHED`), and
`observedInput` (`OPEN_FINDING_PRESENT`/`NO_OPEN_FINDING`). Per-row `editable`
and a safe reason explain whether policy can be changed. A proven producer does
not require an observed finding before its future policy may be configured.

The wrapper reports `canManagePolicy`, `policyWriterRole: MSP_OWNER`, supported
digest modes (`off` only), and channel availability. Email availability is
`DISABLED`, `CONTROLLED`, or `UNAVAILABLE`, not a delivery promise. Personal
responses retain their existing flat fields and organization context. Email
opt-in may be saved while sending is disabled; saving it does not activate email.
Ambiguous omitted organization scope is rejected on both reads and writes.

## Urgency is not notification severity

Workspace urgency uses `ACT_NOW`, `ACT_TODAY`, and `RECORD_ONLY`.
Notification severity and the personal minimum threshold use a separate ordered
vocabulary:

`info < low < medium < high < critical`

A recognized severity meets the minimum when its rank is greater than or equal
to the threshold. Equality is included. Both email eligibility checks must use
the same five-level ordering. `warning` and `error` are not substitute severity
levels: they are category values in other parts of the notification contract.
Unknown or null email severity/threshold values fail closed.

The typed pipeline currently projects Act now as `critical` and Act today as
`high`. This mapping does not turn urgency tiers into personal channel choices.
Record only retains evidence without creating a new active typed notification
or email job for that policy decision.

### Critical in-app exception

Critical in-app notifications remain visible even if the personal in-app switch,
category preferences, or minimum threshold would otherwise hide a notification.
The UI must state this exception explicitly. Phase 1 must not accidentally remove
it while consolidating severity filtering.

This exception is not permission to send email: email opt-out and all email
eligibility safeguards still apply. Personal in-app and email preferences are
distinct; disabling in-app visibility alone is not an email opt-out.

## Email opt-in is not sender activation

Saving email opt-in does not activate the sender, broaden its approved audience,
or guarantee inbox delivery. The current controlled sender separately validates
its configured scope, designated owner, active membership, verified address,
personal preferences, current disposition, suppression, and other release gates.
Those restrictions remain unchanged in Phase 1.

Eligibility is rechecked at the final send boundary, not only when a job is
created. Losing authorization, opting out, or being suppressed before that check
must veto delivery. Provider acceptance is not proof of inbox placement.
No activation or test email is part of this change.

Daily and weekly digests have no proven sender in this scope. Do not offer them
as working delivery modes. Preserve a previously stored `daily` or `weekly` value
and explain that it is unsupported/not sending; never silently convert it to
immediate delivery. Changing it requires the user's explicit choice.

## Defaults and compatibility

Existing personal defaults remain unchanged: category preferences and in-app
visibility enabled, minimum severity `info`, email disabled, digest mode `off`.
Absence of a workspace override continues to use the catalog's declared urgency;
Phase 1 does not seed or rewrite organization policy defaults.

Keep backward-compatible response fields where required, but do not infer
availability from the old `mapped` boolean. Render authoritative capability
information, and fail closed when it is missing or invalid. Unknown stored values
must not be displayed as a successfully applied preference.

## Collection and history

Delivery controls do not stop Microsoft collection, remove source evidence,
delete findings, or establish that an identity is safe. HawkView findings and
Microsoft-reported user risk remain separate evidence channels.

Changing Record only or re-enabling a delivery preference must not replay
historical/withheld incidents or create new send identities for old decisions.
Existing suppression, watermark, deduplication, and final-send checks remain in
force. A preference change is not a request to resend an incident.

In-app visibility is a read filter: re-enabling it may reveal retained historical
notifications. That is distinct from creating a new event or sending historical
email. Explain this distinction rather than promising that retained history
disappears when a preference is disabled.

## Required release evidence

- Test all 25 recognized severity/threshold pairs, including equal boundaries,
  through both real SQL email eligibility paths. Test null and unknown values;
  mocks alone cannot establish SQL behavior.
- Verify owner-only policy mutation, each non-owner role, foreign organization,
  inactive membership/organization, disabled user, and access revoked after GET.
- Verify same-user personal scope, explicit organization selection, legacy
  single-workspace compatibility, and ambiguous-mutation rejection.
- Test unavailable/malformed capability reads, unsupported writes, missing data,
  and both personal preference UI surfaces. None may claim working email/digests
  or silently apply healthy-looking defaults.
- Preserve the critical in-app exception, unchanged defaults and stored values,
  email opt-out/suppression/final-send veto, and collection while delivery is OFF.
- Verify Record only and re-enabling do not replay historical/withheld incidents;
  distinguish restored historical in-app visibility from new delivery.
- Run focused tests, full frontend/backend suites, database integration,
  typecheck, lint, production builds, canary contracts, and diff checks. Record
  skipped/unavailable gates explicitly. Independent QA reviews the exact commit.

Do not use production customer records, email content, credentials, or raw
provider payloads as test fixtures. Passing source tests is not live validation.

## Follow-on design: per-type personal channel choices

This section is a proposal only. Phase 1 has no corresponding new schema or API.

A future personal override would be scoped to user, organization, and supported
alert type, with separate `INHERIT`, `ON`, or `OFF` choices for in-app and email.
`INHERIT` preserves existing broad preferences. `ON` cannot override workspace
Record only, unsupported capability, sender restrictions, suppression, minimum
severity, verification, or authorization. `OFF` affects delivery, not collection.
The critical in-app exception remains unless separately approved for change.

One server-owned policy resolver should explain the effective choice and its
reason, enforce it at eligibility and final send, and preserve no-history replay.
Re-enabling must not retrospectively make previously ineligible queued incidents
sendable. Uncertain provider attempts must retain their original idempotency
handling, not acquire a new send identity through a preference change.

This requires a separate reviewed schema/API and compatibility plan. New MFA,
privilege, application, mailbox, or health detectors require their own evidence
and coverage review; adding a toggle cannot substitute for a producer.
