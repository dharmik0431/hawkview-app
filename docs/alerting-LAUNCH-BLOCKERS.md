# Launch blockers — QA's call, with reasons

**This is judgement, not measurement, and it is mine.** Every item below is something I ran or
read at `d9de7b9`. Where I could not establish something it says so rather than defaulting to
blocking. Dharmik asked for genuine blockers only, so the bar I applied is deliberately high.

## The rule I used, and one amendment

PM's rule: **a blocker is anything that makes the flow wrong, silent, or unrecoverable.** I
accept it — it is better than "severity", because it names consequences an MSP experiences
rather than how alarming a defect looks.

**I would amend it in one way: a false claim of a safety guarantee is a blocker when the claim
is load-bearing and the thing it guards has not been built yet.** Not because the code is wrong
today, but because the next person builds on the claim instead of checking it. That is not
hypothetical here — see B2. A defect, and a wrong comment about a defect, are different
problems, and the second one scales.

**And one scoping note:** "wrong, silent, unrecoverable" has to mean *reachable at launch*. A
defect needing a state the launch cannot produce is backlog, and I moved two of my own findings
there on exactly that ground.

## B1 — Step 0 wedges a half-migrated database. Unrecoverable.

`20260912120000_notification_incident_key` uses bare `ADD COLUMN` and `CREATE INDEX` with no
`IF NOT EXISTS`. Against a database that already has the columns it fails `42701` and leaves a
failed-migration row that blocks **every subsequent migration** with `P3009` until somebody runs
`prisma migrate resolve` by hand.

**Reachable, and partly my doing.** The workaround DDL I published in the first-run record puts
an operator in exactly that state. So does any earlier partial attempt.

**Why blocker:** it is the one step that changes schema rather than data, Dharmik runs it once
and alone, and the failure mode is not "try again" — it is a database whose migration channel is
stuck. Fix is one line per statement.

## B2 — `AuthenticEvent` can be forged, and the comment says it cannot. Wrong, and silent.

`email-delivery.ts` states *"The only way to make one is `authenticate`"* and *"a forged event
has no path to producing one."* **Both are false.** `__authentic: true` is an ordinary
structural field, not a `unique symbol` brand — unlike `MessageId`, `ProviderMessageId`,
`IdempotencyKey` and `OperatorAddress`, all branded properly in the same file.

Verified rather than reasoned about: a hand-written `AuthenticEvent` that never passed through
`authenticate` compiles clean.

**Why blocker, though nothing is exploitable today.** There is no webhook handler yet, and that
is exactly why this is the moment. The handler will be written against a comment promising that
unverified events cannot reach `record`, and the compiler will not enforce it. The result is an
endpoint that marks our own messages DELIVERED on anybody's say-so — a false statement in our
records, and the silent kind, because a forged "delivered" looks like success.

Fix is one line, using the brand pattern the file already uses everywhere else.

## B3 — The evidence Dharmik asked for cannot currently be produced. Blocks the decision.

A blocker on the rollout rather than on the code, flagged separately for that reason.

He asked for end-to-end test results before rollout. The gated database-integration suite is the
part that would cover persistence — and **I ran it for the first time and could not get it to a
meaningful result.** 42 pass; the rest fail on environment prerequisites
(`IDENTITY_RISK_SOURCE_UNAVAILABLE`, `IDENTITY_RISK_KEY_UNAVAILABLE`) that no document I could
find specifies in full. One documented trap — the server must be in UTC — I hit and fixed, and
it moved eleven tests, which is evidence the remainder are environment rather than product.

**I am not reporting those failures as defects.** I am reporting that the suite has no runnable,
documented setup, so "we ran the integration tests" is not a sentence anybody can currently say
truthfully.

**Why blocker:** a suite nobody can run is not a safety net, and the release checklist asks for
its output.

## What is NOT a blocker, and why I am saying so explicitly

- **The flow being unwired is the work, not a defect.** Intake returns a state nothing persists,
  route returns an outcome nothing sends. That is the launch scope; listing it as a blocker
  would confuse the deliverable with a fault.
- **319 rows awaiting the classifier** — a ruling, already made, already honestly reported.
- **`TENANT_INITIAL_SYNC` permanently unwritable (my F2)** — the runner now reports it as NEVER
  writable, which is the truth. What remains is a product decision, not a defect.
- **The 8-hop label reading NEVER where it should read UNKNOWN** — I checked reachability rather
  than assuming: recovery keys are built in one place and all four production callers pass a
  freshly-built non-recovery key, so maximum depth is 1. Unreachable. Backlog.
- **`previous` being all-null so A2 cannot be closed on this path** — a limit on what my evidence
  can establish, not a defect in the code.

### The one I argued with myself about

**The preflight merging two exclusion reasons into "322 left alone by decision."** The data keeps
all three apart and step 1 prints three lines; only steps 2 and 3 merge. It causes no wrong
write, so by the rule it is backlog.

**But I would do it before launch anyway**, and not on severity. This exact shape — two questions
reported as one number — already reached a status report on this feature and cost real time. It
is a one-line change to a document already being edited. Doing it now costs nothing; leaving it
re-arms a trap this team has already sprung once.

## What would make the acceptance demonstration honest rather than a happy path

Dharmik wants a real Risky Users finding reaching a real email. **A happy path proves the pipe
connects and almost nothing else.** These are properties a single successful send cannot show,
and they should be agreed **before** the demo is built — criteria written after seeing the output
will match the output.

1. **A negative control in the same run.** Something that must produce NO email — below
   threshold, wrong tier, suppressed by preference, quiet hours — and the run must show it was
   *considered and withheld*, with the reason. An absent email proves nothing alone: it looks
   identical to a pipeline that sent nothing at all.
2. **Start from the collector, not from an injected finding.** A demo that hands the pipeline a
   hand-built finding tests only what is below that point. The engine already produces findings
   every five minutes — use one it produced.
3. **Run the cycle twice.** The second must send zero and say why. Otherwise the first retry in
   production emails an MSP twice.
4. **Recompute the numbers in the email independently.** If it says three tenants are affected,
   something other than the composer must derive three from the database. Otherwise the figure is
   whatever the composer wrote.
5. **Exercise a failure, not only a success.** One send to an address that hard-bounces, with the
   webhook landing on the right job and moving it out of accepted. Until then DELIVERED and
   BOUNCED are one untested state with two names.
6. **Show the unresolved case.** A message accepted and never confirmed must appear in the
   unconfirmed report once the window passes. That silence is the failure family this feature
   exists to remove, and the one a happy path structurally cannot produce.
7. **Two organisations in the same run.** No cross-org leakage, and one org's volume must not
   silence another's. One message per MSP, not per tenant.
8. **Check the rendered message, not the model.** No identity in the body, confirmed on what
   actually arrived; the deep link resolves and demands authentication.
9. **Record the lag.** Finding time versus send time, stated — otherwise nobody notices for a
   month that emails describe a three-day-old state.
10. **A human opens the inbox and says what they saw** — sender address, rendering, link
    behaviour. A provider `202` is not a delivery, and this feature's whole thesis is that the
    difference matters.

**And write down in advance what counts as a failure.** If the demo produces something
unexpected, that has to be a finding rather than a footnote.
