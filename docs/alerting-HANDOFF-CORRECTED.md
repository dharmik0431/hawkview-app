# Alerting rework — handoff

Written so a cold reader can continue without the people who built it. **Everything factual
here was verified at the time of writing; where it could not be, it says so.**

## Step 03: what is done, what gates it, and who owns each gate

**Nothing is mid-build.** Written down because a gap in messages has twice been read as a stall,
and because a status relayed in conversation goes stale while a status in the repository does
not. Check it against the tree rather than believing it — every claim below names where to look.

| item | state | where |
|---|---|---|
| the runner, five subcommands | written, typechecks, never run by its author | `backend/scripts/alerting-apply.mts`, `cb14c31` |
| no production figure carried as a constant | enforced by a test, not a grep | `apply-mapping.test.ts`, `02d26c4` |
| ruling (b), mapping states its own scope | done; preflight would otherwise abort every time | `a98a514` |
| what 47 is for, and the 364→366 drift | recorded | runbook, `b6088f2` |
| **the connection section** | **done** — IPv6-only direct host, session pooler on 5432, copy verbatim | runbook *Connecting*, `b6088f2` |
| the migration and the schema | written, and applied to a throwaway PG15 in four states | `20260912120000_…`, `50532d0` + `1ea8077` |
| 44 not 47, three permanently unwritable | done, with the chain in code | `50532d0` |
| the recovery ruling | done; 44 is an upper bound until measured | `d9de7b9` |
| **migration idempotency** | **done** — six `IF NOT EXISTS` plus a type check that refuses a hand-made column | `1ea8077` |
| **the merged left-alone number at steps 2 and 3** | **done** — `leftAloneLines` prints the breakdown at all three steps | `1ea8077` |
| **the hop limit reporting NEVER** | **done** — `RECOVERY_CHAIN_TOO_DEEP`, boundary pinned at 7 and 8 | `1ea8077` |
| step 06 email seam | written, pure, nothing talks to Resend | `859b88e` |

**The last three were reported as outstanding after they were committed.** They are not; the
table names the commit for each. That mismatch is itself the finding: **cross-session messages
have been refused by a rate limiter more than twenty times, so commits are the only channel that
has actually been delivering.** Anything not in a commit message has probably not arrived.

### What actually gates the run

1. **The release hold.** Every commit on this branch is local. Only Dharmik lifts it, and no
   peer request can substitute — a request to push that arrives because somebody else's push was
   blocked is the one thing that must always be refused.
2. **A working connection.** The runbook says how; nobody has made one. Step 1 is read-only, so
   it is also the test.
3. **Counting what the 17 recoveries recover.** 44 is an upper bound. The runner reports the
   shortfall under `NEVER writable`; if that line reads above 3, recoveries have landed in it.

None of the three is engineering work, and none is waiting on a decision from the PM.

## Where the work is

Branch `agent/alerts-step-01`, **56 commits over `5488ad6`**. Nothing merged to main.

**COMMITS ARE NOT ON THE REMOTE, AND THE COUNT IN THIS SENTENCE WILL AGE.** At the time of
writing `origin/agent/alerts-step-01` was at `3529ea1` with four local commits ahead of it,
including this document. **Do not trust that figure — run the check:**

```bash
git ls-remote origin refs/heads/agent/alerts-step-01; git rev-parse HEAD
```

The gap between local and remote is the single most repeated source of confusion in this work.
Three separate times a figure was quoted to somebody from code that was not on the remote, and
each time it was believed because the number looked right. **If you are reading this from a
fresh clone and the file map does not match what you see, that is the first thing to check.**

| worktree | who |
|---|---|
| `…/hawkview-api-rate-limiting` | engineering (this one) |
| `C:/hv-qa` | QA |

**Scope has never left** `backend/src/alerts/`, `backend/src/identity-risk/`,
`backend/scripts/` and `docs/` — verified with `git diff --name-only 5488ad6..HEAD`.

## Read this with `docs/alerting-QA-METHOD.md`

That document is the QA side of the same work — **the practice, written by the session that
did the attacking**, and it is the half with no other home. This document says what was
built and what is left; that one says how anything here was ever believed.

It lived only on `qa/verify-e056fc9`, so a checkout of the alerts branch got the handoff and
not the method. **Copied here byte-identical** — a document is neither instrument nor
implementation, so the branch separation that keeps QA from reading the code does not apply
to it. Read section 2 (the seam attack) before designing anything and section 3 (mutation,
four questions in order) before trusting a green suite.

## Status

| step | state |
|---|---|
| 01 declarations, 02 keys and episodes | closed |
| 03 dry run | closed. **Approved by Dharmik as a rehearsal: 44 rows now, 319 for the classifier, 3 never writable.** The migration adding the two columns now exists (it did not, and step 2 was the step that found out). Apply, revert and the runner **have been run end to end against a disposable PostgreSQL 15 by QA** -- both preflight outcomes, the apply, verify, a revert with occurrences arriving, and a concurrent writer proving the in-transaction re-check rolls the run back rather than writing 46 of 47. The run records are `docs/alerting-apply-FIRST-RUN.md` and `-SECOND-RUN.md`, **which live on QA's branch and not on this one -- a reader here cannot see that evidence.** **Nobody has connected to production from an engineering machine**, so every figure remains a synthetic-fixture figure. Note: it is an ANNOTATION, not a re-keying -- the unique constraint forbids re-keying. See `alerting-apply-runbook.md` |
| 04 finding intake | closed |
| 05 routing and policy | closed |
| 05b escalation + limits | **EXHAUSTED ruling implemented as three type-level impossibilities** (`e056fc9`, verified by QA); **the limit function landed in `42622d1`** — L1, L2 and L4 now bound. The NUMBER is still a labelled guess. See below |
| 06 email | **the seam and the ledger exist and are pure; nothing talks to Resend.** No HTTP call, no signature verification, no webhook route, no key read anywhere. See `alerting-email-delivery.md`, which separates the two. Resend is verified on `hawkviewapp.com` (PM's claim, not verified here) |
| 07 SMS | **shelved by Dharmik until further notice.** The tier survives; the channel does not |
| **the flow, finding to send job** | **proven, in the test's hands.** A persisted `identity_risk_findings` row reaches an `alert_send_jobs` row through real foreign keys on a real database, and all five integration tests pass on a genuinely clean database. **But `runIntake` is called by nothing in `src/`, nothing schedules it, and `PipelineStore` has no implementation outside the test file** --- the chain is joined by the test rather than by the product |

### Five things this document did not say, and each changes how the status reads

**1. A blocker was found in the flow tonight and fixed.** `runIntake` wrote incidents, checked
its budget, then wrote jobs; a yield between them left an incident with no job, which every
later run skipped as `INCIDENT_ALREADY_OPEN`. The alert was never sent and nothing reported it
--- `neverSent()` enumerates jobs that exist, and that incident had none. **It was not a crash
path: it was the designed cascade behaviour**, firing whenever intake ran out of budget after
writing incidents, which is when the system is busiest. Fixed in `5b0883b` by one
`commit(incidents, jobs)` with the budget check before the write phase.

**The acceptance test was not "did the stranding stop".** Four shapes produce
incident-with-no-job --- `BEFORE_WATERMARK`, `RECORD_ONLY`, `NO_ELIGIBLE_RECIPIENT` and the
yield --- and three must stay silent forever, so a fix that could not tell them apart would have
delivered the entire backfill. All four seeded at once across two organisations: **exactly one
job came out**, each silence named. The commit is atomic rather than sequential, tested by
killing the backend mid-transaction: neither row survived.

**2. DEPLOY IS MIGRATE, and a rollback is code only.** `backend/Dockerfile` line 44 runs
`npm run db:migrate:deploy && npm start`, so **merging and deploying applies all three alerting
migrations with no operator step and no decision point in between.** `prisma migrate deploy` is
forward only: rolling back to the previous image does **not** undo a migration --- the old
container starts against the new schema. **So the runbook's step 0 does not describe a no-op, it
describes a gate that does not exist**, and an operator reading it would believe they choose when
the schema changes. They do not. The release hold is the only thing standing between these
migrations and production. *(The three migrations read as additive --- `CREATE TABLE IF NOT
EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` --- which would mean a previous
container ignores them, but **that rehearsal has not been run and must not be assumed**.)*

**3. There is no production code path.** Stated twice on purpose: the status must not read as
though the product can send an email. It cannot yet.

**4. Six catalogue rules map to no alert type, by decision**, reported rather than defaulted ---
see the superseded Risky Users section below for what replaced it.

**5. The ten lock-ordering failures are classified as environment; the ordering is unproven.**
Not "lock ordering verified". They do not demonstrate the ordering wrong, which is not the same
as demonstrating it right --- nothing exercised it successfully, because the transactions did not
survive long enough to try. Not a blocker: the alerting pipeline reads `identity_risk_findings`
directly and never touches the key store.

**And one limit on a figure that will otherwise be over-read:** `accountingProblems: []` means
every finding appears exactly once across the jobs and the skips. It is a self-reconciliation
over one pass. **It proves nothing vanished. It cannot prove anything was classified correctly**
--- a finding wrongly skipped as `RECORD_ONLY` counts exactly once and the books still balance.
It is a tripwire against a future edit, not evidence that the delivery decisions are right.

**Correction to the brief this was written from: `EXHAUSTED` is done**, in `e056fc9` — it is
distinguishable from every other terminal state, carries `notifiedAt` so it cannot be written
without one, is surfaced through `statements()`, and zero rungs is unconstructible. It is
listed here rather than in "next" because the brief still had it pending.

**The three EXHAUSTED rulings are impossibilities rather than checks**, which is why they
need no test to keep them true:

- `EXHAUSTED` requires `notifiedAt`, so **a ladder that exhausted while nobody was told**
  **cannot be written.** Notification is what starts the climb.
- `LadderRungs` is a non-empty tuple, so **a zero-rung ladder does not typecheck** — it would
  otherwise be EXHAUSTED at birth, reporting *we tried everything* about an incident that
  never escalated.
- `STOPPED_BY_PREFERENCE` is its own terminal state, so a ladder halted because the MSP
  silenced the rule is **not** confused with one that ran out. Same silence, opposite
  meanings, different remedies.

And `unanswered` carries a sentence that `statements()` surfaces beside the silenced rules,
because **an explanation reaches somebody already looking; a statement reaches somebody who
is not** — and the worst outcome the product can produce must not be the quietest.

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

## Why these are mechanised rather than remembered

The obvious objection to a list of rules is that a list is enough. It is not, and the
evidence is the best single argument for everything above.

**QA wrote the rule about casts, had it adopted as a standing rule, and then broke it within
two rounds** — a fixture guessed a field name (`to` where the type says `recipient`) and hid
the guess behind an `as` cast. Their own account, from `alerting-QA-METHOD.md` §5:

> *Knowing the rule is not the same as applying it; the compiler is what applies it.*

**The value of every rule below is that a tool enforces it, not that somebody remembers it.**
The person who wrote a rule broke it two rounds later, in the document that recommends it.
So when you read the list, the useful question is not "do I agree" but **"what would catch me
if I got this wrong"** — and where the answer is "nothing", that rule is decoration.

This is not hypothetical elsewhere either. In this feature the compiler caught: a phantom
brand emitted as a runtime key, an `@ts-expect-error` on the wrong line, a statically-true
assertion after a narrowing `find`, and an unused expectation that proved a claim about
unwriteability was wrong. **Every one of those was written by somebody who knew the rule.**

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

## What is deliberately not covered

**The honest gaps, which are what a cold reader most needs.** Each of these is a decision or a
known hole, not an oversight — and none of them is blocked on something nobody remembers.

### The limit function exists; its number does not

`applyLimit` landed in `42622d1` and **L1, L2 and L4 are bound**: every delivery is accounted
for exactly once, withheld ones carry a release CONDITION rather than an invented `until`, the
backlog drains as one aggregate that names every incident inside it, and the count is per MSP
per tick — the same window as `fanOutProblems`, so the limit and the invariant measure one
thing rather than two that nearly agree.

**The number is still a guess and says so.** `UNMEASURED_LIMIT` is twenty per MSP per tick,
carrying the sentence *NOT YET MEASURED*; the honest input is observed causes per MSP per tick
on production data, which no worktree here has. Contrast `STALE_AFTER_MS`, which carries 5,166
runs behind it. **A placeholder that reads as authoritative is worse than one that reads as a
guess,** because nobody goes back for the second kind.

### What the apply is allowed to key — ruled: about 47 rows, not 364

**Found while writing the runner, and it changes the expected output of step 03.**

`TYPE_FOR_SHAPE` maps `DIRECTORY_AUDIT` to `null` deliberately: the key shape does not determine
the alert type, and defaulting it would file real privileged changes as routine. So those rows
reach `report.mapping` with `incidentKey: null` — and the apply writes only non-null keys.
**On production that is 317 of the 364 rows skipped.**

The approved figures — 364 / 71 / 62 / 9 / 47 — come from `incidents.assumingSingleType` and the
episode counts, which are computed under the NOMINATED type. That is a different question from
what the mapping authorises, and the two were read as one number. Pinned by a test
(`THE APPLY WOULD NOT KEY A SINGLE DIRECTORY-AUDIT ROW`) so it cannot be lost in a diff.

**APPROVED BY DHARMIK AT THIS SCOPE, AS A REHEARSAL.** He asked what the number was for before
approving it, and the honest answer is that **the 47 are monitoring rows and the 301 unclosable
alerts are all in the other 319** — keying 47 changes almost nothing an MSP would notice. It is
the apply, the receipt, the revert and the verification exercised against real data at low
stakes before the same machinery touches rows that include real privileged changes. **If
somebody later reports this migration as having fixed the alerting problem, it did not.**

**Live figures, 2026-09-12: 366 rows, 319 awaiting the classifier, 3 never writable, 17 recoveries ruled writable, 44 writable today (an upper bound - see below), 5 tenants touched.** 366 rather
than 364 because two rows arrived during the conversation in which the figure was being
discussed — the photograph problem as an observation rather than a hypothetical, and the best
argument there is for validating the mapping against current data immediately before a write.

**Ruled: key only the rows whose shape determines a type.** 47 now, 317 when the classifier
reaches historical audit rows — scoped work, not an open question. Keying everything under the
nominated type was rejected not for being riskier but for contradicting a decision already made:
it assumes a single type for rows whose type is undetermined, which is what the classifier exists
to prevent. **Migrating them as routine would be the original defect re-entering through the
migration built to clear it.** The smaller first part also proves the apply, the receipt and the
revert against 47 real rows before 317 depend on them.

**And the ruling broke the preflight, which nobody had looked at.** With the mapping being a list
of writes, the scope of the run was INFERRED as "everything in the table" — so all 317 deliberate
exclusions arrived at the final check as `ROW_UNEXPECTED`. **317 differences on a clean table,
every time; the apply could never have run.** Unauthorised-by-mapping and refused-because-moved
were the same input.

A mapping is now a decision about **every row it saw** — `WRITE` or `EXCLUDE`, one per row, in one
list rather than two fields that can disagree. An excluded row is counted and reasoned; a row the
mapping never saw still aborts, unchanged. Two new abort kinds fall out: `EXCLUDED_BUT_KEYED` (an
exclusion is a decision about what WE write, never a promise about what the row holds) and
`MAPPED_TWICE`. The two exclusion reasons are carried separately because they clear at different
times — one on the classifier, one on the row's own subject, which may never resolve.

### The columns the migration writes did not exist

**`incident_key` and `episode` were in the code and in the docs, in no migration and not in
`schema.prisma`.** Found by QA running the five commands end to end. The failure was delayed
and pointed at the wrong thing: `save-mapping` reads through Prisma and never selects either
column, so **step 1 succeeds and writes a mapping file**, and step 2 dies with `column
"incident_key" does not exist`.

`20260912120000_notification_incident_key` adds both as nullable with no default, plus
`(organization_id, incident_key)` — organisation first, because the column exists to be grouped
by and every read here is org-scoped. **Both are in `schema.prisma` too**, which was a ruling: a
column absent from the schema is invisible to every consumer except a raw query, so routing
could not see the key at all.

The runbook has a **step 0** that applies it and a query to confirm it landed.

**It is idempotent, and that was measured.** Against a throwaway PostgreSQL 15 from four starting
states: clean applies; already-applied is a no-op; **columns created by hand with the migration
unrecorded converges** — that state raised 42701 with bare ADD COLUMN, and Prisma then records a
failed migration that blocks every later one with P3009, which is a wedged database produced by
running a migration twice. It was reachable because the workaround DDL in the first-run record
creates exactly those columns.

**IF NOT EXISTS alone would not have been enough.** It matches on name, so a hand-made column of
the wrong type would be silently adopted and the apply would write incident keys into something
that truncates them. The migration checks the type first and stops before any DDL runs; the
fourth starting state confirms nothing is left behind when it refuses.

A partial index `WHERE incident_key IS NOT NULL` would be much smaller — 44 of 366 rows are
keyed — and was rejected because Prisma cannot express one, so it would exist only in the SQL
and read as drift on the next `migrate dev`. Noted in the migration for whoever revisits it.

### Three rows are permanently unwritable; recoveries were ruled writable

**44, not 47.** Every `TENANT_INITIAL_SYNC` row is unkeyable by construction: the shape types to
`monitoring.collector_failing`, whose subject is `COLLECTOR`, which reads a resource type out of
the key — and `tenant:<id>:initial-sync` is anchored with no segment that could hold one. **No
classifier and no future data changes it.** Production holds three.

There are now **three** exclusion reasons rather than two, because "left alone" was collapsing a
row that clears when the classifier lands with one that never clears — the same collapse this
feature has refused five times elsewhere. The vocabulary is owned by `reconciliation.ts`, which
has both the catalogue and the key grammar; `apply-mapping.ts` aliases it rather than restating
the literals.

**ATTRIBUTION, BECAUSE 44 DEPENDS ON IT.** The recovery shape was found by the engineer while
writing the migration; counted against production by the PM, which is where 17 comes from; and
the ruling below is the PM’s. **Nobody has independently verified any of it.** It was briefly
recorded as a QA finding, which would have implied an independent check existed — QA corrected
that rather than accepting the credit, and the reason is the one to keep: **a finding recorded
against the party who would have checked it is a finding nobody checked.**

**A SECOND SHAPE WAS IN THE SAME POSITION AND HAS BEEN RULED ON.** Production holds 17
RECOVERY rows. The ruling: **a recovery takes its subject from the key it recovers and keeps its
own type.** The recovery-first rule is about the TYPE; this is about the SUBJECT, so
`parseDedupeKey` still classifies a recovery as a recovery and nothing is reclassified. It does
not merge into what it recovered, because the incident key carries the type id and the two types
differ — a recovery becomes its own record-tier incident, which is what the tiering already says
it is.

**But the ruling does not reach every recovery, and nobody has counted which.** A recovery of a
connection or an audit alert still names no resource type, because what it recovers has none
either. Only recoveries of sync alerts resolve. **So 44 is an upper bound until step 1 measures
it** — the runner reports the shortfall under NEVER writable, and if that line reads above 3,
recoveries have landed in it.

**`permanentlyUnresolvable` is keyed on the dedupe key rather than the shape** because of this:
a RECOVERY key answers differently depending on what it recovers, and a shape-level table would
have to say sometimes, which reads as waiting.

### Nobody can connect to production from an engineering machine

**A defect in the runbook rather than an omission, and it cost a rotated credential.** Two
connection strings were reconstructed by hand, one was wrong, and a credential reached a chat
message during the attempt.

Two traps, both of which fail as something that reads like a network problem: the direct host
`db.<ref>.supabase.co` is **IPv6-only** and does not resolve on most connections, and 6543 is
the transaction-mode pooler. **Session mode on 5432, copied verbatim from the dashboard.**

The runner now warns on both shapes without ever printing the string, and the runbook has a
*Connecting* section. **Neither rule has been tested from anywhere** — they are the
recommendation with the fewest unknowns, not a verified configuration.

One correction worth keeping: transaction mode would **not** "break the single transaction" —
it pools *by* transaction, and one statement in one transaction is the most pooler-friendly
shape there is. The real hazards there are session-level, and the usual Prisma one (named
prepared statements) is reduced by the `pg` driver adapter, which sends unnamed statements.
Session mode is still right, because a one-shot script gains nothing from pooling and loses the
guarantee that it ends on the connection it began on. **The rule was right and the reason was
wrong**, which is worth fixing: a rule with the wrong justification gets applied where it does
not hold and dropped where it does.

### The next real piece: the classifier on historical audit rows

**This is what turns the rehearsal into the thing he wanted.** The 319 excluded rows are
excluded because `TYPE_FOR_SHAPE` cannot type a `DIRECTORY_AUDIT` key, and the classifier that
can already exists — it is simply not pointed at historical rows. Step 05 territory, scoped
work, and the 301 unclosable alerts are on the other side of it.

### The per-row episode had no owner until now

The migration writes two columns and only one of them was decided. The mapping carried an
incident key; nothing carried an episode number, and the convenient answer — null for every row
— is not a gap but a WRONG VALUE, because null already means *unrecoverable* and 47 rows are
entitled to it while 317 are not.

`reconcile` now returns `episodeByRow`, assigned **inside the loop that counts the episodes**,
from the same `episodesOf` spans. Deriving it anywhere else — even from this report's own
`mapping` — would partition the rows a second time and agree with the printed total only by
luck. The runner throws rather than defaulting when a row has no decision.

### Step 06 exists as a shape, not as a channel

**ACCEPTED is not an outcome.** The provider answers synchronously; whether the message
arrived is a different fact arriving later by webhook, about a send that already returned. So
`send(message): Promise<Outcome>` cannot express most of what needs checking, and **an
unaskable property reads exactly like a passing one.** `Acceptance` and `Outcome` are two
unions that share no member.

Bound: acceptance is not delivery; an accepted job nobody mentions again is reported rather
than resting in ACCEPTED; an event for a job we do not hold is named in `unmatched`; a second
outcome does not overwrite the first; an unsigned event has no path to becoming an outcome;
the body has no slot for a person, a tenant, a link containing either, or free text.

**What is NOT written, and the doc leads with it:** the Resend HTTP call, the signature
verification itself, the webhook route, durability for the ledger, and the subject line —
which is not modelled here and is the obvious next leak. Also unverifiable from this side:
that an idempotency key is honoured, that "accepted" means the provider has taken
responsibility, and any real bounce rate.

### The two migration scripts had never been typechecked

`backend/tsconfig.json` includes `src` only, so `npx tsc --noEmit` walked past `scripts/` and
exited 0. The first run of the new `tsconfig.scripts.json` found that
`alerting-reconciliation-dry-run.mts` called `new PrismaClient()` with no arguments — which
**Prisma 7 cannot construct**, since a driver adapter is required. Its database path had
therefore never executed, and any figure attributed to it came from somewhere else. Both scripts
now take a `PrismaPg` adapter and name a missing `DATABASE_URL` at the top rather than failing
deep inside the driver.

**The generalisable part:** a green from a tool that never read the file is the most convincing
kind of false green, because the exit code is genuine.

### `windowReadableThroughout` has no evidence to work from

It needs a **collection-attempt history**, and the database does not keep one. `SyncState` is
current state, not history — a failure inside a window followed by a recovery leaves no trace
at all. `TenantHealthSnapshot` does keep rows and is *worse* for this: its density is a
function of **who opened the tenants page**, so an unvisited tenant would read as healthy.

**Consequence, and it is narrower than it sounds.** Only `ATTEMPT_HISTORY` can yield true, and
nothing constructs one, so a `NO_FURTHER_EVENTS_IN_READABLE_WINDOW` condition never
auto-clears. **Exactly one declared type resolves that way** — `security.suspected_credential_attack`
— and its investigation is `ONLY_BY_A_PERSON` regardless, so what is lost is the condition axis
moving to cleared, not an incident stuck in somebody's queue. **Verified against the catalogue
rather than remembered: 1 of 7.**

The real repair is a collection-attempt history, which is a schema decision. **This was a
deliberate deferral, not an oversight** — the alternative was deriving coverage from
"no failure rows in the window", which fails in the unsafe direction.

### The preference grain for five of the seven types is the type itself

The `DECLARED_TYPE` origin sets `ruleId = alertTypeId`, because for the non-directory types the
type **is** the grain. Coherent today. **The first finer rule added under one of them would
collapse invisibly** — an MSP could not silence it separately, and the field would still be
populated, reading as a rule and meaning a type.

Recorded at the grain in `alerting-routing-policy.md` so whoever adds that rule meets it there
rather than in a support ticket about an MSP who turned off more than they meant to.

### ~~The Risky Users rules have no declared alert type~~ --- SUPERSEDED by `1ffc88e`

Step 04's `intake` puts `IdentityRiskFinding.ruleId` into the queue, and that id is in neither
the catalogue nor `CHANGE_RULES`. ~~**So routing cannot derive a category for those findings at all.**~~ **`alertTypeForRule` now
derives the type from the `investigationGuidanceCode` the catalogue already declares**, total
over four codes: `REVIEW_ACTIVITY` and `REVIEW_ACCESS` map; `REVIEW_CONFIGURATION` and
`REVIEW_MAILBOX_RULE` are **deliberate refusals reported as unmapped** rather than defaults. Six
catalogue rules produce no incident and no job, each named with its reason and its rule id
surfaced in `unmappedRules`.

**The warning below was right, and was then proven right twice.** Two earlier versions of the
mapping were wrong in different ways and both would have shipped: one matched prefixes like
`identity.credential`, a namespace `identity_risk_matched_rule_check` forbids, so every
production finding would have reported unmappable; the second matched the real three-letter
families and guessed their meaning from the letters --- `EXP` is EXPOSURE, not expiring.
Inventing a mapping is the shortcut that put a caller-supplied category in the cause key in the
first place.

### `canonicalize` in `backend/src/changes/`

Reported as needing an export, blocked on uncommitted work in the **other** worktree that
nobody owns. **I could not find that symbol and have not verified the claim** — see the
constraints section.

### ~~Database-integration tests have never been run against any of this~~ --- SUPERSEDED, warning intact

They need a real Postgres and `HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS=1`. ~~**96 tests, zero
runs.**~~ **The alerting flow's five integration tests now pass on a genuinely clean database**,
and QA has run the wider suite: with every prerequisite the code asks for, **45 pass**. The rest
fail on environment rather than product defects --- **none has been shown to be a defect and none
should be quoted as one.**

**The wall is a timeout that bare catch-alls were hiding.** `IDENTITY_RISK_SOURCE_UNAVAILABLE` is
thrown from twelve places; every failure came from the twelfth, a bare catch that discarded its
cause. Since `2e4cc54` it carries the cause, which reads `timeout expired`.
`wrapped-risk-key-store.ts` has four more bare catches --- 124, 138, 143, 174 --- while its twelve
other `keyUnavailable()` calls are guarded throws that must not be touched.

**The 1588 figure still must not be read as covering that suite, and nobody can yet take it to a
green run.** Prerequisites are named with a yes/no each in `alerting-B3-SIZED.md`.

## Constraints that must not be broken

- **Nothing merges to main without Dharmik.**
- **Production is read-only and PM-held.** This worktree has no production access.
- **Never a customer end user as a recipient** — enforced by the `Recipient` union.
- **No customer identifiers in any shared document.**
- The uncommitted work in the *other* worktree's `backend/src/changes/` is **untouched and
  unowned** — verified present, four modified files and two untracked. PM reports a
  `canonicalize` export is needed there; **I could not find that symbol and have not verified
  the claim.**

## Where the work actually stands, and how to tell

**The commit stream on the remote is not the work.** ~~At the time of writing, five commits~~
**Nine commits** exist locally that the remote does not have — the apply shape, the EXHAUSTED ruling, the
step-07 shelving, this document and the QA method document. Anybody watching
`origin/agent/alerts-step-01` sees the last of them as `3529ea1` and reads twenty-three
minutes of work as a stall.

**If you are trying to work out whether something is in progress, compare the two:**

```bash
git log --oneline origin/agent/alerts-step-01..HEAD    # done, not visible to anyone else
git status --porcelain                                  # in progress, not committed
```

An empty first list and an empty second means the branch is genuinely where it appears to be.
A non-empty first list means the work exists and the *distribution* is what is behind — which
has been the state for most of this feature and is the single thing most likely to mislead a
reader about progress.

## A warning for whoever pre-registers the apply

`docs/alerting-apply-shape.md` is a design document written by the engineering side. **Do not
derive the apply's pre-registered properties from it.** A pre-registration that reads the
design agrees with the design by construction, and it agrees just as thoroughly as one that
read the code — the whole value is that the expectations were formed independently.

Pre-register from the **semantics and the constraints**: reversible, no historical alert
delivered, underlying events preserved, idempotent, and what a changed row or a partial
failure must do. Then read the shape document afterwards and see whether it can express them.
**That order is the seam attack**, and on this step an unpinnable property is a production
incident rather than a rework.

## ~~Immediately next~~ --- EVERY ITEM BELOW IS STALE, AND THE FIGURES ARE THE WRONG ONES

**Read this section only for what it shows about how the figures moved.** The apply code is
written and has been run; the limit function landed in `42622d1`; step 06 is partly built.

**THE FIGURES IN ITEM 1 ARE THE CONFLATED ONES AND MUST NOT BE RE-USED.** *364 rows, 71
episodes, 62 attributed, 9 standing alone, 47 unrecoverable* answers **how many incidents are in
this data**, which is a different question from **how many rows this run may key**. The two were
read as one number for long enough to reach a status report.

**The approved shape is: 366 rows total, 319 awaiting the classifier, 3 permanently unwritable,
44 writable.**

**This correction matters more than the others on this page**, because the apply refuses to
write when the figures have drifted --- so anybody re-running from the old list meets a refusal
and cannot tell whether the data moved or the document lied.

## ~~Immediately next~~ (superseded, kept for the record)

1. **The apply phase.** Shape is in `docs/alerting-apply-shape.md`; the code is not written.
   **Re-run the dry run first and confirm the figures still match what was approved** — 364
   rows, 71 episodes, 62 attributed, 9 standing alone, 47 unrecoverable. The apply is designed
   to take those as an argument and refuse to write if they have drifted.
2. **The limit function**, which unbinds L1, L2 and L4.
3. **Step 06, email.**

**Two of those need production access this worktree does not have**: re-running the dry run,
and the apply itself. They need Dharmik directly rather than relayed — an approval reported
second-hand is enough to build against, and has not been treated as enough to write with.
