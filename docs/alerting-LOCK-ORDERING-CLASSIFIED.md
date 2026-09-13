# The ten lock-ordering failures, classified

**Result: not product lock-ordering defects. No launch blocker. They are the timeout already
found, wearing three different names.**

Classified, not fixed. Every file I instrumented was restored; `git diff` against the commit is
empty.

## The evidence chain

**1. The fixture's technique works on this machine.** The first hypothesis — a harness that
cannot produce the race it asserts — is **wrong**, and I checked it rather than assumed it. I
held a real contended advisory lock on a disposable Postgres and ran the fixture's query
verbatim:

```
  pid   |         backend_start
 770848 | 2026-09-13 02:26:02.101172+00
```

One row, the waiter, exactly as the fixture expects. I had also suspected `objsubid=1` was wrong
for `pg_advisory_xact_lock(hashtext($1))` — the bigint form — and that was wrong too: the lock
reports `objsubid=1`, and the fixture's `classid`/`objid` arithmetic matches. **The observation
technique is sound.**

**2. The failure is intermittent, with a varying count.** Five consecutive runs of
`wrapped-risk-key`, printing which of four concurrent callers rejected:

| run | outcome |
|---|---|
| 1 | four rejected |
| 2 | all ok |
| 3 | two rejected |
| 4 | all ok |
| 5 | two rejected |

Three of five. A product ordering defect would not come and go with the count changing; a
timing-dependent failure does.

**3. The rejection is never a lock symptom.** Every rejected caller gave
`IDENTITY_RISK_KEY_UNAVAILABLE`. Not a lost race, not a stale read.

**4. And that name is also a relabel.** `wrapped-risk-key-store.ts` line 124 is
`} catch { throw keyUnavailable() }` — **a second catch-all, discarding its cause exactly as
site 12 did.** There are three of them in that file. Attaching the cause gives:

```
IDENTITY_RISK_KEY_UNAVAILABLE :: IDENTITY_RISK_SOURCE_UNAVAILABLE
```

and `SOURCE_UNAVAILABLE`'s own cause, now carried since `2e4cc54`, is `timeout expired`.

## So the chain is

```
timeout expired
  -> caught by mailbox-read-transaction site 12   -> IDENTITY_RISK_SOURCE_UNAVAILABLE
  -> caught by wrapped-risk-key-store line 124    -> IDENTITY_RISK_KEY_UNAVAILABLE
  -> one concurrent caller rejects
  -> "Every concurrent caller must reload the winner" fails
```

**An assertion about lock ordering fails for a reason that has nothing to do with lock ordering,
and three catch-alls stand between the symptom and the cause.** That is why this looked like a
third, independent class: it was the same timeout each time, renamed twice on the way up.

## What I established, and what I did not

- **Established conclusively** for `wrapped-risk-key` / *"Every concurrent caller must reload the
  winner"*: the full chain above, reproduced across runs.
- **Strongly supported, not individually traced**, for the other two —
  *"late-started exact worker must actually wait on the fixture lock"* and *"Synthetic lock
  ordering was not observed"*. Both files fail with `SOURCE_UNAVAILABLE` whose cause is
  `timeout expired`, and in some runs the lock assertions are never reached at all because the
  test dies earlier. I did not instrument those two individually.
- **Not established:** that the product's lock ordering is correct. **This says the failures do
  not demonstrate it wrong — which is not the same as demonstrating it right.** Nothing here
  exercised the ordering successfully, because the transactions did not survive long enough to
  try.

## Recommendation

**No blocker, and the release artefact should say "classified as environment, ordering unproven"
rather than "lock ordering verified".** The distinction matters: an MSP is not exposed by this,
but nobody has yet seen these orderings work.

**And the second catch-all is worth the same one-line treatment as the first.** `keyUnavailable()`
in `wrapped-risk-key-store.ts` appears three times and discards its cause every time. The first
catch-all cost a day of diagnosis across two sessions; this one sat directly behind it.
