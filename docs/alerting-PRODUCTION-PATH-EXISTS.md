# There is now a production code path — and it bounds D9

**`c30d947` invalidates a line I wrote into the handoff status two commits ago**, which PM
carried to Dharmik. Flagging it at once rather than letting it stand.

## The status line that is now false

> **There is no production code path.** `runIntake` is called by nothing in `src/`, nothing
> schedules it, and `PipelineStore` has no implementation outside the test file.

**All three clauses are now false.** `alert-intake.service.ts` is a real `PipelineStore` and the
production caller; `scheduled-sync.controller.ts` invokes `runOnce` from the cascade. The chain
is joined by the product.

**What is still true and must not be dropped from the status:** nothing sends. The only
`SendTransport` in the repository refuses, and `resend` is not a dependency.

## Which instance of the branch did the test take

The question that found the budget-yield blocker, asked of the new code. **The tests take both
instances, and one of them is written as a positive control in so many words:**

```
WITHOUT A WATERMARK IT REFUSES TO RUN, and does not reach the database
AN UNPARSEABLE WATERMARK IS ALSO A REFUSAL, not a fallback
A VALID WATERMARK GETS PAST THE REFUSAL, or the two tests above prove nothing
AN EXPIRED WINDOW YIELDS WITHOUT READING
```

The third is the half that makes the first two mean something — a refusal that refuses everything
would satisfy both. That is the D7 discipline arriving in somebody else's code without my
register being read, which is the better outcome.

## D9 IS BOUNDED BY SOMETHING I HAD NOT ACCOUNTED FOR

I registered D9 — forecast the first real run — as a launch blocker, on the reasoning that a
badly-chosen watermark sends a backlog that cannot be recalled.

**The read window bounds it, and the bound is much tighter than the watermark.**

```
HAWKVIEW_ALERT_READ_WINDOW_HOURS   default 24, clamped to a maximum of 168
readSinceIso(tickAt) = tickAt - bounded hours
findOpenFindings(sinceIso) filters observed_at >= sinceIso
```

So an ordinary tick reads **at most the last 24 hours** (168 if someone raises it), whatever the
watermark says. A watermark set a month back does **not** send a month of email: it sends nothing
observed more than a day ago, because those findings are never read in the first place.

**This substantially reduces the blast radius I was worried about**, and I am saying so rather
than leaving a blocker standing on reasoning that has been overtaken.

**D9 still stands, for two reasons:**

1. **The forecast is still the right artefact.** "At most 24 hours of findings" is a bound, not a
   number. Whether that is three emails or three hundred depends on the data, and nobody has
   counted.
2. **The watermark is still required and still unchosen.** The service refuses to run without
   `HAWKVIEW_ALERT_WATERMARK_ISO`, and an unparseable value is a refusal rather than a fallback —
   which is exactly right, and means somebody must still choose the instant.

**And the read window introduces its own gap, which the code states plainly rather than hiding:**
findings older than the window **never receive an incident row from ordinary ticks at all**. A
backfill is a separate job that does not exist. That is a product decision for Dharmik — it is
the difference between "we will not email you about last month" and "last month is not in the
system" — and it is not a defect.
