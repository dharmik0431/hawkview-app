# Alerting rework — handoff

Written so a cold reader can continue without the people who built it. **Everything factual
here was verified at the time of writing; where it could not be, it says so.**

## Where the work is

Branch `agent/alerts-step-01`, **56 commits over `5488ad6`**. Nothing merged to main.

**Two commits are NOT on the remote.** `origin/agent/alerts-step-01` is at `3529ea1`; local is
at `e056fc9`. Check before assuming, with `git ls-remote origin refs/heads/agent/alerts-step-01`
— the gap between local and remote has been the single most repeated source of confusion in
this work, and a figure quoted from unpushed code has caused it three times.

| worktree | who |
|---|---|
| `…/hawkview-api-rate-limiting` | engineering (this one) |
| `C:/hv-qa` | QA |

**Scope has never left** `backend/src/alerts/`, `backend/src/identity-risk/`,
`backend/scripts/` and `docs/` — verified with `git diff --name-only 5488ad6..HEAD`.

## Status

| step | state |
|---|---|
| 01 declarations, 02 keys and episodes | closed |
| 03 dry run | closed; **apply phase approved by Dharmik, shape written, not built** |
| 04 finding intake | closed |
| 05 routing and policy | closed |
| 05b escalation + limits | **types only; the limit function does not exist** — QA's L1, L2, L4 are unbound |
| 06 email | not started. Resend is verified on `hawkviewapp.com` (PM's claim, not verified here) |
| 07 SMS | **shelved by Dharmik until further notice.** The tier survives; the channel does not |

**Correction to the brief this was written from: `EXHAUSTED` is done**, in `e056fc9` — it is
distinguishable from every other terminal state, carries `notifiedAt` so it cannot be written
without one, is surfaced through `statements()`, and zero rungs is unconstructible. It is
listed here rather than in "next" because the brief still had it pending.

## The file map

All under `backend/src/alerts/`. Line counts and test counts are from the working tree.

| module | what it owns | tests |
|---|---|---|
| `alert-type.ts` | `Severity`, `SubjectRole`, `AlertTypeDeclaration`, `routingTier` | via catalog |
| `alert-catalog.ts` | the **seven** declared alert types, `alertType(id)` | 12 |
| `alert-lifecycle.ts` | `applyObservation`, `acknowledge`, ownership and investigation | 12 |
| `alert-event-time.ts` | branded `EventInstant`, `urgencyOf`, `compareByEventTime` | via catalog |
| `alert-key-encoding.ts` | `joinUnambiguously` — the length-prefixed join everything keys with | 7 |
| `alert-event-key.ts` | per-event identity, `admitEvent` | 5 |
| `alert-incident-key.ts` | `incidentGrouping`, `wouldGroupTogether`, `IncidentIdentity` | 13 |
| `alert-episode.ts` | `placeEvent`, `episodesOf` — watermark spans | 9 |
| `alert-episode-interval.ts` | `quietIntervalMsOf` (24h, measured) | via episode |
| `alert-clearing.ts` | `conditionSatisfied`, `everyCoveredSourceReadable` | 6 |
| `alert-recurrence.ts` | `decideRecurrence` | 13 |
| `window-coverage.ts` | `windowReadableThroughout`, `QuietWindow`, `windowWentQuiet` | 13 |
| `privileged-change.ts` | the **28** `CHANGE_RULES`, `classifyDirectoryChange`, conditional-access | 38 |
| `conditional-access-model.ts` | `MODELLED_PATHS`, `CanSayUnread`, lossless/lossy projection | 17 |
| `reconciliation.ts` | step 03: `parseDedupeKey`, `reconcile`, `adds` | 33 |
| `finding-intake.ts` | step 04: `intake`, `freshnessOf`, `STALE_AFTER_MS` | 24 |
| `routing-policy.ts` | step 05/05b: `causeKeyOf`, `routableIncident`, `fanOutProblems`, `fold`, `statements` | 26 |

Runner: `backend/scripts/alerting-reconciliation-dry-run.mts` — **read-only**, takes a JSON
file or a live read, prints the reconciliation report.

Run everything the way CI does, from `backend/`:

```bash
find src -type f -name '*.test.ts' | sort | xargs ./node_modules/.bin/tsx --test
```

**1684 tests, 1588 pass, 0 fail.** The remaining 96 are database-integration tests requiring a
real Postgres and `HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS=1`; **they were never run here**, and
the pass count must not be read as covering them.

**Write full TAP to a file and grep the file, never the stream.** A grep pipeline destroyed the
one diagnostic that mattered in this work — the assertion message and character offset of an
intermittent failure that never recurred. An output filter tuned for economy is a decision
about what you will be able to diagnose later, made before you know what breaks.

## Three namespaces called "rule", and they are not interchangeable

This is the single most confusing thing in the codebase and it caused a real defect.

| list | count | carries |
|---|---|---|
| `ALERT_CATALOG` ids | 7 | category, subject, severity — **the authority for routing** |
| `CHANGE_RULES` | 28 | the identifier only — **the configurable grain for preferences** |
| `IdentityRiskFinding.ruleId` | n/a | the Risky Users engine's own rules |

**The third has no declared alert type**, so a `RoutableIncident` built from step 04's queue
cannot have its category derived. That is an open gap, not a bug to paper over: those rules
need declared types before their findings can route.

## The two schema findings that determine the apply phase

Both from `c19b5c7`, and they change what the migration can be.

**1. The migration cannot re-key. It can only annotate.** `Notification` carries
`@@unique([organizationId, dedupeKey])`. 317 rows consolidating to 71 incidents would need 317
rows sharing 71 dedupe keys — forbidden — or 246 rows deleted, which breaks "the underlying
events are preserved". So consolidation is expressed by many rows sharing a **new
`incident_key` column**, not by fewer rows existing.

**2. `NotificationUserState` is the second reason.** Read and dismissed state is per
notification id and cascades on delete, so merging rows would **silently discard which alerts a
person had already read** — invisible until an MSP's list came back unread.

Everything else about the apply follows from annotate-not-rewrite: reversibility is *set the
two columns to NULL* with no journal, a partial failure leaves the table untouched because 364
rows is one transaction, and nothing that a delivery path watches is modified. Full shape in
`docs/alerting-apply-shape.md`.

## How this was built — the process is the transferable part

Three roles, and the separation is load-bearing. **Engineer builds. QA attacks. PM rules and
holds production access.** QA never reads the implementation; the engineer never reads QA's
reference wiring. **A check derived from the thing it checks agrees by construction, and the
example route is worse than the bug route because nobody feels like they cut a corner.**

**Pre-registration.** QA writes properties and expected verdicts before the code exists,
publishes the blob sha, and never edits that file — improvements go in a labelled addendum.
Twice a tie broke cleanly because the expectations were provably prior.

**The seam attack, the highest-value step every time.** Before implementing, check each
property is **expressible** through the shape. Found something unpinnable **four times out of
four**, including one that would have closed every open incident when the engine crashed.
*A seam that cannot express a property cannot pin it.*

**Mutation testing, with the faithfulness check.** Break it deliberately and confirm the
assertion written for it fires **by name**. **Check the mutation is faithful before checking it
was caught** — three times a clean zero meant the mutation never applied. A sharpening worth
keeping: **a zero-survivor run is self-verifying against that; a zero-kill run is not**, because
a no-op mutation survives.

**Two instruments.** PM measures production with SQL; the engineer builds generators PM runs.
When they disagree, that is the finding — twice the reference instrument was the broken one.

## The standing rules, in rough order of how often they paid

1. **Make the wrong thing unwriteable, not forbidden.** Branded `EventInstant`, required
   declaration fields, `CanSayUnread`, no `dropped` bucket, `Notified` keying the ladder,
   branded `RoutableIncident`.
2. **Two fields that can disagree need one owner.** Subject, category, type. **A field a caller
   can still set is *derivable*, not *derived*** — different properties, and only the second
   is the rule.
3. **Absence is not evidence of absence**, and *absent*, *unavailable* and *unrecognised* are
   three facts. Four separate defects.
4. **A property about something that did not happen cannot be carried by a list of things that
   did.** Coverage from what was sent; silenced rules from what fired; absence from a flat
   emission list; the ladder from deliveries. Four instances.
5. **A witness cannot establish a universal.** Use a type rule or a generator.
6. **Print the value, not the count.** Five false greens, mostly in the checker's own work.
7. **Do not pattern-match an enumeration** — a negative regex passes by missing.
8. **A green test can change subject.** It still fails when broken, so mutation says healthy;
   the *reason* it passes moved.
9. **Decide what the degenerate input means before writing the producer**, and make it the
   refusing answer.
10. **A bounded search proves only its bounds.** State the bound.
11. **A retraction must live where the claim lives.** Grep the **old** wording.
12. **A cast is a blanket over every complaint in the same literal.**
13. **Check a rule at both edges** — permissive and strict.
14. **A counter derived from a structure inherits that structure's omissions.** Count a
    row-level fact at the row.
15. **Self-reconciliation catches drift; only an independently derived reference catches error.**

## Product rulings, with reasons

- MSPs configure at the grain of the **28 change rule ids**; **our tiers are defaults, not law**.
- **Silencing never silences the record** — no `OFF` value exists, and `Routing.record` is required.
- **An incident takes the tier of its most urgent member** and never goes back down.
- **Only monitoring coalesces; security never merges across tenants** — merging hides one
  tenant's attack inside a message about another.
- **The preference at delivery time wins** for a held alert silenced while pending.
- **Limits aggregate or defer, never drop** — there is no bucket for a dropped message.
- **Expectedness is never applied.** HawkView does not know what was planned, and guessing
  fails toward silence.
- **Episode interval 24h; staleness 30 min** — both measured, with the distribution recorded
  beside the constant rather than the conclusion alone.

## Constraints that must not be broken

- **Nothing merges to main without Dharmik.**
- **Production is read-only and PM-held.** This worktree has no production access.
- **Never a customer end user as a recipient** — enforced by the `Recipient` union.
- **No customer identifiers in any shared document.**
- The uncommitted work in the *other* worktree's `backend/src/changes/` is **untouched and
  unowned** — verified present, four modified files and two untracked. PM reports a
  `canonicalize` export is needed there; **I could not find that symbol and have not verified
  the claim.**

## Immediately next

1. **The apply phase.** Shape is in `docs/alerting-apply-shape.md`; the code is not written.
   **Re-run the dry run first and confirm the figures still match what was approved** — 364
   rows, 71 episodes, 62 attributed, 9 standing alone, 47 unrecoverable. The apply is designed
   to take those as an argument and refuse to write if they have drifted.
2. **The limit function**, which unbinds L1, L2 and L4.
3. **Step 06, email.**

**Two of those need production access this worktree does not have**: re-running the dry run,
and the apply itself. They need Dharmik directly rather than relayed — an approval reported
second-hand is enough to build against, and has not been treated as enough to write with.
