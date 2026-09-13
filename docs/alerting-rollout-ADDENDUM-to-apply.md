# Merged rollout text — six sections to add to `docs/alerting-rollout-readiness.md`

**Engineer's document is in the right place and is the survivor.** Its blocker list is better
than mine was — it names the missing `rawBody` option and the absent ledger, which I had not
established. **This is not a rewrite.** It is the six things my `alerting-ROLLOUT.md` carried
that theirs does not, each with where it goes. **Once applied, `docs/alerting-ROLLOUT.md` on
`qa/bind-limits` is deleted** — it is being deleted in the same commit as this file, so there is
one home from now.

**No number disagreements were found.** Their identity-risk range of 11–45 contains every figure
I measured, and their 11/11 and my earlier ten-of-ten are the same suite at different commits —
five tests in one file then, eleven across two now. Both measured; neither corrected.

---

## A. ADD TO THE FIRST PAGE — the pipeline has nothing to carry

*Measured in production, read-only, by PM. I have no production access and did not confirm these.*

| table | rows |
|---|---|
| `identity_risk_evaluation_runs` | **7,365** |
| `identity_risk_matched_results` | **0** |
| `identity_risk_findings` | **0** |
| `notifications` | 366, across 7 tenants and 4 organisations |

**The risk engine has run 7,365 times and matched nothing, ever.** So switching alerting on —
with a perfect watermark, a working sender and every check signed — delivers **zero emails**. Not
because alerting is broken, but because there are no findings.

**Do not read a correct alerting chain as meaning MSPs will be notified.**

**And the zero is uncharacterised.** Whether it is a true zero — three narrow detectors across a
small fleet genuinely matching nothing — or an absence being read as evidence has not been
established. A source reports READY and CURRENT on the strength of a successful collection while
carrying no observed events. **That is the difference between "nothing is happening" and "we
cannot see", and it is outside alerting scope.**

## B. ADD TO SECTION 4 — the four a person must do

The blocker list says why the checklist cannot be completed. These are what remains **after** it
can be, and no test can close them. **While these lines are blank, this feature is not verified.**

**1. Send twice, one arrives.** Our side can only show two calls, one key, one provider id.
Whether that became one email is a fact about the provider and an inbox.

> Performed by ____________________ on ____________  Messages in the inbox: ______

**2. A human opens the inbox and writes down what arrived** — sender, subject, whether it
rendered, whether the deep link demands authentication, and **whether anything in the body names
a person or a tenant.** The closed vocabulary guarantees what the *code* can construct and says
nothing about what a template or a provider footer adds.

> Performed by ____________________ on ____________  Anything naming a person? ______

**3. A genuine signature still verifies**, against a real webhook with the real secret.
`() => 'invalid'` passes every forgery test ever written.

> Performed by ____________________ on ____________  Genuine verified: ____ Tampered rejected: ____

**4. A real hard bounce**: the next send to that address does not go, and a *different* message
to the same dead mailbox is not attempted either.

> Performed by ____________________ on ____________  Second message attempted? ______

## C. ADD TO SECTION 4 — forecast the first run before making it

`npx tsx scripts/alerting-forecast.mts` reads and nothing else, **refuses to run without a chosen
watermark** and refuses an unparseable one rather than falling back (both exit 2), and prints the
four gates it operates under. Procedure in `alerting-ACCEPTANCE-HOW.md`.

**If the forecast is more than a handful, the watermark is wrong** — a tuning question only until
it is sent. Afterwards it is a recall problem with no recall.

**The damage is bounded more tightly than it looks:** an ordinary tick reads at most 24 hours
(168 if raised) whatever the watermark says, so a watermark set a month back does not send a
month of email. **But a bound is not a number, and nobody has counted what a day contains.**

> Forecast: ______ messages, across ______ organisations. Watermark: ____________
> Approved by ____________________ on ____________

## D. ADD NEAR THE TEST RESULTS — one figure that will otherwise be over-read

`accountingProblems: []` means every finding appears exactly once across the jobs and the skips.
It is a **self-reconciliation over one pass**. It proves nothing vanished. **It cannot prove
anything was classified correctly** — a finding wrongly skipped as `RECORD_ONLY` counts exactly
once and the books still balance.

It is a tripwire against a future edit that adds a `continue` without a skip, which is worth
having. **It is not evidence that the delivery decisions are right**, and it must not be cited as
the second line of proof that they are.

## E. ADD TO "WHAT IS DELIBERATELY NOT IN THIS RELEASE" — six detectors produce no email

A risk rule becomes an alert type through the `investigationGuidanceCode` the catalogue declares.
**Two of the four codes map to no alert type, deliberately** — those findings produce no
incident, no job and no email, and are reported as unmapped rather than defaulted. Verified by
running the mapping, not by reading it:

| rule | what it detects |
|---|---|
| `HV-ID-MBX-001.v1` | Mailbox forwarding outside verified domains requires review |
| `HV-ID-MBX-002.v1` | **Mailbox concealment rule requires investigation** |
| `HV-ID-MBX-003.v1` | Mailbox rule changed after suspicious authentication |
| `HV-ID-CHG-005.v1` | **Identity protection configuration was weakened** |
| `HV-ID-APP-001.v1` | New application declares high-impact permissions |
| `HV-ID-APP-002.v1` | Application credential metadata changed |

Eighteen rules do map. **The refusal to invent a type is correct engineering** — inventing one is
the shortcut that put a caller-supplied category into a key once already. **But "we detect it and
will not email you about it" is a product decision**, and the two rows in bold are why it needs
deciding rather than inheriting: a concealment rule and a weakened identity-protection
configuration are not routine findings to leave silent.

## F. ADD AS ITS OWN SECTION AT THE END — the second gate is not a date

**A judgement, not a measurement.** Everything else in this document was run.

**The first real run is not the first tick after the switch. It is the first tick after findings
exist.** Today the source is empty, so switching on is uneventful — and the day the engine starts
matching, decisions made months earlier become load-bearing at once, with nobody watching
*because* switching on was uneventful.

| | harmless while the source is empty | load-bearing from the first finding |
|---|---|---|
| the watermark | nothing is older than it | decides which history is never mentioned |
| the 24-hour read window | nothing falls outside it | older findings never get an incident, and no backfill exists |
| the 5000-row read limit | unreachable | a burst above it is silently deferred |
| the six unmapped rules | they match nothing | six detectors fire and produce no email |
| the suppression list | empty | a hard bounce starts deciding who is never written to again |
| `maxAttempts` of 3 | no job spends it | decides when a message stops being retried |

**And several passing results in this document are passes over an empty input.**
`accountingProblems: []` balances zero findings; `neverSent()` enumerates jobs and there are none;
the unresolved-send report has never had a send to be unresolved about. They are true and they
have never had the chance to discriminate. **The reason to believe them is that they were
exercised against seeded fixtures and mutation-tested — not that production is quiet. A green
check on an empty input is not evidence about a full one.**

**One thing worth anticipating rather than discovering**, and it is speculation about a cause
nobody has established: the first findings may not arrive one at a time. If the emptiness is a
collection gap rather than a quiet fleet, fixing it produces findings for many tenants in one
tick — the single case where the watermark, the read window and the limit all bite together, on
the least likely day for anyone to be watching, because it will look like a collector fix.

**Somebody must be told what to re-check on the day the source stops being empty.** A checklist
organised solely around switching things on will pass every row in that table and still be wrong
later.
