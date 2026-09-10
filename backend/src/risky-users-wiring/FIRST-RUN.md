# First real run — greentech, Graph feed, 30 days

**Run 2026-09-10. 2074 rows. As-of that instant; the table grows.**

The first time any of this touched real data.

## Verdict line

`CLASSIFIER RAN: every fetched row is accounted for.`

That is the discriminator, computed rather than remembered: 2074 fetched,
2074 classified, 0 unprocessable. So the numbers below are a real answer about
this window rather than a wiring fault wearing the shape of one.

## What it produced

- `applies`: **2046** — events in scope for detection
- `doesNotApply`: KEEP_ME_SIGNED_IN 12, APPLICATION_CONFIGURATION_ERROR 1
- `notYetCited`: EXCLUSION_NOT_YET_CITED 14
- `unknown`: UNRECOGNIZED_ERROR_CODE 1
- `unprocessable`: **all zero**

2046 + 12 + 1 + 14 + 1 = 2074. The four vocabularies account for every row.

- `state`: PARTIALLY_UNINTERPRETABLE — one unrecognised code, honestly reported
- `count`: **NOT_AVAILABLE**
- `claim`: withheld, for NO_CHECK_EXAMINED_EVIDENCE and UNINTERPRETED_EVENTS

## The part that matters

**No detectors were bound, and the engine did not report zero.**

It said: *"None of the checks assessed a single event in this window, so there
is nothing for a clear result to rest on."*

That is the whole rebuild, demonstrated on production data. The engine this
replaces had three rules that had never once fired across 1,054 runs and
reported a confident zero every time. Handed 2046 in-scope events and no
checks, this one refuses to claim anything and says which of two reasons apply.

The `considered: 0` guard — QA's finding, added hours before this run — is what
produced that. Without it the same window would have rendered EXACT 0.

## What this does NOT establish

No detector has run. The 2046 in-scope events are unexamined, so nothing is
known about whether greentech has risky users — only that the evidence reached
the engine and the engine declined to guess.

The next run binds a detector. That is when a zero would mean something, and
when PM's "a zero for greentech is a failure of the rebuild" starts to apply.

---

# Second run — detector bound

**Run 2026-09-10, same 30-day window. The table is live and grew between runs
(2046 → 2048 in-scope), which is itself a reason every figure carries an as-of.**

## Result

```
reading    CLASSIFIER RAN: every fetched row is accounted for
applies    2048
detector   repeated-credential-failure
           considered 540, declined { NOT_A_CREDENTIAL_FAILURE_OUTCOME: 1508 }
           540 + 1508 = 2048 exactly
matched    4
count      AT_LEAST 4
claim      withheld: UNINTERPRETED_EVENTS
findings   4
```

**Independently verified in SQL, not by asking the detector twice:** 3 users
carry a lockout, 1 more has ≥5 rejections, 4 should be flagged. The detector
found 4.

`AT_LEAST` rather than `EXACT` because one event in the window carries an
unrecognised code. Four users are certainly affected; whether a fifth is hides
behind that one event, and the count says so instead of rounding.

## THE DEFECT THIS RUN FOUND, WHICH IS THE MORE IMPORTANT RESULT

The first pass with the detector reported **1 finding**. SQL said 3 users had
lockouts. The detector was under-reporting by a factor of three.

Cause: `ReferenceResolver` takes TWO arguments, `(kind, identifier)`. Mine took
one and named it `microsoftUserId`, so it received `'subject'` and returned the
same reference for every user. All 2046 events collapsed to ONE subject.

TypeScript permits a shorter function where a longer one is expected, so
nothing complained. And every guard built over the preceding day PASSED:

- the classifier accounted for every row
- the detector's sum invariant balanced exactly
- coverage was complete, unprocessable was zero
- the verdict line correctly said CLASSIFIER RAN

**All of it was true. The number was still wrong.** Not one of those checks
looks at identity resolution, so a tenant with four affected accounts would
have been reported as one — a confident, well-qualified, wrong answer, which is
the exact failure this rebuild exists to prevent, arriving through the wiring
rather than the engine.

It was caught only by checking the output against the database independently.
No amount of internal consistency would have surfaced it.
