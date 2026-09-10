# Pre-flight against real data — greentech, Graph feed

**Measured 2026-09-10 via read-only SQL. Every figure below is as-of that
instant and against a 30-day window unless stated.** Row counts move; a figure
quoted later without its stamp is the defect this workstream keeps finding.

The pipeline has NOT been run end-to-end. This records what was verified about
its inputs before that run, so a first result can be judged rather than
rationalised.

## The classifier's input contract holds

| Check | Result |
|---|---|
| `raw` is the unwrapped Graph object | yes — `status`, `userId`, `id`, `createdDateTime` all top-level |
| `raw.id` present | 2074 / 2074 |
| `raw.createdDateTime` present | 2074 / 2074 |
| `raw.userId` GUID-shaped | 2074 / 2074 |
| `raw.appId` GUID-shaped | 2074 / 2074 |
| `raw.status.errorCode` numeric | 2074 / 2074 |
| `raw.isInteractive` present | 2074 / 2074 |
| sign-in userIds matching a directory user | **16 of 16** |

Subject binding therefore resolves. Had it not, everything would have landed in
`unprocessableByReason` and the run would have produced a batch of zeros with
no error — the failure mode Engineer 3 warned about.

Note `raw.userId` is NOT the `sign_in_logs.user_id` column, which the
classifier deliberately ignores as unreliable. The JSON field resolves; the
column's reputation does not apply to it.

## What the window contains

2074 rows, 16 distinct users, all interactive.

| errorCode | rows | users |
|---|---|---|
| 50053 | 1339 | 4 |
| 0 | 615 | 14 |
| 50126 | 87 | 8 |
| 65001 | 13 | 6 |
| 50140 | 12 | 5 |
| 50074 | 2 | 1 |
| 53003 | 2 | 2 |
| 500121, 90094, 50011, 50020 | 1 each | 1 each |

**1339 lockout-family events across four users**, in thirty days. Both 50053
text variants are present and match the shapes the classifier parses:

- 886 "blocked because it came from an IP address with malicious activity"
- 453 "the account is locked, you've tried to sign in too many times…"

## What this does and does not establish

**Does:** the inputs are shaped as the classifier expects, subject binding
resolves, and there is substantial evidence in the window.

**Does NOT:** that the pipeline produces the right answer, or any answer. No
row has been through it. A zero from this tenant would be a failure of the
rebuild — but only once the run shows every fetched row accounted for. Rows
fetched and nothing classified is a wiring fault, and `dump-tenant` prints
which of the two it is rather than leaving it to be inferred.
