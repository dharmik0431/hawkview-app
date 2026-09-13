# Alerting — the release statement

**One page to decide from.** The readiness document is the reference; this is the judgement.
Everything here was measured by QA against the commit named below unless it says otherwise, and
where something was not measured it says so rather than reading as covered.

---

## The commit

**`7530528`** — the tip of `agent/alerts-step-01`, **and it is pushed.** The remote branch is at the
same commit, so what ships is what was checked. Anybody can re-run the check:

```bash
git ls-remote origin agent/alerts-step-01
```

Verified at the time of writing. It was *not* true an hour earlier — four commits were local-only —
so if the tip moves again, run it again rather than trusting this line.

The behaviour below was measured at `b9187d3`; `7530528` and `ee8ab98` on top of it change
documentation only.

## What is in it

- **Intake.** Reads open findings, writes incidents and in-app notifications, queues send jobs.
- **An in-app inbox and bell**, carrying the alert type and the tier the organisation chose.
- **An alert settings page** where an MSP sets what counts as urgent per alert type.
- **A fleet Risky Users screen and a dashboard queue** that now say how much of the fleet they
  actually looked at.
- **Ten migrations**, all additive or widening; none drops a column or rewrites a row.

## The one thing that outranks everything else

**Production holds zero identity-risk findings.** The risk engine has run thousands of times and
matched nothing, ever. *(Measured in production, read-only, by PM. I have no production access and
did not confirm it.)*

So a completely correct release of this feature **delivers no email at all** until that changes.
Nothing below should be read as "MSPs will now be told about things". What ships is the **record**,
and the plumbing that would carry a telling if there were anything to tell.

---

## What was verified, and how

| | |
|---|---|
| **Alerting unit tests** | 27 files, **360 tests, 360 pass, 0 fail, 0 skipped** |
| **Database-integration tests** | four files run **one at a time** against a real Postgres 15 — `alert-dispositions` 5, `finding-pipeline` 15, `in-app-visibility` 5, `suppression-store` 3. **28 tests, 28 pass, 0 fail** |
| **U1, end to end** | an HTTP `PATCH` through the real settings endpoint, then a tick, then the rows it wrote. `RECORD_ONLY` → **0 jobs**; no setting → 1 job. The auth path is real, not stubbed: a generated keypair served as a live JWKS, so the guard, the verifier and the membership check are all shipping code |
| **The endpoint's guards** | not public — no token, a forged token and a single-factor token all refused; five bad writes refused 400/403 and **none wrote a row**; the database refuses an out-of-vocabulary value itself |
| **A setting that cannot take effect** | named at **both ends** — on the settings page and in the intake report — and the output follows the key rather than emitting a constant |
| **Failure reporting** | a fault injected at each phase in turn: each names its own phase, a yield is not a failure, and the work reported lost equals what a healthy run over the same input wrote |
| **The webhook byte path** | a real Nest pipeline over a real socket: wire bytes arrive byte-identical, a genuine signature authenticates **in the handler**, a re-serialised body and a tampered body are refused |
| **Migrations** | four databases migrated by four different routes, **whole schemas compared** — columns, checks, keys, indexes, applied migrations. All converge on a fresh migrate; rows in the old vocabulary are translated with none dropped; a second deploy is a clean no-op |
| **The screens** | the real pages rendered and read as a person would see them, **icon included**, over fixtures written before the code existed |

**And the single strongest line.** The reconciliation output at the tip is **byte-identical** to the
reference taken before any of this work began — md5 `0e21845b…`, 446,132 bytes. Every
classification, every mapping row, every incident count is unchanged. **The step-03 figures that
were approved against production survived a full day of changes and a branch merge**, measured
rather than assumed.

---

## What is NOT verified, and cannot be by a machine

**Four checks need a person, and nothing in this release can close them**, because no sender exists
and no email can leave:

1. **Send twice, one arrives.** 2. **A human opens the email** and writes down what actually
arrived. 3. **A genuine provider signature still verifies** at the configured endpoint.
4. **A real hard bounce** lands on its job.

**Four more need a person for a different reason** — they are about what a reader takes away, which
is not a thing a renderer can confirm about its own output:

5. **The three in-app surfaces**, in order, bell first. 6. **Turning an alert type off and on
again**, by hand. 7. **The empty states**, which is the state this ships in. 8. **Lowering a tier
while in-app notifications are muted.**

**Passing 5–8 while 1–4 are unrunnable means the record is trustworthy. It does not mean anybody
has been told.**

### And the frontend suite is not green

549 tests, 498 pass, **51 fail** — all in one file, `lib/identity-risk/risky-users-ui.test.ts`.

**They are pre-existing.** The same file on `origin/main` fails identically, so nothing in this
release caused them. **They are stale assertions, not a defect anybody caught**: the tests describe
the page as it was before a rework and the component was replaced without them. **The tests are red
because they describe a different page, not because they found something** — and a failing check is
evidence about the check until somebody looks at the subject.

**What is worth a decision** is that those 51 guard a **per-tenant** surface — *"the surface never
claims a user is safe"*, *"a zero is never rendered alone"*, *"no raw Microsoft identifier is ever
painted on screen"* — **on a component this release does not change and today's instruments never
rendered.** The same property family was re-established today on the **fleet** screen, by rendering
and by register. That is a different component. Nothing implies the per-tenant section is broken;
nothing establishes that it is fine.

---

## The one open product decision

**The publish path was specified and deliberately not built**, because building it would have
required choosing between two meanings of *off* that are both already in the product — and because,
under one of them, it would have done nothing at all while looking like a control.

**Both halves are measured, by me, today:**

- **Intake's `RECORD_ONLY` writes the incident and the in-app notification and withholds only the
  send job.** Measured: 1 incident, 1 notification, **0 jobs**. So *off* there means **not emailed,
  still visible in the product**.
- **The tenant-sync publish path cannot produce an email at all.** `publishIncident` upserts a
  notification row and nothing else; `notifications.service.ts` references send jobs **zero** times.
  So withholding a publish would mean **not visible at all** — the opposite meaning.

**And the consequence that matters more than the inconsistency.** Making the publish path consult
the disposition would have withheld *an email that does not exist*. Reach would have gone from two
alert types to **two**, not to seven, while the settings page showed a control over five more that
did nothing. **A control that looks live and is inert is worse than an absent one**, and this
release does not ship one.

**What the decision is:** when an MSP silences a tenant-connection alert, should that stop an email
they are not currently receiving, or stop the thing appearing in HawkView at all? It is a product
question, not an engineering one. Once it is answered the work is about a day.

## A finding this work surfaced, which is not part of it

**Two of five tenants have no sign-in evidence since 2026-09-10 and 2026-08-30, and both report a
current collection time**, because the code stamps the window it *requested* rather than what came
back. *(Measured in production by Engineer 2; recorded at `4492d67` in `docs/sign-in-evidence-gap.md`.
I have not confirmed the production figures and have no production access.)*

It is independent of alerting and true today. It belongs here because it bears on the sentence at
the top of this page: **a fleet that reports itself current is not necessarily being looked at**,
and the zero-findings figure sits downstream of exactly this collection.

## What is deliberately absent

- **Routing and channel.** A setting changes what the product *shows* — `ACT_TODAY` on a type the
  catalogue calls `ACT_NOW` renders as `high` rather than `critical`, `RECORD_ONLY` silences the
  send entirely. It does not change *how* anyone is reached. Both non-silencing tiers queue the same
  job.
- **SMS.** Deferred.
- **Delivery outcomes are not persisted.** A job's fate after it leaves the queue has nowhere to
  land.
- **Six detectors produce no email, by decision** — their findings map to no alert type and are
  reported as unmapped rather than defaulted. Refusing to invent a type is correct; it also means
  *"we detect it"* and *"you will be told"* are different sets.
- **A setting reaches two of seven alert types**, not seven. That is the open decision above, and
  the number should be stated rather than left to be inferred from a settings page that lists all of
  them. The five it does not reach are the tenant-sync family.

---

## The limits that should not be rounded up

These are the places where a true sentence would mislead if read quickly. They are here because the
rest of this page is a list of things that passed.

- **A green check on an empty input is not evidence about a full one.** Several invariants balance
  or enumerate nothing when there is nothing to balance. They have never had the chance to
  discriminate, and production — with zero findings — is exactly that empty input.
- **`accountingProblems` being empty means nothing vanished. It does not mean anything was
  classified correctly.** It is a conservation check, not a correctness one.
- **"The application serves"** is not what was established. Three public routes and three guarded
  routes were observed answering; the guarded ones were observed *refusing*. That is a narrower
  claim than a working application and it should stay narrow.
- **A migration convergence proves the schemas agree.** It says nothing about whether the data in
  them means what anybody thinks.
- **Reachable is not reached**, and a probe that finds nothing is not the same as a subject with
  nothing in it. Three times today a check reported a pass because the instrument had missed;
  every claim above is gated on something whose wrong value is obviously wrong.

---

## The judgement

**What ships is sound as a record, and nobody has been told anything yet.** Every mechanism that
was checked behaves as its authors say, including several that did not a few hours ago; the
approved step-03 figures are provably unchanged; and the two things a reader would most easily be
misled by — a green shield over an unassessed fleet, and a saved setting the product ignores — are
both closed and were both verified by instruments that did not share an author with the fix.

**The most encouraging thing on this page is not a passing test.** It is that the last substantial
piece of work was **cut rather than built** — because building it would have shipped a control that
looked live and did nothing. A team that stops on a contradiction it found in its own instructions,
a few hours before a deadline, is the reason the rest of these results are worth reading.

**Two things need a decision, neither of them a defect in the work:**

1. **Which meaning of *off*** the settings page should have for the five alert types it does not yet
   reach. Until that is answered, the honest statement to anyone using the page is that a setting
   governs two of seven.
2. **Whether the 51 stale guards** on the per-tenant surface are acceptable to carry, knowing they
   cover a component this release does not touch and that nothing has examined it since the rework.

**And the sentence to keep in mind while deciding:** this release makes HawkView able to say things
correctly. Whether it has anything to say is a question about the risk engine — and the collector
finding above is a reason to treat that question as open rather than settled.
