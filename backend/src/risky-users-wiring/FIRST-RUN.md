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
