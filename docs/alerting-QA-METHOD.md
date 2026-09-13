# How the QA side of this feature worked

Written by the QA session, for whoever picks this up cold — possibly a different model, in a
different tool, with none of the conversation.

The properties are in the code and the tests. **This is the practice that produced them**,
and it is the part that does not survive a handoff on its own. Every rule below was paid for
by a specific mistake, and the mistake is named so you can tell whether the rule still
applies to what you are doing.

---

## The setup, in one paragraph

Two sessions: one building, one checking, and they did not share files. QA worked in a
separate checkout, never edited product source except to mutate it and restore it, and never
pushed. That separation is what made the checks worth anything — a check that shares an
origin with the thing it checks agrees by construction, and it agrees just as thoroughly when
the shared origin arrives as a **helpful example** as when it arrives as a bug. The example
route is worse, because nobody involved feels like they cut a corner.

If you are one agent doing both jobs, you cannot get that separation for free. The closest
substitute is to write the expectations **before** the implementation and never look at the
implementation while writing them — which is the next section.

---

## 1. Pre-registration: write the expectations before the code, publish the hash

**What it is.** Before the implementation exists, write down what it must do — as executable
checks, from the semantics — commit it, and publish the git blob sha.

**Why the hash.** Twice a disagreement about what had been expected was settled in one
command, because the file could be proven unchanged since before the implementation existed.
Without it, "that is what I meant all along" is unfalsifiable, including to yourself.

**Never edit a pre-registration in place.** When it needs strengthening, add a separate file
labelled as later and keep the original blob quotable. The original's only value is being
provably prior; improving it destroys that. When a seam changed shape and the fixtures no
longer compiled, the adaptation went in a revision file whose diff against the original
contained *only* fixture construction — the expectations did not appear in the diff, which is
what made "fixtures only" checkable rather than asserted.

**Expect it to fail when you write it.** A pre-registration that passes before the fix exists
is measuring something else. The count of failures is the size of the change.

**When a premise is withdrawn, the expectation is superseded, not failing.** A ruling changed
after three checks were derived from it. Carrying them as red would have read as three open
defects. They were recorded as superseded with the reasoning that replaced them.

---

## 2. The seam attack: ask what the shape cannot express, before anything is built

**This found something every single time it was tried — four for four**, and it was the
highest-value hour of the whole feature each time.

Take the obvious signature for the thing about to be built. Then ask, for each property it is
supposed to guarantee: *can this shape even express the failure?*

What it found, in order:

| The obvious shape | The property it could not express |
|---|---|
| `route(events, prefs, now)` | quiet hours defer — one `now` has no later, so held-and-sent and held-and-lost are the same output |
| a flat list of emitted findings | absence — "emitted then stopped" and "never emitted" are the same input |
| a queue state with no time | arrival-time versus event-time — both produce an identical state |
| an outcome listing only what was sent | a rule silenced that then never fires, which is byte-identical to nothing being silenced |

**The general form: a property about something that did NOT happen cannot be carried by a
list of things that did.** That sentence caught four separate defects at four different
layers. If a property is about absence, silence, a thing not arriving, or a configuration
rather than an event, check the shape can hold it before you check the code.

**And attack your own seam after you repair it.** Two of the four were found in QA's *own*
repaired shape, on the second pass. The first repair fixes the instance you noticed.

---

## 3. Mutation testing, and the four questions in order

"The test caught it" is not a result. Ask these, in this sequence:

1. **Is the instrument at the right level?** A test that injects the value under test cannot
   check how that value is chosen.
2. **Can the fixture express the defect?** A cross-tenant probe passed three times against
   deliberately broken code because the absence it relied on also removed the lookup key.
3. **Is the mutation faithful to its own name?** A variant called `key-omits-organisation`
   changed only the public key while lookups used the internal one — so the two tenants never
   actually shared an incident, and a precondition tripped instead.
4. **Did the assertion written for it fire** — or did a control fire first? Print *every*
   failure, never the first. A probe whose pass depends on which assertion runs first is
   ordering-dependent in the same way an order-dependent suite is.

**Before all four: check the mutation applied at all.** Three mutations were reported as "0
failures" when the anchors had never matched and the unmutated file ran three times. Clean
zeros that meant nothing. An unapplied mutation is a claim about the mutation before it is a
claim about the test.

**And confirm the probe can fail.** Every negative result needs a positive control — one
input that makes the check go red — or the zeros are unfalsifiable.

---

## 4. Print the value; do not trust the count

**This caught QA's own errors five times, more often than it caught anybody else's.**

A failing expectation explains itself. A passing one never does. So for every expectation
that is **green**, print what made it green, once.

What it caught:

- `/URGENT|ACT/` matched a severity of `ACT_TODAY` — a substring of the *opposite* member of
  a closed vocabulary.
- `/unrecognis/` asserted a sentence did *not* claim unrecognition; the sentence said "does
  not recognise". A negative assertion passing because the pattern missed is
  indistinguishable from one passing because the claim is absent.
- `/not (available|read)/` matched "not read" inside "can**not read**" — a phrase about
  unrecognised values, in a check claiming the verdict spoke about a missing field.
- An invariant reported as failing turned out to read a field that no longer existed;
  `JSON.stringify` drops `undefined`, so a missing field read as false.

**The rules that came out of it:**

- A pattern over prose is a **search**, not an assertion. A search finding something is not
  the thing being there.
- Never pattern-match a closed vocabulary. Compare against the named constant — and read the
  field at its **declared type**, because a union makes a wrong literal a compile error for
  free. A `String()` cast or a `Record<string, unknown>` throws that away.
- A negative assertion must not rest on a pattern. Change its shape instead: "these two
  verdicts must not be the same sentence" is a value comparison with nothing to get wrong.

---

## 5. Casts, and why one is worse than it looks

Two invented enum values — a category and a tier that do not exist in this product — sat in a
QA fixture for a full round while six checks reported READY over them. Both were hidden by an
`as` cast added to get past a single type error.

**A cast written to fix one complaint is a blanket over all of them.** Remove the cast and
fix the real field. If a fixture needs a cast to compile, the fixture is probably describing
a shape the product does not have.

The same mistake recurred later — a rung fixture that guessed a field name and hid the guess
behind `as`. Knowing the rule is not the same as applying it; the compiler is what applies it.

---

## 6. State the bounds of every search

A clean result is a fact about what you searched. Say what you did **not** search:

> "Nine forms plus two invented keys, no key-space fuzzing. Seven numeric classes, not a
> sweep. One machine, one Node version. Not reproduced is not the same as not present."

This is not hedging. Twice a bound was the finding: *"I have not swept all twenty rules for
other subject/category combinations"* led directly to a second instance of a defect that
would otherwise have shipped. Naming the edge of what you checked is how somebody else knows
where to look.

---

## 7. Report blocked as blocked

Three properties are unbound right now because the function they describe does not exist.
They are reported as **unbound**, not omitted and not counted as passing — because five READY
lines next to eight properties implies eight.

Related: an intermittent that could not be reproduced in 76 runs was reported as *not
reproduced*, with the sampling stated, and explicitly **not** as cleared. The security half
was answered structurally instead — `reference` is `async` but contains no `await`, so there
is no yield point for a cleanup race to use. A structural answer beats a statistical one when
you can get it.

---

## 8. Findings go in the commit message

Cross-session messages were silently refused in transit more than once, and an output filter
tuned for brevity destroyed the one TAP block that mattered on the one run where it mattered.

**Commits are the reliable channel.** Every QA finding in this feature is in the message of
the commit carrying the work, in full, whether or not the message was received. If it matters
and the send might not land, put it where `git log` will find it.

---

## 9. Two instruments beat one, and the rival is in scope

The generator disagreed with a hand-written SQL count. The SQL was wrong — it merged rows the
product's own ruling says stand alone. The generator was *also* wrong, in the other direction.
Neither had the right answer until they disagreed.

**A result that looks like a regression is the first place to check the instrument.** A QA
audit once reported that a metric had got worse; the truth was that the audit could not see
identities computed inside the function it was auditing. Correcting the instrument, rather
than re-running it, was the result.

---

## 10. The design rules this practice kept producing

These are in the product docs too, but they came out of QA findings and are worth having in
one place:

- **When two fields on one object can disagree about the same fact, one is derived from the
  other or both from a shared owner — never both supplied.** Three instances: subject from the
  declaration, category from the catalogue, type from the classification.
- **A field a caller can still set is derivable, not derived.** Offering a derivation function
  beside a settable field closes nothing.
- **Make the wrong thing unwriteable rather than forbidden.** A check is something a later
  caller can route around; a non-empty tuple, a branded type, a union with no member for the
  bad case, or simply an absent field is not. Used for: arrival time on the decision path, a
  lossy projection excluded from the digest, a failed run read as an empty one, a delivery
  addressed to a tenant, a ladder without a notification, a ladder with zero rungs.
- **A distinguished value must not sit behind a change predicate** — nor behind a length
  predicate over a type that distinguishes empty from unreadable.
- **Absent is not unrecognised; unavailable is not zero; a failed run is not an empty one; a
  hold that expires is not a hold.** Every one of these was a true-sounding sentence in the
  wrong company.
- **An explanation reaches somebody already looking; a statement reaches somebody who is
  not.** The worst outcome the product can produce must not be the quietest.

---

## What is not covered

Said plainly, because a method document implying completeness is the same failure it warns
about:

- **L1, L2 and L4** (a limit withholds rather than drops; a withheld delivery is released;
  a limit is counted over its declared scope) are **bound**, at 42622d1: 135 enumerated cases,
  0 breaches, plus four attacks on the limit itself.
- **No production data.** Everything here is synthetic fixtures, type-level checks, and work
  against a disposable local Postgres. A disposable cluster now exists and the apply runbook has
  been run end to end against it; see `alerting-apply-FIRST-RUN.md` and `-SECOND-RUN.md`.
  The gated database-integration suite has been run once and does not reach a meaningful result
  without prerequisites nobody has written down — see `alerting-LAUNCH-BLOCKERS.md` B3.
- **The rendered screen** is not covered by any of this. The recurring defect in this product
  is a true sentence in the wrong company, and tests cannot see the company — only rendering
  can.
