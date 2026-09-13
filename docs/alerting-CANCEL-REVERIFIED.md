# The cancel's three gaps, re-verified at `59f3a40`

All three closed. Measured against the register published at `c370af8`, before the code existed.

## The gap that came back as a row count last time

**The standard was my own measured case:** a queue where some jobs have attempts and some do not,
cancelled in **one call**, and the result must say which is which **per job**.

```
rows returned: 3
  never    ->  STOPPED_BEFORE_ANY_ATTEMPT
  tried    ->  MAY_HAVE_REACHED_PROVIDER
  claimed  ->  MAY_HAVE_REACHED_PROVIDER
```

**That is exactly the case that failed before.** Last time the same queue produced "3 cancelled"
with two of the three already attempted and no way to tell which. An operator repeating "3
cancelled" to a customer is now repeating something true about each job rather than about the
batch.

### And the subtle way it could have been wrong

PostgreSQL 15 has no `OLD` in `RETURNING`, and the columns that classify a job — its state,
whether it was claimed — are the ones the cancel overwrites. **If the `RETURNING` read the updated
row, every job would look unclaimed and unattempted, and everything would classify as
`STOPPED_BEFORE_ANY_ATTEMPT`** — the most dangerous possible wrong answer, because it is the
reassuring one.

It reads a `SELECT … FOR UPDATE` CTE instead, so the values are the locked pre-image. **Verified
behaviourally rather than by reading:** the claimed job and the twice-attempted job both come back
as `MAY_HAVE_REACHED_PROVIDER`, which a post-image read could not produce.

## The other two

**Provenance (C7).** `cancelled_by: dharmik`, `cancelled_because: "qa: bad first run"`,
`cancelled_at` set. *"Why was this MSP never told"* now has an answer on the row.

**The press (gap 3).** `backend/scripts/alerting-cancel.mts`, run as an operator would:

- a missing `--because` **refuses**, exit 2 — "an unexplained stop is what turns into an argument
  with a customer"
- without `--apply` it **previews and writes nothing**, confirmed by row count
- the preview shows the per-job split **before** acting: `stopped before any attempt: 3`,
  `MAY ALREADY HAVE GONE: 2`, each named, with the instruction to check `alert_send_attempts`
- with `--apply` it stops five jobs and records provenance on each

**A function with no press is not a stop button.** This is a press: no route, no auth decision, no
deploy, reachable by anybody holding the database URL — which is the situation a stop button is
for.

## The rest of the register

| | |
|---|---|
| C2 one statement | **bound** — single statement, `RETURNING`, `FOR UPDATE` |
| C3 scoped | **bound** — `incident/org-12` untouched by an `org-1` scope |
| C4 the boundary is required | **bound** — `--created-before` is mandatory, and a newer job is excluded |
| C5 terminal states | **bound** — `SENT` and `EXHAUSTED` not relabelled |
| C6 the row survives | **bound** |
| C8 incidents untouched | the statement names only `alert_send_jobs` |
| C1 | conceded earlier — a claimed job **is** cancelled, deliberately, and Engineer's reasoning beat mine |

## One note against myself

My first attempt at the press used `--scope everything`. The flag is `--everything`, and **the
script told me so in one line and exited**. Worth recording because it is the thing being tested:
an operator at three in the morning will get the invocation wrong, and what matters is whether the
tool says so plainly rather than doing something approximate.

I also shipped a probe with a typecheck error in it and fixed it before committing — the rule I
wrote down after the last one, applied to myself this time without needing the reminder.
