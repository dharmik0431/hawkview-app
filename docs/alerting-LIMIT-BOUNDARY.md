# The store move is real — and crossing the boundary it made reachable found a defect

## The move is not nominal

`pipeline-store.ts` now holds the SQL. **Both the integration tests and the production service
import `pipelineStore` and differ only in the `SqlRunner` they pass** — a `pg.Client` in the tests,
the Prisma service in production. There is no SQL in the test file to disagree with the SQL that
ships.

**And the specific consequence checked:** `MAX_FINDINGS_PER_TICK = 5000` is an exported constant
used by the one query both callers run. The boundary that was unreachable-in-principle is now
reachable. **But reachable is not reached** — no test crosses it, so I did.

## Crossing it found something

**5001 open findings in one window. The tick wrote nothing.**

```
Transaction API error: A query cannot be executed on an expired transaction.
The timeout for this transaction was 5000 ms, however 5002 ms passed since the start.
```

**The read limit is 5000. The transaction budget is reached far below that.** Measured on this
machine, against a local disposable PostgreSQL:

| open findings in the window | result |
|---|---|
| 500 | read 500, wrote 500 |
| 1000 | read 1000, wrote 1000 |
| **2000** | **transaction expired, wrote nothing** |
| 3000 | transaction expired, wrote nothing |
| 5001 | transaction expired, wrote nothing |

**So the declared bound and the effective bound are different numbers**, and the effective one is
somewhere between 1000 and 2000 — two and a half to five times smaller than the limit that was
chosen to make the work bounded.

### It is intermittent, not stuck — and I had the framing wrong first

My first reading was "permanently stuck: the same findings remain, so every tick fails". **The
measurement says otherwise.** Three consecutive ticks at 2000:

```
tick 1: incidents=0      <- expired
tick 2: incidents=2000   <- got through
tick 3: incidents=2000
```

**It fails intermittently at the threshold and timing decides.** That is better operationally than
stuck, and worse to diagnose: a tick that writes nothing, logs `FAILED`, returns null, and then
works on the retry is exactly the kind of thing that gets explained away once and never looked at
again.

### The direction of error, which matters more than the number

This was measured on a local cluster over a loopback socket. **Production is a Render container
talking to Supabase over a network.** Every one of those 15,000 inserts — 5000 incidents, 5000
notifications, 5000 jobs — carries a round trip. **The threshold in production will be lower than
the one I measured, not higher.** I am stating the direction rather than guessing the number.

### Why nobody saw it

**Because the boundary could not be reached.** While the test store had no `LIMIT` and the
shipping store did, the two were different objects, and nothing could drive enough rows through
the one that ships. The move is what made this findable — which is the argument for the move, not
against it.

## The four parities are now suite properties, mostly

The suite is **17 tests, 17 passing, three consecutive runs.** My hand-checks have become tests:
the yield, in both its harmless and dangerous instances (#3, #4); the cancel including
**"THE READ-THEN-WRITE CANCEL REPORTS A TAKEN JOB AS STOPPED — the shape being rejected"** (#9),
which is my 25-round measurement turned into a permanent guard; and in-app visibility (#12–#14).

**Two of my four are not there.** There is no test named for the three-table **atomicity
rollback**, and none for the **OPEN/RESOLVED filter** parity. Both remain hand-checks I did once,
which by my own line about the store is not a property that stays true. **They should be tests, or
the next refactor of the store is unguarded in exactly the way the last one was.**
