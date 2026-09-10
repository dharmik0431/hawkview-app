# Risky Users — normalization and classification

The seam between collection/storage and the Risky Users evaluation core.

**In:** raw `sign_in_logs` rows plus `directory_users` rows for one tenant, and one
selected feed.
**Out:** normalized events, each classified into exactly one of three buckets, plus
three independent tallies and a coverage statement.

```ts
const batch = await normalizeSignInBatch({ scope, source, rows, directory, reference });
for (const event of batch.applies) { /* detectors act on these */ }
```

Collection and storage are unchanged. This module replaces the classification half of
`identity-risk/authentication-source-readiness.ts` and `risky-users-auth/normalize.ts`.

## The three buckets

| Bucket | Meaning | Effect on stated coverage | Effect on evaluation |
| --- | --- | --- | --- |
| `APPLIES` | A credential success or failure the detectors act on. Carries `outcome`. | Counts as recognized | Evaluated |
| `DOES_NOT_APPLY` | Understood, and correctly out of scope. Carries a `reason`, counted by reason. | Counts as recognized | Not evaluated |
| `UNKNOWN` | We do not recognize it. Carries an `observation`, counted separately. | Reduces coverage | Not evaluated |

A fourth outcome is possible per *row* rather than per event: a row that could not be
read at all is `unprocessableByReason`, which is **never** summed with
`doesNotApplyByReason`. A malformed row and an MFA interrupt are different claims about
what the result is worth.

`outcome` lives only inside `APPLIES`, so reading a credential verdict off an
out-of-scope or unrecognized event is a type error rather than a convention. The
predecessor's single `AuthOutcome` union mixed `'SUCCESS'` with `'NON_QUALIFYING'` and
`'UNKNOWN'`, which is how "out of scope" and "unrecognized" became indistinguishable.

## What UNKNOWN does not do

It does not block. There is no readiness flag, no `gapCount`, and no `PARTIAL` state in
`NormalizationBatch` — nothing the evaluation core can branch on to skip a rule. The
predecessor derived `partial = gaps > 0` from a single counter incremented by seven
unrelated conditions and then reported `INCOMPLETE_WINDOW`, so one unrecognized event
vetoed an entire rule. Ordinary traffic is full of events we do not recognize, so the
detection never ran: 1,054 completed evaluation runs, zero findings.

If a reporting layer needs to say "we could not see everything", it reads `coverage` and
the reason maps. `recognizedRows / consideredRows` is the honest stated coverage, and a
zero finding count is only honest reported against that scope.

## No default arm

Every technician-facing label comes from an exhaustive `Record<Reason, string>` in
[`reasons.ts`](./reasons.ts). A reason without a label does not compile. The predecessor
fell back to a label meaning "incomplete collection window", which sent technicians to
chase a collection failure that did not exist; a test asserts that no out-of-scope or
unknown label mentions collection, staleness, windows or permissions at all. Only the
unprocessable vocabulary may point at data quality, because only it is about data
quality.

`dispositionForCode` returning `UNKNOWN` for an unlisted provider code is not that
default arm. An unrecognized provider code genuinely is one, and saying so is the whole
purpose of the third bucket.

## Predicates, evidence, and the control-cohort rule

[`provider-facts.ts`](./provider-facts.ts) separates two kinds of claim:

- **Result-code claims** read a documented Azure AD code and state what Microsoft
  documents it to mean. A code may be mapped `DOES_NOT_APPLY` only if its documented
  meaning contains no verdict about whether a credential was correct.
- **Payload-shape claims** assert that a field is present, absent, or carries a value
  across real traffic. These are empirical and worth nothing until checked against real
  rows **including a control cohort that must not match**.

**An unverified payload-shape predicate has no effect on classification.** It is
observed and counted, never acted on — and not "routed to UNKNOWN" either, because an
event moved to UNKNOWN is just as absent from evaluation as one moved out of scope.

Two predicates are recorded as `DISPROVED` and kept deliberately, as the record of
claims that were plausible, reviewed, and false about what they meant:

- `raw.signInEventTypes` is absent from every row in the dataset, so a predicate on it
  matches nothing. It would have shipped as a verified fix that changed nothing.
- `raw.servicePrincipalId` is non-empty on 100% of Graph rows **including ordinary human
  sign-ins**, and `servicePrincipalName` is always empty. Neither discriminates
  anything. That predicate passed review and synthetic tests and would have excluded
  every human sign-in while reporting tenants clean.

`mayExclude` throws if a disproved predicate is ever consulted, and `normalize.test.ts`
asserts *behaviourally* that classification is unchanged by the fields they read, with
the human sign-in itself as the control cohort. Both tests were confirmed to fail when
the corresponding bug is reintroduced.

## Subject binding

Exact match on `directory_users.microsoft_user_id`, case-insensitive, and nothing else.
There is no UPN or mail index here: a UPN is renameable and reassignable, so binding a
sign-in to a person by name can attribute one user's activity to another. `userType` is
not filtered either — that would be an unverified exclusion predicate, and it would
report the user as missing from the directory, which reads as a collection fault.

Raw identifiers do not travel on events. Each event carries `subjectRef` and
`applicationRef` from the injected `ReferenceResolver`; the id mapping is available
separately as `batch.resolvedSubjects`.

**Consequence, raised with the PM:** audit-STS rows carry only a UPN in `UserId`, so
under GUID-only binding every `M365_AUDIT_STS` row is unprocessable
(`SUBJECT_NOT_RESOLVABLE_WITHOUT_GUID`) and that fallback feed produces zero events —
visibly, in the coverage statement, rather than quietly matched by name.

## Bounds never cost the run

`MAX_ROWS_PER_RUN` and `MAX_DISTINCT_REFERENCES` cost the excess rows, each counted with
its own reason. The predecessor failed the entire evaluation with `CAPACITY_LIMIT`.

## Open decisions

1. **Result code 50053 is currently `UNKNOWN` / `AMBIGUOUS_DOCUMENTED_CODE`.** It
   carries two meanings distinguished only by `failureReason` free text — smart lockout
   after repeated failures, and blocked-from-malicious-IP — observed in one tenant, one
   locale, six weeks. That is too thin for a durable text contract, so the code is
   neither split on text nor guessed at. This is the highest-value mapping decision
   still open: a lockout is downstream evidence of repeated invalid credentials, and one
   tenant showed 553 lockouts and 919 Microsoft-blocked malicious-IP sign-ins that an
   MSP would open the page and not see. Mitigating factor worth measuring: the failures
   that cause a lockout normally also appear as 50126 rows in the same window, so rule 1
   can fire without 50053 — unless the lockouts arrive with no 50126 alongside them.
2. **`APPLICATION_ACTOR` currently reports zero.** No verified field distinguishes an
   application actor from a user missing from the collected directory, so app-only
   sign-ins land as unprocessable subject failures. That is counted and visible, but it
   understates coverage. Activating the reason needs a discriminator that survives a
   control cohort of ordinary human sign-ins.

## Distribution checks requested (run by the PM, not from here)

This module never queries production. The two pending payload-shape questions are
answered by *running this layer* against a real window and reading
`batch.shapeObservations`:

- `graphErrorCodeShape` — is `raw.status.errorCode` a number or a string in production?
  Both are read here, because refusing a string would send every row to `UNKNOWN` if
  that is what is stored.
- `graphIsInteractive` and `graphIsInteractiveAmongCredentialFailures` — the latter is
  the **control cohort** for `isInteractive === false`. Rows carrying 50126 are
  unambiguously human interactive password failures; if they report `FALSE` or `ABSENT`,
  the predicate is wrong or inert and must never exclude anything.

Also requested: the top result codes by row count across a real window (to ground the
mapping table in what occurs rather than in what can be named), the exact-GUID match
rate against `directory_users` with a control cohort of GUIDs absent from the directory,
and the `failureReason` distribution for code 0.

## Tests

```bash
npm --prefix backend run test:risky-users-normalization
```
