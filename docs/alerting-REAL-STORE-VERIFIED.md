# The production store, exercised — four parities and one difference

**Everything proved about this flow until now went through `storeFor(client)`, a store written
inside the test file by the author of the assertions.** `c30d947` introduced a different
implementation, `alert-intake.service.ts`, and that is the one that will run. **A test cannot
check what it injects, and the store has been the injected part all along.**

So the production store was driven directly, against a real database, on the properties the flow
depends on.

## The four

| question | result |
|---|---|
| does `findOpenFindings` apply the same `OPEN` filter and window? | **parity** — reads the OPEN row, not the RESOLVED one sitting beside it |
| does a second tick still write nothing? | **parity** — zero incidents, zero jobs, the finding named `INCIDENT_ALREADY_OPEN` rather than dropped |
| **does the production caller honour the yield, on the cascade's own arithmetic?** | **honoured** |
| does the atomic write really span both tables here? | **atomic**, tested by forcing a failure between them |

### The yield, on the arithmetic the cascade actually uses

The controller calls `runOnce(startedAt + 60_000)`. Every test that has run against this code
supplied a hand-made deadline, so the production arithmetic had never been exercised. Driven with
`startedAt` two minutes in the past — the cascade's own expression when a tick has overrun:

```
deadlinePassed: true   yieldedOnBudget: true   findingsRead: 0
incidents: 0           jobs: 0
```

**It yields before reading and writes nothing.** This is the branch that fooled everybody once
already, and the production caller computes its budget differently from every test that had run
against it — so it was worth driving rather than reading.

### Atomicity, with the failure placed exactly where the blocker was

The production commit uses `prisma.$transaction`, not the explicit `BEGIN`/`COMMIT` I tested
earlier — a different mechanism, so the earlier result does not carry over. A `CHECK` constraint
that only the **job** insert can violate puts the failure precisely between the two tables, which
is the window that produced the original stranding blocker.

```
job insert failed (23514)   incidents left behind: 0   jobs: 0
```

**The incident did not survive the failed job insert.** The stranding defect does not return
through the real store.

One thing worth stating about how that failure surfaced: `runOnce` never throws into the cascade,
so it came back as a **null report and a logged `FAILED`**, not an exception. That is correct —
collection outranks alerting — and it is exactly why **the database is the thing to check rather
than the return value.** A caller reading only the return value would see "no report" and could
not tell a refusal from a rollback.

## The one difference, found by reading rather than by running

**Production `findOpenFindings` ends `LIMIT 5000`. The test store has no `LIMIT` at all.**

So **no test can reach that boundary**, because the store the five green tests use does not have
it. At more than 5000 open findings in one window, a tick silently processes the first 5000 by
`observed_at` and the rest wait for the next tick.

**That is a bound rather than a defect** — and it is the right shape, since the alternative is an
unbounded read inside an admission budget. But it is **unproven and untestable through the store
the tests use**, which is the same shape as everything else on this page: the property lives in
the implementation that ships and not in the implementation that is checked.

**What would close it:** the integration tests drive the production store, or the test store
carries the same `LIMIT` so the boundary is reachable from a test. The first is better — it is
the whole lesson of this page.
