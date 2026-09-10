# Risky Users — normalization and classification

The seam between collection/storage and the Risky Users evaluation core.

**In:** raw `sign_in_logs` rows plus `directory_users` rows for one tenant, and one
selected feed.
**Out:** normalized events, each classified into exactly one of three buckets, plus
independent tallies and a coverage statement.

```ts
const batch = await normalizeSignInBatch({ scope, source, rows, directory, reference });
for (const event of batch.applies) { /* HawkView's own detectors act on these */ }
for (const event of batch.microsoftRiskVerdicts) { /* Microsoft's channel, never merged */ }
```

Collection and storage are unchanged. This module replaces the classification half of
`identity-risk/authentication-source-readiness.ts` and `risky-users-auth/normalize.ts`.

## The three buckets

| Bucket | Meaning | Stated coverage | Evaluation |
| --- | --- | --- | --- |
| `APPLIES` | A credential event the detectors act on. Carries `outcome`. | Recognized | Evaluated |
| `DOES_NOT_APPLY` | Out of scope **on a documented citation**. Carries a `reason`, counted by reason. | Recognized | Not evaluated |
| `UNKNOWN` | We cannot interpret it, or cannot defend excluding it. Counted by observation. | Reduces coverage | Not evaluated |

A fourth outcome is possible per *row* rather than per event: a row that could not be
read is `unprocessableByReason`, which is **never** summed with `doesNotApplyByReason`.
A malformed row and an expected keep-me-signed-in interrupt are different claims about
what the result is worth.

`outcome` lives only inside `APPLIES`, so reading a credential verdict off an
out-of-scope or unrecognized event is a type error rather than a convention.

## What UNKNOWN does not do

It does not block. There is no readiness flag, no `gapCount`, and no `PARTIAL` state in
`NormalizationBatch` — nothing the evaluation core can branch on to skip a rule. The
predecessor derived `partial = gaps > 0` from one counter incremented by seven unrelated
conditions and reported `INCOMPLETE_WINDOW`, so a single unrecognized event vetoed a
whole rule. Ordinary traffic is full of events we do not recognize, so detection never
ran: 1,054 completed evaluation runs, zero findings.

`recognizedRows / consideredRows` is the honest stated coverage, and a zero finding count
is only honest reported against that scope.

## Outcomes: the three-state vocabulary was not enough

The predecessor could say invalid, success, or neither. It could not say **"the password
was accepted and the sign-in did not complete"**, which is the basis of the highest-value
detector available without Entra ID P2. Microsoft states the inference itself: the
password is correct but strong authentication is required, which can indicate the
password is compromised and the actor cannot fulfil MFA. Microsoft's own password-spray
code set notably *excludes* 50126 — the failure storm identifies the attack, the
post-password interrupts identify the victims whose passwords are now known.

```
PASSWORD_REJECTED                          50126
PASSWORD_ACCEPTED_COMPLETED                0
PASSWORD_ACCEPTED_CHALLENGE_ISSUED         50076
PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED     50074, 500121
PASSWORD_ACCEPTED_REGISTRATION_REQUIRED    50072, 50079
BLOCKED_BY_CONTROL                         53003, 530032, 53000, 53001, 50097, 53004, 50131
LOCKED_OUT_AFTER_REPEATED_FAILURES         50053 (smart-lockout text)
DISABLED_ACCOUNT_ATTEMPT                   50057
```

The interrupt family is split three ways rather than collapsed, because 50076 (challenge
issued) and 50074 (challenge **not** passed) are one digit apart and mean different
things. Detectors wanting the whole family should call `isPostPasswordInterrupt` or
`passwordWasAccepted` rather than re-encode result codes of their own.

## No default arm

Every technician-facing label comes from an exhaustive `Record<Reason, string>` in
[`reasons.ts`](./reasons.ts). A reason without a label does not compile. The predecessor
fell back to a label meaning "incomplete collection window", which sent technicians to
chase a collection failure that did not exist; a test asserts that no out-of-scope or
unknown label mentions collection, staleness, windows, retries or permissions at all.
Only the unprocessable vocabulary may point at data quality, because only it is about
data quality.

`dispositionForCode` returning `UNKNOWN` for an unlisted code is not that default arm.

## Two rules, closing two different holes

**Rule 1 — an unverified payload-shape predicate has no effect on classification.** It
is observed and counted, never acted on. Not "routed to UNKNOWN" either: an event moved
to UNKNOWN is just as absent from evaluation as one moved out of scope, so that is the
same failure in a politer wrapper.

**Rule 2 — a result code may be mapped `DOES_NOT_APPLY` only with a positive documented
citation for why it can never be credential-attack evidence.** Rule 1 does not reach
this case, because a wrong exclusion is a *confident* classification and walks straight
past a guard that checks whether a predicate was validated. The predecessor confidently
classified 50076 as "not a credential event". **Absence of a reason to include is not a
reason to exclude.** Exactly two codes clear the standard today — 50140 and 50058, both
of which Microsoft explicitly calls expected parts of normal flow — and a test asserts
that no third one appears without a citation.

Codes we recognize but cannot defend excluding land in
`UNKNOWN / RECOGNIZED_BUT_EXCLUSION_UNCITED`: 50055, 50144, 50056, 50133, 50173, 65001.
That costs coverage, blocks nothing, and is recoverable the moment a citation exists.

## Disproved predicates

Kept deliberately in [`provider-facts.ts`](./provider-facts.ts) as the record of claims
that were plausible, reviewed, and false. `mayExclude` throws if one is consulted, and
tests assert *behaviourally* that classification is unchanged by the fields they read.

| Predicate | Why it is dead |
| --- | --- |
| `raw.signInEventTypes` | Absent from every row. Matches nothing; would have shipped as a verified fix that changed nothing. |
| `raw.servicePrincipalId` | Non-empty on 100% of Graph rows **including ordinary human sign-ins**. Would have excluded all human traffic while reporting tenants clean. |
| `raw.isInteractive` | `true` on 100% of 2,635 rows. Inert — a predicate true on every row discriminates nothing. |
| `managementActivityRecord.ResultStatus` | On an STS logon event "Succeeded" means **HTTP** success, not logon success. Fails silently toward calling failures successes. |
| `sign_in_logs.user_id` (column) | GUID-shaped, matches no directory user on any row, and more granular than the real user (6 column GUIDs vs 2 real users across 950 rows). Synthesized, not an identity. |

## Subject binding

Two methods, and the one used is recorded on every event as `subjectBinding`.

- **Graph** binds on `raw.userId`, an exact directory object id.
- **Audit** binds on `managementActivityRecord.UserId`, an exact normalized UPN
  (case-insensitive, whitespace-trimmed, never fuzzy or partial).

GUID-only binding was the original design and would have been wrong: measured across the
three fallback-path tenants, audit rows resolve **96.8% / 97.1% / 77.8% by UPN against
15.2% / 0.0% / 0.0% by GUID**. Two of three tenants would have detected nothing, on a
feature whose premise is working without premium licensing.

The real hazard was never naming, it was **ambiguity** — two directory users normalizing
to one UPN. Both lookups therefore require **exactly one** non-deleted match; zero and
multiple are both unprocessable, with no "best match". A UPN can be reassigned after a
user is deleted, so a historical event can bind to the wrong person — that residual risk
is smaller than detecting nothing for two thirds of tenants, and `subjectBinding` makes
it visible to a technician rather than implying the two bindings are equivalent.

`userType` is not filtered: that would be an unverified exclusion predicate, and it would
report the user as missing from the directory, which reads as a collection fault.

Raw identifiers do not travel on events. Each event carries `subjectRef` and
`applicationRef` from the injected `ReferenceResolver`; the mapping is separate, as
`batch.resolvedSubjects`.

## 50053 and the Microsoft risk channel

50053 has **three** documented meanings, distinguishable only from the description text,
so the text is parsed — to a **closed set**, with anything unmatched *or* matching more
than one meaning routed to `UNKNOWN / AMBIGUOUS_FAILURE_REASON_TEXT`. A reworded or
localised string therefore costs stated coverage and cannot silently misclassify. The
hazard was never "parse text", it was "guess from text".

| Text | Disposition |
| --- | --- |
| smart lockout after repeated wrong passwords | `APPLIES / LOCKED_OUT_AFTER_REPEATED_FAILURES` |
| blocked from an IP with malicious activity | `APPLIES / BLOCKED_BY_CONTROL` |
| blocked by built-in protections, high confidence of risk | `DOES_NOT_APPLY / MICROSOFT_RISK_VERDICT` |

Smart lockout "tracks the last three bad password hashes to avoid incrementing the
lockout counter for the same password", so a lockout implies **varied** password
attempts — a misconfigured client replaying one stale credential will not lock out. That
removes the main false-positive objection to treating a lockout as attack evidence.

**The third meaning does not go into `applies`, and that is deliberate.** It is
Microsoft's own high-confidence risk verdict, and the owner's product rule is that
HawkView's findings and Microsoft-reported risk are two channels that are never merged
or summed. A verdict Microsoft reached is not a HawkView finding. It is also the only
Microsoft risk signal an unlicensed tenant will ever see, so it is surfaced as
`batch.microsoftRiskVerdicts` rather than lost to a counter.

## Bounds never cost the run

`MAX_ROWS_PER_RUN` and `MAX_DISTINCT_REFERENCES` cost the excess rows, each counted with
its own reason. The predecessor failed the whole evaluation with `CAPACITY_LIMIT`.

## Verification status

Confirmed against production, with the control cohort each check needed:

- `status.errorCode` is a JSON `number` on 100% of 2,635 Graph rows — zero string, null
  or absent, and zero rows missing `status`, so nothing can be misread as `0`. A numeric
  string is therefore **drift**, not a supported form: counted in `shapeObservations` and
  routed to UNKNOWN rather than coerced.
- On the **Graph** path, `errorCode 0` carries the literal `"Other."` on 100% of rows.
  The empty-description successes reported earlier are all **audit** rows — a different
  feed, verified separately and never mixed.
- Audit UPN resolution rates, above.

Not confirmed, and recorded as such:

- **`graph.subject-directory-object-id` has an empty control cohort.** Graph rows bind
  100% positively, but zero observed rows carry a well-formed GUID absent from the
  directory — guests, deleted users and cross-tenant sign-ins do not appear. The
  unprocessable path is covered by synthetic fixtures only, which is weaker, and its
  verification state is `CONTROL_COHORT_UNAVAILABLE` rather than verified.
- Only fourteen distinct Graph error codes exist in all history and only three appear in
  more than one tenant. The whole distribution is thin; the mapping table rests on
  Microsoft's documentation, not on our frequencies.

`shapeObservations` is emitted on every run so a shape confirmed once stays under
observation rather than being assumed forever.

## Open items

1. **Username enumeration is invisible.** 50034 and 51004 are enumeration evidence, but
   any row carrying them describes a subject that is not in the directory, so subject
   resolution discards it before classification. Recorded in
   `UNREACHABLE_BY_SUBJECT_RESOLUTION`. Detecting enumeration needs a path for
   unresolved subjects, which is a scope decision.
2. **Collection scope, not classification: we appear not to be collecting
   non-interactive sign-ins.** The Graph request in `tenant-sync.service.ts` filters on
   `createdDateTime` only and applies no `signInEventTypes` filter, so Graph returns its
   default set — interactive user sign-ins. That explains `isInteractive` being true on
   every row, and it means non-interactive traffic, which normally outnumbers
   interactive, is absent from evaluation entirely.
3. **`APPLICATION_ACTOR` reports zero.** No confirmed field distinguishes an application
   actor from a user missing from the directory, so app-only sign-ins land as
   unprocessable subject failures — visible, but understating coverage.
4. **65001 wants a citation either way.** It is one of only three codes seen in more than
   one tenant, so it is high-volume, and it currently sits in UNKNOWN.
5. **50131's "suspicious activity" text variant** may belong in the Microsoft-reported
   risk channel rather than as a control block. Not settled here.

## Tests

```bash
npm --prefix backend run test:risky-users-normalization
```

52 tests. Five bug classes were reintroduced as deliberate mutations and each confirmed
to fail exactly the intended tests, with the rest of the suite still passing: a
`servicePrincipalId` exclusion, 50076 mapped out of scope, Microsoft's risk verdict
routed into our own findings, the audit `ResultStatus` read as logon success, and
ambiguity resolved by best-match. A green suite that has not been mutation-checked is
not evidence.

---

## Addendum: what the code distribution changed

The observed Graph distribution (14 distinct codes in all history) reframes two things.

**Code 50053 is 1,477 of 2,635 rows — 56% of everything collected.** The
description-text match is therefore the highest-volume predicate in this layer, not an
edge case. Its literal fragments are rendered from Microsoft's documented phrasing, not
from our own rows, and are registered as `graph.failure-reason-fragments`
(`PENDING_DISTRIBUTION_CHECK`). If they do not match the two values production actually
carries, 56% of traffic lands in UNKNOWN — safe, but a large and avoidable coverage loss.
The two literal strings are the most valuable outstanding request.

**The lockout branch carries unique detection weight.** For 94.8% of lockout rows there
is no 50126 for the same user within ±15 minutes: Microsoft emits the lockout without the
individual attempts alongside it, so at the moment of lockout it is the only signal
present. A 50126-only detector eventually surfaces the affected users — 100% of them
appear in 50126 rows at some point — but misses the events, and misses them when they
happen. Caveat: one tenant, at most four users, one locale, six weeks, and 1,479 blocks
against four accounts is not obviously normal traffic.

**The risk-verdict branch has no production evidence at all.** Across all 1,479 rows of
50053 there are exactly two distinct description values, and it is neither. It stays in
the closed set — it is a documented Microsoft string and unmatched text is safe — but it
is exercised only by a synthetic fixture and is recorded `NO_PRODUCTION_EVIDENCE`. Its
practical value is also lower than it first appeared: the code has volume in one tenant,
and that tenant holds Entra ID P2 and can already see Microsoft's risk signal directly.
It is also the only branch here whose disposition removes an event from `applies`, so it
is held to a single distinctive fragment; `built-in protections` was dropped as too broad
to carry that consequence.

## Addendum: unknown is not one thing

A consumer that gates a clean claim on "anything unknown" would let eighteen rows of a
well-understood consent prompt withhold a tenant's claim indefinitely — the veto pattern
in a better label. So `UnknownObservation` is partitioned, exhaustively and with a test:

- `UNINTERPRETABLE_OBSERVATIONS` — we could not read the event. A real limit on what we
  can claim, and the number to gate on.
- `UNCITED_POLICY_OBSERVATIONS` — we read the event fine; only our own basis for
  excluding it is missing. Disclosed, never gating.

`coverageForEvaluation(batch)` returns the tallies in the shape the evaluation core
consumes, with `uninterpretedEvents` and `uncitedPolicyEvents` already split. One mapping
in one place, for the same reason the sort lives here.

`counts.unselectedRowsByReason` replaces the earlier bare number, so "we never looked"
can be told apart from "we looked and declined". One member, `ROW_FROM_OTHER_FEED`, and
that is the answer: nothing is excluded from the covered feed by a predicate.

## Addendum: four classifications, not three

`NOT_YET_CITED` was promoted from a reason code inside UNKNOWN to a sibling of it. The
three-bucket shape was the original contract; this is a deliberate change, made on the
PM's proposal, for the reason the rest of the module exists: UNKNOWN was carrying two
different facts, and "our vocabulary has a hole" and "our paperwork has a hole" warrant
different urgency. Folding them together is the same collapse we keep removing, one layer
down.

| Classification | Meaning | Coverage | Gates a claim? |
| --- | --- | --- | --- |
| `APPLIES` | A credential event, with an `outcome`. | Recognized | — |
| `DOES_NOT_APPLY` | Out of scope on a documented citation. | Recognized | No |
| `NOT_YET_CITED` | Understood; our basis for excluding it is missing. | Recognized | **No** |
| `UNKNOWN` | We cannot interpret it. | Reduces | Yes |

`NOT_YET_CITED` counts as *recognized* on purpose — those events were read correctly, and
what is absent is our own paperwork. `coverageForEvaluation()` reports
`notYetCitedEvents` beside `uninterpretedEvents` and deliberately excludes it from the
latter, so a handful of well-understood consent prompts cannot withhold a tenant's claim
indefinitely. The fix is a citation, not a weaker gate: 50055, 50144, 50056, 50133, 50173
and 65001 are all waiting on one, and a non-zero count here is unfinished homework rather
than a property of the design.

50158 stays in UNKNOWN, not here: no citation can resolve it, because the ambiguity is
Microsoft's own statement about the code.

## Addendum: whose control blocked it

The channel-separation rule needs a line, and the line is **who made the judgement**:

- A control the **tenant configured** — Conditional Access, device compliance, domain
  join — is ours to report. `APPLIES / BLOCKED_BY_CONTROL`.
- A judgement **Microsoft's own intelligence** made is Microsoft's channel.
  `DOES_NOT_APPLY / MICROSOFT_RISK_VERDICT`, surfaced as `batch.microsoftRiskVerdicts`.

That is why 53003 stays in `applies` while 50053's high-confidence-risk text and 50131's
suspicious-activity text do not. Smart lockout stays in `applies` too: it is a mechanical
consequence of counted failures, not an assertion that something is risky.

Text meanings are now declared **per code** (`ResultCodeEntry.textMeanings`) rather than
matched globally, so one code's phrasing can never be read as another code's meaning — a
50131 carrying lockout wording stays a control block.

**Flagged, not decided:** 53004 (`ProofUpBlockedDueToRisk`) is by its own name a
risk-driven block and probably belongs in the Microsoft channel. It is left as a control
block pending that call, because further variants are to be flagged rather than settled
here. So is 50053's malicious-IP variant, which is Microsoft's threat intelligence making
the call and is currently `APPLIES / BLOCKED_BY_CONTROL` — that one is 919 of greentech's
rows, so moving it is a large, visible change and not mine to make unilaterally.

## Addendum: the enumeration blind spot is now a number

`shapeObservations.enumerationCodesOnUnresolvedSubjects` counts rows that failed subject
resolution while carrying 50034 or 51004. Those codes describe a subject that is by
definition absent from the directory, so resolution discards the row before classification
and the code is lost. Detecting directory probing needs a tenant-level finding where this
whole model is user-scoped, which is a different detector shape and out of scope. The
counter exists so the gap is visible in coverage rather than living in a comment.
