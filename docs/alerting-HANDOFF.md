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

## This document moves with the code, not with the milestone

**Dharmik’s rule, and it is the reason this file was stale twice:** *if a commit moves what is
true about the product, it moves this document in the same commit.* Not at the end of a step,
not when somebody notices.

**It lives on the release branch and the engineer owns it.** QA proposes text; the engineer
applies it here. **No replacement files on other branches** — a status living somewhere else is a
second home for the status, which is the identical shape to the defects this feature has fixed
three times in code. This section itself arrived that way and is the last one that will.

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
| 03 dry run | closed. **Approved by Dharmik as a rehearsal: 44 rows now, 319 for the classifier, 3 never writable.** **All five runbook commands have been run end to end against a disposable PostgreSQL 15 by QA** — both preflight outcomes, the apply, verify, a revert with occurrences arriving, and a concurrent writer proving the in-transaction re-check rolls the run back rather than writing 46 of 47. **Nobody has connected to production from an engineering machine**, so every figure remains a synthetic-fixture figure. It is an ANNOTATION, not a re-keying — the unique constraint forbids re-keying. See `alerting-apply-runbook.md` |
| 04 finding intake | closed |
| 05 routing and policy | closed |
| 05b escalation + limits | **EXHAUSTED ruling implemented as three type-level impossibilities** (`e056fc9`, verified by QA); **the limit function landed in `42622d1`** — L1, L2 and L4 now bound. The NUMBER is still a labelled guess. See below |
| 06 email | **the seam, the ledger and the send queue exist and are pure; nothing talks to Resend.** No HTTP call, no signature verification, no webhook route, no key read anywhere. QA’s nine properties are bound against the seam — six hold, one partial, and **M1 and M2 are unaskable of it by design**, which is what the send queue was built to own. Ten retry properties bound against the queue, including one proven against a real database. Resend is verified on `hawkviewapp.com` (PM’s claim, not verified here) |
| **the flow, finding → send job** | **wired into the product.** A persisted `identity_risk_findings` row reaches an `alert_send_jobs` row through real foreign keys, and `AlertIntakeService` is the real `PipelineStore` — raw SQL through `PrismaService`, both writes in one transaction. **Called from `api/internal/sync/due-tenants`**, after the risk cycle and before the collectors, in its own window to +60s. It yields rather than borrowing, and never throws into the cascade. **It will not run at all until a watermark is chosen** — see below |
| **deploy is migrate** | `backend/Dockerfile` line 44 runs `npm run db:migrate:deploy` on every container start, so **there is no migration gate and no operator step**. Whether a committed migration is live depends on whether a commit containing it has been DEPLOYED — not on whether anybody ran the runbook’s step 0, which does manually what the container does anyway. **Rollback is therefore code-only:** redeploying an earlier image re-runs `migrate deploy`, which does not undo anything |
| 07 SMS | **shelved by Dharmik until further notice.** The tier survives; the channel does not |

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

Rollout position — the release commit, the measured test results, the migration and rollback
facts, and the acceptance checklist status: **`docs/alerting-rollout-readiness.md`**.

Runner: `backend/scripts/alerting-reconciliation-dry-run.mts` — **read-only**, takes a JSON
file or a live read, prints the reconciliation report.

Run everything the way CI does, from `backend/`:

```bash
find src -type f -name '*.test.ts' | sort | xargs ./node_modules/.bin/tsx --test
```

**1832 tests, 1712 pass, 0 fail.** The remaining 120 are database-integration tests requiring a
real Postgres and `HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS=1`, which this command does not set,
so **the 1696 figure does not cover them.** They have been run, separately and against a real
cluster — see *Database-integration tests HAVE now been run* below for what that did and did not
establish. Do not read the two results as one number.

**One intermittent failure was seen once and has not recurred.** `risk-owned Prisma transport
drains startup, BEGIN, query and rollback stalls without abandoned callbacks/sockets`
(`src/identity-risk/risk-bounded-prisma-transaction.test.ts`) failed on one full-suite run at
2149ms, then passed on three isolated runs and three further full suites. **Recorded as a flake on
evidence, not on hope**: it asserts `Date.now() - start < 2_000` around a 650ms deadline, so it
is a wall-clock bound competing with every other test on one machine; and it imports only
`node:net` and its own subject, so **no import path reaches anything this branch changed** —
the only identity-risk file touched here is `mailbox-read-transaction.ts`, which it does not
load. That is an argument, not a proof: a fifth green run does not make a timing assertion
sound. Whoever sees it fail again should suspect the bound, not the transport.

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

### The Risky Users rules have no declared alert type

Step 04's `intake` puts `IdentityRiskFinding.ruleId` into the queue, and that id is in neither
the catalogue nor `CHANGE_RULES`. **So routing cannot derive a category for those findings at
all.** They need declared types — category, subject, severity — before they can route.
Inventing a mapping is the shortcut that put a caller-supplied category in the cause key in the
first place.

### `canonicalize` in `backend/src/changes/`

Reported as needing an export, blocked on uncommitted work in the **other** worktree that
nobody owns. **I could not find that symbol and have not verified the claim** — see the
constraints section.

### The sender exists and nothing in this build can reach a provider

**There is no Resend client in the repository.** The provider is a `SendTransport` the caller
supplies, and the only one that exists — `NO_TRANSPORT_CONFIGURED` — sends nothing and says so.
**Switching sending on requires somebody to WRITE a transport, not to set a variable**, which is
a stronger property than a flag defaulting to off.

It refuses RETRYABLY rather than permanently, deliberately: a permanent refusal would burn each
job’s budget and mark it GAVE_UP, so a system left running against it would conclude every
address was dead and whoever later wired a real provider would inherit a queue that had already
given up.

**A hard bounce suppresses the ADDRESS, not the job.** The fact is about the mailbox, so a
different message to the same dead address is not attempted either; continuing to try is what
earns a sending domain a reputation problem, and that damage lands on every other message rather
than on the one that bounced. A soft failure suppresses nothing and retries inside the bound the
job already carries.

**Nothing reaches a transport without a permit** — the sender takes one, and the only thing that
produces one is a claim whose row count was exactly one.

### The webhook verifier, the off switch and the stop button

**The verifier is real HMAC over the Svix scheme** — id, timestamp and RAW body, with a
five-minute replay window each way and constant-time comparison. It is the only place the
webhook secret is read; `email-delivery.ts` takes the verdict and never learns how it was
reached. **Unconfigured fails closed** as `SIGNATURE_INVALID`, never AUTHENTIC.

**It returns a verdict and never throws**, unlike `SchedulerTokenVerifier`: a webhook we cannot
authenticate is not an error, it is an unmatched event that must still be recorded.

**Every negative sits beside a genuine signature that must verify.** A verifier that rejects
everything passes every forgery test and is indistinguishable from a correct one until real
traffic arrives — and the mutation confirms it: making the comparison always fail breaks the
positive control first.

**Absence of a preference row sends nothing.** `bool_or` over no rows is NULL and an
organisation with no rows returns nothing at all; both must read as *nobody here can be
reached*, or a brand-new MSP is emailed before anybody chose to be. Proven against a real
database in both shapes — no row, and a row left at the column default — each beside a positive
control.

**The stop button exists, it stops attempted jobs too, and it has a press.** `cancelStatement`
cancels every job that is not already finished, in one statement, scopable to one organisation or
everything, and it never touches `alert_incidents` or `alert_send_attempts`. `CANCELLED` is its
own terminal state — deleting the row would lose the ability to explain what the product did, and
reusing `GAVE_UP` would confuse *the address refused us* with *a person stopped it*.

**The bound was `attempts_made = 0` first, and that was wrong in the direction that sends.** A job
attempted once and refused RETRYABLY is still `READY` with budget left, so excluding it meant the
operator pressed stop and an email went out afterwards. Measured: of three stoppable jobs the old
bound stopped one. QA had pre-registered that a CLAIMED job must never be cancelled and has
withdrawn it.

**THE RESULT IS PER JOB, NEVER A COUNT.** Each cancelled job comes back labelled
`STOPPED_BEFORE_ANY_ATTEMPT` or `MAY_HAVE_REACHED_PROVIDER`. Told *"3 stopped"*, an operator stops
watching the inbox and tells the customer it was caught — and QA measured a real press reporting
3 where two had attempts already made. Somebody told a message was stopped behaves completely
differently from somebody told it might not have been, so the two facts never arrive in one word,
and the script never adds the two numbers together.

**A live claim at zero attempts counts as uncertain**, not just a non-zero attempt count. The
worker can be inside `attemptSend` at that instant, and a rule keyed only on `attempts_made`
would report it as safely stopped.

**Who, when and why are on the row** (`cancelled_by`, `cancelled_at`, `cancelled_because`), with a
CHECK making cancelled-without-provenance and provenance-without-cancelled both unwriteable, and
the reason a branded type with no default. Six months from now *why was this MSP never told* has
to be answerable from the record rather than from a log somebody still happens to have.

**`createdBeforeIso` is required on both scopes.** Intake runs every five minutes, so jobs created
after the press are a real category, and whether stop means those too is a decision the operator
makes rather than one they inherit from a WHERE clause.

**THE PRESS IS `backend/scripts/alerting-cancel.mts`**, because a release precondition that cannot
be pressed is not met by the function existing. A script rather than an endpoint: no new public
surface, no authorisation question, no deploy, and reachable by anyone with the database URL —
which is the situation a stop button is for. It previews by default and needs `--apply` to write.
Run end to end against a real cluster: the refusals, the preview changing nothing, the apply
writing provenance, the neighbouring organisation untouched, a second press stopping nothing.

⚠ **The organisation scope matches a message-id prefix**, because R8 deliberately left the queue
with no organisation column. That couples the stop button to the message-id format. The
alternative reopens what R8 closed. Flagged, not decided.

⚠ **WHAT THE RACE TESTS DO AND DO NOT ESTABLISH.** The read-then-write cancel — the shape anybody
would script by hand — is demonstrated failing: it reports a job as stopped after a worker has
claimed it. The one-statement form is then shown leaving no gap for that claim. But the first
version of that test **passed with `FOR UPDATE` deleted**, and the corrected comment says so: the
UPDATE's own row lock is what excludes the claim in that interleaving. `FOR UPDATE` closes a
narrower window — a claim committing between the statement's snapshot and the UPDATE's lock,
leaving the CTE's pre-image stale — which is sub-millisecond and is **argued from the shape of the
statement, not measured**. Whoever revisits this should know which half has evidence behind it.

### Suppression now survives a restart, and the table is keyed by the address

`Suppressions` was an interface with one in-memory implementation. A hard bounce was therefore
forgotten on the next deploy and the dead mailbox was written to again — **that is not a
suppression, it is a cache with a very short life**, and a mailbox retried after every release is
what costs a sending domain its reputation, on every other message rather than on the one that
bounced. `alert_suppressed_addresses` (migration `20260913040000`) holds them.

**The address is the primary key**, not a uuid with a unique index. Those are the same thing
until somebody writes the second row; a surrogate key makes two rows disagreeing about one
address *writeable*, and then "is this suppressed" has two answers and no owner.

**Two timestamps, and the first never moves.** `first_suppressed_at` answers *since when* and a
repeat bounce moving it would reset the age of every address still bouncing — so the mailboxes
dead longest would read as the newest, the exact reverse of what anybody opens the table to find
out. `last_seen_at` moves instead. The reason does not move either: a complaint after a hard
bounce does not make the mailbox exist again.

**The restart is what the integration test simulates**, by discarding the snapshot and loading a
fresh one, which is what a new process does. A unit test cannot see this failure, because the
failure *is* the process ending. Beside it: an empty snapshot still sends to the same address, so
the refusal is the stored row rather than a sender that has stopped sending.

**`suppressionFor` has three answers, not two.** `NONE`, `SUPPRESS`, and `UNSUPPRESSABLE` — an
address that should be suppressed and will not fit the column. Collapsing that third case into
`null` is how a permanent hole acquires the shape of a working guard: the address would be
retried for ever while the code read as if it had handled the bounce. An address is never
truncated to fit, because a truncated address is a different address.

⚠ **NOTHING WRITES TO IT IN PRODUCTION YET**, because nothing drains the queue — see the missing
list. The producer exists (`suppressionFor` over a `REFUSED_PERMANENT` settlement) and is proven
end to end against a real database, but the worker that would call it is not written.

⚠ **NO UNSUPPRESS PATH.** Removing a suppression currently requires SQL. Deliberate — a hard
bounce does not heal on a timer, so a TTL would resume sending to a dead mailbox on a schedule —
but an operator who needs to undo a wrong suppression has no button, and that is a real gap
rather than a closed decision.

### A migration guard had become an instruction to break a healthy database

`20260912120000`'s type check asserted `notifications.incident_key` was `varchar(300)`. Correct
when written — and then `20260913000000` widened it to 400. From that point, re-running the
earlier migration against a current database raised, with a message reading *"A column created by
hand does not match the schema; drop it and re-run this migration."*

**A reader following the runbook's own advice that re-running is safe would have been told to
drop a column holding real incident keys, on a database that was in the correct state.**

Fixed: it accepts 300 or 400, and the message now says not to drop the column and names the
migration that produces each width. The guard still discriminates — measured, `text` and
`varchar(100)` are refused while both correct widths pass, so the fix is not a loosening.

**Found by re-running every alerting migration against an already-migrated cluster rather than by
reading them.** Reading would not have found it: each file is individually correct, and the
defect only exists in the relationship between two of them. The rule this instance yields is the
one the per-field audit already taught — *an audit of each part cannot find a disagreeing pair.*

All six alerting migrations now re-run clean against an already-migrated database, three passes
deep, with existing rows intact. The full position is in `docs/alerting-rollout-readiness.md`.

### Alerts are visible in the product, and the tests now drive the store that ships

**Every incident was a projection over the empty set.** `alert_incidents`' own migration header
says an incident is *a projection over `notifications`, not a parent of them — the set of rows
sharing an incident_key*. The pipeline wrote the incident and the send job and **no notification
row at all**, so the bell showed nothing, the unread count counted nothing, and read and dismiss
had nothing to act on. An incident with no notification is invisible in-app for exactly the
reason an incident with no job was invisible by email — the third instance of that shape.

**The notification is written in the same transaction as the incident and the job**, not as a
follow-up. All three or none; a notification that failed separately would leave an incident that
counts as written and shows nowhere.

**One row per finding, not per incident**, because that is what the projection means and what
`notifications`' unique constraint on `(organization_id, dedupe_key)` allows. A second finding on
an open incident writes a second row — it is written *before* the `INCIDENT_ALREADY_OPEN` branch,
or the product would show the first occurrence of a burst and none of the rest.

**In-app and email are separate channels, and the code shows it.** A finding held back by the
watermark, by `RECORD_ONLY`, or by there being nobody to email still gets its row. Only SENDING is
withheld. `emailEnabled` defaults false and `inAppEnabled` defaults true, so a new MSP sees its
alerts and is emailed about none of them.

**FOURTEEN INTEGRATION TESTS PASSED WHILE THE BELL SHOWED NOTHING**, because every one of them
asked the database what was written and none asked the reader. The new tests call
`NotificationsService.list` — the method the panel calls — and assert the alert is *in the panel*,
with a control that the panel is empty first. Three mutations kill them: removing the write,
returning null from `notificationFor`, and moving the write after the already-open branch (which
kills exactly the second-row test and nothing else).

**The severity and category vocabularies are imported from `notifications.service.ts`**, not
restated, so an invented value is a compile error rather than a row the reader's filter silently
never matches. `ACT_NOW` maps to `critical`, which the filter shows regardless of the in-app
switch — the existing product rule, and deliberate for the tier that would otherwise ring a phone.

### The notification carries the alert type, and the tier is derived from it

**An ACT_NOW incident and a routine informational message rendered identically in the panel**, so
the tier the whole design turns on was unsayable in the one place alerts land. `notifications`
now has `alert_type_id` (migration `20260913080000`).

**That column is the fact; the tier is derived through `ALERT_CATALOG`.** Third time in this
feature the right answer has been *derive it from the catalogue rather than store it again*. There
is no second severity column: two columns describing how urgent something is disagree the first
time anybody edits one. The legacy `severity` is still written — the reader's visibility filter
matches on it — **derived from the alert type at write time, a rendering rather than the fact**,
and `alert_type_id` wins if they ever disagree.

**`alertTierFor` has three answers, and the third is not the first.** A tier; `NOT_AN_ALERT` for a
row with no alert type; `UNKNOWN_ALERT_TYPE` for a stored id the catalogue does not contain,
reported rather than defaulted. **A row that did not say is not RECORD_ONLY** — that is a decision
somebody made to stop being told, and collapsing the two makes a silenced alert type and an
unconfigured one render the same. Tested at all three tiers rather than one plus two edges,
because a mutation sweep elsewhere deleted RECORD_ONLY from an accepted set and killed nothing.

**The API derives the tier and returns it.** Whoever builds the surface renders what the API
sends; deriving it again on the client is the same fact in two places with a network hop between
them.

⚠ **`resolved` has been parsed by the notification normaliser since before this work and rendered
nowhere**, so a cleared incident sits in the inbox looking identical to one still waiting.
Reported by the engineer building the surface; not fixed here, and not this feature's to fix
without a ruling — recorded so it is not rediscovered.

### The disposition column named the wrong thing, and now the key is a type

**`alert_rule_dispositions.rule_id` was looked up by ALERT TYPE id.** So a disposition stored as
`HV-ID-AUTH-010.v1` — which is what any author reading the column name would store — was
**silently ignored and the email went anyway**: the row existed, the write succeeded, the MSP saw
their choice saved, and nothing changed. A correct writer and a correct reader disagreeing about
the key, with no error anywhere.

Renamed to `alert_type_id`, in the unapplied migration, with the unique index. Free today; a
production migration plus a live settings bug later.

**THE RENAME ALONE WOULD HAVE FIXED TODAY'S READER AND NOT NEXT MONTH'S**, because
`alertTypeForRule` lives in the same file — both vocabularies genuinely exist there and both were
`string`. The key is now built by `dispositionKey(organizationId, alertTypeId)`, which takes an
`AlertTypeId`; a rule id **does not compile**, and there is a test asserting exactly that. Same
move as the claim's row count and the over-long alert type id, and the reason those are closed
rather than watched.

**`asAlertTypeId` is the only door from a stored string to a key**, and a value the catalogue does
not declare goes to `Dispositions.unreadable` verbatim rather than being keyed or dropped. It does
not silence — a broken row must not silence an alert by accident either — but it is no longer
silent, so an MSP cannot believe a choice took effect that the product never saw. Proven against a
real database in both directions: at the wrong grain it is reported and does not silence; at the
right grain it silences and the incident is still recorded.

⚠ **THE RENAME DOES NOT SOLVE WHAT THE VAGUE NAME WAS HIDING.** A grain finer than the alert type
is a real future — five of the seven types use the type as their own grain, and the first finer
rule under one of them collapses invisibly. That needs **its own column and a discriminator**, not
this one holding two kinds of id. Stated at the column and in the migration.

⚠ **THE STORED VOCABULARY IS NOT THE TIER VOCABULARY, AND A CONTRACT ASSUMES IT IS.** `disposition`
is CHECK-constrained to `RING | EMAIL | DIGEST | RECORD_ONLY` — a `DeliveryPreference`, the
CHANNEL — derived from the catalogue's `Severity` (`ACT_NOW | ACT_TODAY | RECORD_ONLY`) by
`defaultPreference`. A dispositions API contract specifying the three TIERS would need the CHECK
changed and `defaultDispositionFor` rewritten; writing to it as-is violates the constraint.
**`RECORD_ONLY` is in both vocabularies**, which is why the confusion reads plausibly and why a
half-done change would appear to work for the one case everybody tests. Not changed here —
flagged, because which vocabulary the MSP should choose in is a product decision, not a rename.

### The integration tests drive the production store now, and it is gated by a lock

`pipeline-store.ts` holds the store that ships. It used to live inside `AlertIntakeService` where
**no test could reach it**: the integration tests drove a `storeFor` written in the test file by
the same hand as the assertions. The two had already drifted — production's `findOpenFindings`
ended `LIMIT 5000` and the test's had no limit, so no test could reach that boundary. One
disagreement found by reading means the set of disagreements was not known to be empty.

**`MAX_FINDINGS_PER_TICK = 5000` is now a named constant.** It is the second half of the
first-run bound: a tick reads at most 24 hours of findings AND at most 5000 rows. Anybody
forecasting a first run needs both numbers, and the second one used to exist only inside a SQL
string. The bound is correct and is not to be removed — an unbounded read inside an admission
budget spends the budget collection shares.

⚠ **THE INTEGRATION FILES SHARE ONE DATABASE AND MUST NOT RUN IN PARALLEL.** Measured: run
together they failed two or three of seventeen and which ones varied; run one at a time they
pass. They now take a **PostgreSQL session advisory lock** (`INTEGRATION_GATE`) in a `before`
hook rather than relying on `--test-concurrency=1`, because CI's command is
`find … | xargs tsx --test` with no flag — a constraint satisfied by a habit is not satisfied.
A new integration file in this area must copy that block.

**`runOnce` returns null for a failure and null for a deliberate refusal, and that is correct** —
the caller's only sane response to either is to let the collectors run, and giving it a choice it
must not make is worse than giving it none. The consequence is written where it is paid for:
**check the database, not the report.**

### The raw bytes now reach the handler, and a genuine signature would have failed every time

**The verifier was correct and the pipeline that feeds it was not.** `main.ts` created the Nest
application with no options, so `req.rawBody` was undefined. A handler could only re-serialise the
parsed body — and re-serialising does not reproduce what arrived. **Measured here, not relayed:**
a real Nest app over a real socket, a body with two spaces after each comma, and the genuine
signature verifies over the raw bytes and is refused over the rebuild. Not intermittently. Every
time, reading like a wrong key.

`HAWKVIEW_NEST_OPTIONS` in `bootstrap-options.ts` now carries `rawBody: true`, and `main.ts` and
the test read **the same object** — a test asserting against its own literal would prove nothing
about the application that ships.

**No test could see this**, verifier tests included, because every one of them handed `verify()`
the raw bytes directly: the half that already worked. The property lived in the seam. Third time
in this feature that the untested thing was the join rather than a part.

⚠ **What it costs:** one extra buffer per parsed request body, on every route rather than only
the webhook. Bounded by the body-parser's size limit, and inbound bodies here are small — the
memory pressure in HawkView is Graph responses going out. A route-scoped parser would have been
narrower and does not work: Nest registers its parsers at creation, so anything scoped runs after
`json()` has consumed the stream and silently sees nothing.

### Two things reported as missing that already exist

Recorded because building them again is the cost of not checking.

**The suppression row already carries its cause.** `alert_suppressed_addresses` has `message_id`
(which message proved it), `because` (the provider's words, verbatim) and `first_suppressed_at`
(when), with a CHECK that refuses a machine-made suppression carrying no message. So "after a
restart you know an address is dead and not which message killed it" is not the current state —
it was the state before `20260913040000`, and that migration's provenance check is the thing that
closed it.

**`alert_send_attempts` persists what reached a provider.** ACCEPTED, REFUSED_RETRYABLE and
REFUSED_PERMANENT, per message, per attempt. What is genuinely absent is the provider's *later*
verdict — delivered, bounced, complained — and that is now worded as **delivery outcomes are not
persisted** rather than as an absent ledger, because a blocker a reader can disprove on sight
teaches them to skim the rest of the list.

### A fix can be real and its binding unguarded — the fifth instance, in the commit that closed the fourth

**`rawBody` was correct and nothing tied it to the application.** The options lived in a shared
constant and `main.ts` passed it, so the tests guarded *removing `rawBody` from the constant* and
guarded nothing about `main.ts` continuing to pass it. **Measured by QA and reproduced here:**
reverting `main.ts` to the bare `NestFactory.create(AppModule)` typechecked clean — the import
simply became unused — and all three bootstrap tests stayed green.

Closed by removing the class rather than the instance: `createHawkviewApp()` in `bootstrap.ts` is
**the only `NestFactory.create` call in the codebase**, `main.ts` is an entry point that chooses
nothing, and the tests boot through the same function. Both halves are now mutation-checked —
dropping the options at the create call and removing `rawBody` from the constant each fail three
of four tests.

**The one test that still calls `NestFactory` directly does so deliberately**, because it exists
to show what the *other* path does; going through `createHawkviewApp` would make it prove nothing.

### A guard that lives in a bystander is not a guard

`TYPE_FOR_SHAPE` ended in `as Readonly<Record<KeyShape, …>>` over a `Record<string, …>` literal,
so an eighth `PublicationKind` would not have been required in it and the lookup would have
returned `undefined` where every consumer's type says `string | null`.

Adding a member *did* fail the build — but the error named `byShape`'s literal 476 lines away, an
unrelated construct that happens to be exhaustive. **The protection was real and it was
accidental**, and the natural refactor of building `byShape` in a loop would have removed it
silently, leaving the cast as the only thing standing. The literal is now typed and the cast is
gone; measured, the error names the table itself first and the bystander second.

### Four functions have been written correct, tested, and unreachable

Worth naming because it is now four, and the fourth asserted its own caller in prose.

| | state |
|---|---|
| `cancelStatement` | had no caller — a release precondition that could not be pressed. **Closed**: `scripts/alerting-cancel.mts` |
| `alertTierFor` | had no caller **while its own comment said the API returned it**. **Closed**: wired into the notification list DTO |
| the suppression store | had no caller. Still has none — nothing drains the queue |
| the send queue | `claimStatement`, `attemptSend`, `beginAttempt`, `afterAttempt` all at zero callers. **Open**, and first on the missing list |

Each time the function was correct and tested; each time the commit message described the
capability rather than the wiring. **Before writing a comment that says something is returned by
the API, grep for the caller.** A comment is a claim, and this one was false for a commit — the
DTO sent the legacy five-value severity and no tier, so the inbox rendered no badge for every
alert-backed row, always, and nothing failed because no test asked the wire what it carried.

**The tier could not have been recovered at either end.** `critical` is not exclusive to alerts:
`tenant-sync.service.ts` publishes a lost Microsoft connection at `critical` through the same
`publishIncident`, on rows that exist in production today. Any scheme inverting severity into a
tier badges a disconnected tenant as ACT_NOW. That is why it travels as its own field, and there
is a test with a real collector row at `critical` beside a real alert at `critical` — a mutation
that derives the tier from severity fails it.

⚠ **`resolved` is already in the DTO** (`resolved: Boolean(row.resolvedAt)`), so a cleared
incident looking identical to a waiting one is a rendering gap on the client, not a missing field
on the wire. Reported as backend-side; measured otherwise.

### The settings page: what a disposition reaches, and two rulings that contradict

**Derived, not counted** — `alert-type-reach.ts`, with a test, because this count has already been
got wrong by hand once and a ruling was then built on top of it.

| | |
|---|---|
| **2 of 7** types have a setting that is consulted | `security.suspected_credential_attack`, `security.privileged_directory_change` — the two the guidance mapping reaches |
| **5 of 7** have **no producer** | nothing writes a notification carrying them, so a setting cannot bite either way |

⚠ **THE "PRODUCED BUT IGNORED" CASE DOES NOT EXIST, and this matters because a ruling assumed it
did.** `tenant-sync.service.ts` and `tenants.service.ts` publish seven notification kinds and an
MSP does receive them — but **none carries a catalogue alert type id.** They publish
`tenant.connection_lost`, `tenant.sync_failed`, `tenant.connection_authorized`,
`tenant.connection_failed`, `tenant.connection_permissions_missing`, `tenant.sync_recovered` and
`security.directory_change`, in a different namespace, with `alert_type_id` NULL. Measured: every
reference to the five unproduced catalogue ids lives inside `src/alerts/`, none in `src/tenants/`.

So *"make the publish path read the disposition for that alert type"* asks it to look up a type it
does not have. `reconciliation.ts` does classify those dedupe keys into catalogue types, so the
mapping is not unknowable — **but it lives in the step-03 apply phase, and copying it to the
publish site is the two-homes defect this feature has fixed three times.** This needs a ruling on
the mapping, not a lookup somebody can add.

### The catalogue owns which publication kinds each type covers

**One event was wearing two names.** `tenant.connection_lost` and `monitoring.tenant_disconnected`
are the same thing; so are `tenant.sync_recovered` and `monitoring.recovered`. The bridge between
them existed — `reconciliation.ts` held a `TYPE_FOR_SHAPE` table — but it was keyed the wrong way
round and in the wrong module: the answer to *what does this alert type cover* lived where types
are consumed rather than where they are declared, so a type could be added without anybody being
asked, and the answer sat where its author would never look. **The two-homes shape, moved for the
fourth time in this feature.**

`AlertTypeDeclaration` now has `covers?: readonly PublicationKind[]`, beside the id and the
severity where category and subject already live. `TYPE_FOR_SHAPE` reads the catalogue.
`KeyShape` is an alias of `PublicationKind` — the members and meanings are unchanged; only the
declaration site moved. Parsing which shape a key *is* remains this module's job; deciding which
type a shape *becomes* is not.

**A kind covered by two types does not compile.** `FirstDuplicate<CoveredKinds<…>>` over the
`as const` catalogue, the same move as the alert-type-id length bound. **Verified by mutation:**
giving a second type `TENANT_CONNECTION` fails with *Type 'true' is not assignable to type
'"TENANT_CONNECTION"'* — the error names the offending kind. Two types claiming one kind means a
published notification has two answers to *what is this* and whichever the lookup finds first
wins, which is unresolvable at runtime and silent.

**Committed alone, and proven behaviour-preserving.** The test asserts the derived table against
**the literal it replaced**, written out in full, rather than against itself — a derived table
compared with itself agrees by construction. Reconciliation is already verified against production
figures, so if moving its table changed a result it had to be visible in that commit rather than
found later tangled with a new lookup in the collector.

⚠ **THIS DOES NOT YET MAKE ANY SETTING REACH A TENANT-SYNC ALERT.** The mapping now exists in one
place; the publish path still does not consult it, and doing so depends on a question nobody has
answered — see the two open questions above. Under the reading that is currently built
(`RECORD_ONLY` leaves the notification visible in-app), consulting the disposition in
`publishIncident` would change nothing at all, because that path produces an in-app notification
and never an email.

### The dispositions endpoints, and the disposition is now the tier

`GET /api/alerts/dispositions` and `PATCH /api/alerts/dispositions/:alertTypeId`.

**THE COLUMN'S VOCABULARY CHANGED, and this is the part to know.** `disposition` held
`RING | EMAIL | DIGEST | RECORD_ONLY` — a `DeliveryPreference`, which is *how* somebody is
reached. It now holds `ACT_NOW | ACT_TODAY | RECORD_ONLY`, the catalogue's `Severity`: the
organisation answers *what counts as urgent here* and the product answers *how we reach you about
something that urgent*. `defaultDispositionFor` is now the declared severity itself rather than
`defaultPreference(severity)`, which removes a second spelling of one judgement.

⚠ **`RECORD_ONLY` IS IN BOTH VOCABULARIES, so a half-done change looks healthy.** Every test that
exercises *off* passes under either spelling; only RING, EMAIL and DIGEST would be wrong. Changed
in one place while the table has never been deployed. **DIGEST has no tier and that is a loss** —
an MSP can no longer ask to be batched. If digesting returns it belongs beside quiet hours as a
delivery preference, not as a fourth urgency.

**`mapped` is derived, not listed.** It comes from `alert-type-reach.ts`, so when the publish path
lands the number moves without anybody editing a table. Two of seven today.

**An unreadable stored value is reported, never defaulted away.** `disposition` states what will
actually happen — the catalogue default, because an unreadable value never reaches the lookup, and
that is true — and `storedValueIgnored` carries the stored string verbatim so the row cannot look
as though nobody had chosen. Tested by dropping the CHECK, inserting the old vocabulary, and
restoring it, which is the only honest way to reproduce a state the database now prevents.

**The write refuses a value outside the vocabulary and an id the catalogue does not declare**, and
writes nothing in either case — including `HV-ID-AUTH-010.v1`, the rule id that used to be
accepted and silently ignored. Membership is checked the same way `NotificationsService` checks
it, against a real second organisation rather than an id that does not exist.

⚠ **THE SETTING STILL ONLY BITES FOR TWO OF SEVEN TYPES.** The endpoint is honest about that
through `mapped`; it does not fix it. The publish path is the other half and is still blocked —
see the open question below.

### ⚠ ONE OPEN QUESTION REMAINS, and it blocks the publish path

**Question 1 is now ruled and built: the disposition is the TIER.** It was restated three times and two sessions were blocked on it, so it is taken as decided; the column, the default and the endpoints all follow it. Question 2 is still open and now gates the publish path alone.

**1. Is the disposition a channel or a tier?** The column is CHECK-constrained to
`RING | EMAIL | DIGEST | RECORD_ONLY` — a `DeliveryPreference`, derived from the catalogue's
`Severity` by `defaultPreference`. A contract specifying `ACT_NOW | ACT_TODAY | RECORD_ONLY` needs
the CHECK changed and `defaultDispositionFor` rewritten; writing to the column as it stands
violates the constraint. **`RECORD_ONLY` is in both vocabularies**, which is why the confusion
reads plausibly and why a half-done change appears to work for the one case everybody tests.

**2. Does `RECORD_ONLY` hide an alert in-app, or only stop the email?** Two rulings disagree:

- *"the incident row still exists so the history is intact, and no notification and no job are
  produced"* — off means invisible in-app too.
- *"RECORD_ONLY is off — recorded, **visible in-app**, not delivered"* — off means email only.

**As built, the second holds**: `RECORD_ONLY` writes the notification and no send job. That is
tested for the adjacent `NO_ELIGIBLE_RECIPIENT` case and **not directly tested for `RECORD_ONLY`
itself.**

The two readings are not interchangeable now that a further ruling depends on them. *"Silencing
tenant-disconnected must stop them arriving"* requires the first; `publishIncident` produces only
an in-app notification and never an email, so under the second reading, making it consult the
disposition **changes nothing at all** — the settings row would still be decorative for exactly
the types it was meant to fix.

### Still missing before anything can send

- **NOTHING DRAINS THE QUEUE.** There is no sender worker: `attemptSend` has no production
  caller, nothing calls `claimStatement`, and `SendPermit` is produced only inside tests. Intake
  writes `alert_send_jobs` rows on every tick and **no code path ever reads one.** This is the
  same defect the intake half already had and fixed — *the chain was joined by the test rather
  than by the product* — surviving in the other half, and it is the single largest gap on this
  list: a real transport would change nothing on its own, because nothing would call it. Grep
  that establishes it: `grep -rn "attemptSend" src --include=*.ts | grep -v test` returns only
  the definition.
- **A real transport.** Deliberately absent; see above. Second on this list, not first.
- **A ROUTE FOR THE WEBHOOK VERIFIER — AND IT MUST CARRY `@Public()`.** `auth.module.ts`
  registers a global `APP_GUARD`, so a controller without the decorator answers **401 before the
  handler runs**, and Resend sends no bearer token. A webhook route written without it would fail
  every genuine delivery, permanently, and read like a provider problem — the rawBody defect one
  level up, and equally invisible to any test that calls the verifier directly. Written down now,
  while the route is unbuilt, because the moment to remember it is before it is written.
  **The opposite holds for the dispositions endpoints**: those are correctly NOT public, and an
  organisation-scoped write that skipped the guard would be worse than a webhook that 401s.
  The verifier is built and tested; *nothing calls it.*
  There is no `@Public() @Post('resend')` controller, so the verdict has a producer and no
  caller. Whoever writes it must hand the verifier the RAW body — `req.rawBody`, which is now
  available (see below); a parsed-and-restringified one changes bytes and every genuine request
  reads as `SIGNATURE_INVALID`, permanently, which looks like a key problem and is not.
  **The route's test must drive the real pipeline**, because a verifier test that supplies its
  own bytes is testing the half that already works.
- **DELIVERY OUTCOMES ARE NOT PERSISTED** — *not* "no ledger", which reads as though nothing
  about sending is recorded and is false. `alert_send_attempts` exists and persists ACCEPTED,
  REFUSED_RETRYABLE and REFUSED_PERMANENT against a message. What has no table is the provider's
  later verdict — DELIVERED, BOUNCED, COMPLAINED — plus unmatched events and retries, which
  `email-delivery.ts` builds as in-memory `Ledger` values. Until those exist a webhook route
  would authenticate an event and then discard it.

Built since this list was first written, and no longer on it: the webhook verifier itself, the
`emailEnabled` switch with absence reading as off, the stop button, and the suppression store.

### Intake will not run until somebody chooses the watermark

**`HAWKVIEW_ALERT_WATERMARK_ISO` is unset, so alert intake is a no-op on every tick.** That is
deliberate and pre-authorised: nobody has chosen the instant before which nothing is sent, the
only guess available is *now*, and taking it silently would mean the first tick after a deploy
decides for ever which historical findings were never worth telling anybody about.

**A refusal is recoverable; a guess is not.** An unparseable or empty value is also a refusal —
a typo must not become a decision, and that direction fails open: `Date.parse` of nonsense is
NaN, and every comparison against NaN is false, so every historical finding would have been sent.

The log line says `NOT_CONFIGURED` and names the variable. **Setting it is the switch that turns
the pipeline on**, and it is the one remaining decision between here and alerts being produced.

### Reading is bounded to 24 hours, so history is not backfilled

`HAWKVIEW_ALERT_READ_WINDOW_HOURS` defaults to 24 and is capped at 168, because a tick has an
admission budget and reading the whole table every five minutes would spend it. **The consequence
is that findings older than the window never receive an incident row from ordinary ticks.**
Backfilling them is a separate one-off job that does not exist.

### The blocker in the flow is fixed, and the fix was checked against the thing that would have made it worse

Text from QA, applied here rather than left on their branch: **a replacement status living
somewhere else is a second home for the status**, which is the shape this feature has hit three
times in the code.

`runIntake` wrote incidents, checked its budget, then wrote jobs. A yield between them left an
incident with no job, which every later run skipped as `INCIDENT_ALREADY_OPEN` — the alert never
sent and nothing reporting it, because `neverSent` reports jobs that stopped and this one never
had a job. Fixed in `5b0883b` by one `commit(incidents, jobs)` with the budget check before the
write phase.

**The acceptance test was not “did the stranding stop”.** Four shapes produce
incident-with-no-job — `BEFORE_WATERMARK`, `RECORD_ONLY`, `NO_ELIGIBLE_RECIPIENT` and the
yield — and three must stay silent forever, so a fix that could not tell them apart would have
delivered the entire backfill. QA seeded all four at once across two organisations: exactly one
job came out, with the three silences each named, and killing the backend mid-transaction left
neither row.

**And the engineer’s first test for that fix did not test it.** It passed a deadline already in
the past, so the run exited at its first budget check and never reached the write phase — green
against the reinstated bug. Found by mutation, not by reading, and fixed with an injected clock
plus an assertion that the run reached the path at all. **That is the second time in two commits
that a test asserted the right thing about a path it never executed.**

### Six catalogue rules produce nothing, by decision

Since `1ffc88e` the rule mapping derives from `investigationGuidanceCode` rather than a rule-id
prefix. `REVIEW_CONFIGURATION` and `REVIEW_MAILBOX_RULE` map to no alert type, so those findings
produce **no incident and no job**, each named individually with its reason and their rule ids
surfaced in `unmappedRules` — which is what somebody has to go and add.

**Two earlier versions of that mapping were wrong in two different ways and both would have
shipped.** The first matched a namespace no row can have. The second matched the real families
and guessed their meaning from the letters: `HV-ID-EXP-001.v1` is an MFA enforcement gap, so EXP
is EXPOSURE, not expiring, and a whole family would have routed as `monitoring.consent_expiring`.
That version was consistent, total over the real vocabulary, and wrong.

### The ten lock-ordering failures are environment; the ordering is unproven

**Not “lock ordering verified”.** These failures do not demonstrate the ordering wrong, which is
not the same as demonstrating it right — nothing exercised it successfully, because the
transactions did not survive long enough to try. Not a blocker: the alerting pipeline reads
`identity_risk_findings` directly and never touches the key store. **QA’s classification,
relayed; the engineer has not investigated it.**

### The accounting invariant is a tripwire, not evidence the routing is right

`accountingProblems: []` means every finding appears exactly once across the jobs and the skips.
It is a self-reconciliation over one pass: **it proves nothing vanished, and it cannot prove
anything was classified correctly.** A finding wrongly skipped as `RECORD_ONLY` counts exactly
once and the books still balance.

It catches a future edit that adds a `continue` without a skip, which is worth having. **It must
not be cited as a second line of evidence that delivery decisions are right, because it is not
evidence of that at all.**

### Database-integration tests HAVE now been run — and the count is not reproducible

This section used to say **"96 tests, zero runs"**. Replaced rather than deleted, because the
warning it carried still stands: **the 1696 passing figure does not cover this suite**, and the
apply phase is exactly the work where it would matter most.

They have been run, by QA and independently by the engineer, against disposable PostgreSQL 15.
**The failures are environment, not product defects, and none has been shown to be a defect —
none should be quoted as one.**

**But do not quote a pass count either.** Nine samples across two machines on one commit: 45,
then 27, 22, 29 by the engineer, then 22, 22, 11, 15, 14 by QA on one cluster with identical
inputs. **The suite has no reproducible number.** Writing the environment down does not fix
that, which is why it is worse than a missing document.

**THE ALERTING INTEGRATION FILES ARE NOT PART OF THAT, and must not be discounted with them.**
`finding-pipeline.database-integration.test.ts` (11 tests),
`in-app-visibility.database-integration.test.ts` (3) and
`suppression-store.database-integration.test.ts` (3) pass **17/17** against a freshly
`migrate deploy`-ed PostgreSQL 15, created and destroyed inside the session. They share the
harness but not the wall: they touch no KMS and no risk key store, and they have been green on
every run. The unreproducible numbers above are the identity-risk suite. **Two different suites,
two different states; a reader who takes one figure for the other will either trust the alerting
evidence too little or the identity-risk evidence far too much.**

**AND THAT IS A DESCRIPTION OF THE VARIANCE, NOT AN ACCOUNT OF THE FAILURES.** An earlier
version of this section said “one speed-sensitive suite sampled four times” as though that
explained them. It does not. *Timeout expired* accounts for only 5 to 18 of 133 to 155 failures,
so **the cause of the large majority is unidentified and nobody has looked.**

The distinction is the one already enforced on the lock ordering — classified as environment,
ordering unproven. **An account that explains a tenth of the failures is not the account.** That
suite is not on the release path, so nobody is hunting the rest; what must not happen is a
reader taking the variance framing as a diagnosis.

**The wall is a timeout that a catch-all was hiding.** `IDENTITY_RISK_SOURCE_UNAVAILABLE` is
thrown from twelve places; every failure came from the twelfth, a bare catch that discarded its
cause. Since `2e4cc54` it carries the cause, which reads *timeout expired*. QA reports
`wrapped-risk-key-store.ts` has four more bare catches — lines 124, 138, 143 and 174 — while
the twelve other `keyUnavailable()` calls there are guarded throws that must not be touched.
**That is QA’s reading, relayed; the engineer has not opened that file.**

**The other prerequisite is not configuration at all.** `IDENTITY_RISK_KEY_UNAVAILABLE` wants an
AWS KMS key ARN and a live `KMSClient`. No document makes that green on a laptop; it needs
real KMS or a substituted `ManagedMacTransport`, and which of those the suite may use is a
decision nobody has taken.

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

**The commit stream on the remote is not the work.** At the time of writing, five commits
exist locally that the remote does not have — the apply shape, the EXHAUSTED ruling, the
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

## Immediately next

1. **The apply phase.** Shape is in `docs/alerting-apply-shape.md`; the code is not written.
   **Re-run the dry run first and confirm the figures still match what was approved** — as of
   2026-09-12: **366 rows, 319 awaiting the classifier, 3 permanently unwritable, 44 writable.**
   The apply refuses to write if they have drifted.

   **The figure that used to stand here was "364 rows, 71 episodes".** That was a conflation:
   71 is the count of INCIDENTS IN THE DATA under the nominated type, which is a different
   question from how many rows the mapping authorises. It reached a status report as though it
   were a write count. It matters more than an ordinary stale number because **the apply refuses
   on drift** — so a reader who meets that refusal while holding the wrong expected figure will
   doubt the data rather than the document.
2. **The limit function**, which unbinds L1, L2 and L4.
3. **Step 06, email.**

**Two of those need production access this worktree does not have**: re-running the dry run,
and the apply itself. They need Dharmik directly rather than relayed — an approval reported
second-hand is enough to build against, and has not been treated as enough to write with.
