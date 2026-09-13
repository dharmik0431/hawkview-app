# The rollback serves, and the alerting tests are reproducible

Two questions, both run rather than reasoned. **Neither suite's result says anything about the
other's, in either direction**, and they are kept apart below for that reason.

## 1. The previous commit's backend SERVES, not merely boots

A container that starts and then fails its first query has rolled back in appearance only. So
the old backend was booted, not just its migrate step run.

**Setup:** disposable database migrated to the branch head (54 migrations, four alerting tables),
then `origin/main`'s backend — `5488ad6`, 50 migrations — started against it. Dependencies
identical between the commits, verified by blob sha. Synthetic configuration only; no production
credential, and the one required external URL was a `.invalid` placeholder.

| | result |
|---|---|
| the boot step, `prisma migrate deploy`, against a database four migrations ahead | `No pending migrations to apply`, exit 0 |
| Nest application start | **started** |
| `GET /health` | **200** `{"status":"ok"}` |
| `GET /health/database` — a real query | **200** `{"database":"connected","schema":"current"}` |
| `GET /api/notifications`, `/api/tenants`, `/api/changes` | **401** — the guard runs; the stack serves |
| errors in the boot log after start | **0** |

**The strongest line is `"schema":"current"`.** That is not my judgement that the schema looks
compatible — it is **the old code's own schema check, passing against the branch-head schema.**

A 401 rather than a 500 is the point of the last row: the request reached the auth guard through
a fully constructed module graph. A rollback of code alone serves.

**Still not established:** every route, under real load, with production configuration. Three
public and three guarded routes were exercised on a synthetic database.

## 2. The five ALERTING integration tests are reproducible — ten of ten

Prompted by Engineer's finding that the identity-risk suite gave 27, then 22, then 29 on one
machine with one cluster and one commit. **That lands on me: I reported 45 passing from that
suite, and one sample of a speed-sensitive suite is not a figure.** The right description of
that suite is Engineer's — one suite sampled four times, not four environments finding four
gaps — and no number from it is reproducible, including mine.

**So the alerting five were asked the same question before we tell anybody they pass.**

Ten consecutive runs, one cluster, one commit (`e98bf47`), one database:

```
run 1: pass 5 fail 0      run 6:  pass 5 fail 0
run 2: pass 5 fail 0      run 7:  pass 5 fail 0
run 3: pass 5 fail 0      run 8:  pass 5 fail 0
run 4: pass 5 fail 0      run 9:  pass 5 fail 0
run 5: pass 5 fail 0      run 10: pass 5 fail 0
```

**Ten of ten, five of five every time. Not a blocker.**

### And the reason, which is worth more than the ten samples

Ten clean samples are still ten samples. The structural answer is better:

- **The alerting tests' budgets are `Date.now() + 30_000`** — thirty seconds, against work that
  completes in under a second. A slow machine has two orders of magnitude of headroom.
- **The one deadline-sensitive assertion uses an injected clock**, a counter-based stub, rather
  than racing a real one. The dangerous timing case is *driven*, not *awaited*.
- **The identity-risk suite carries 21 deadline and timeout references** in a single file, with
  real budgets — `remaining < 100` — that a slow machine genuinely blows.

**They are different by construction, not by luck.** That is why ten of ten here is worth
believing and why 45 there was not.

*(Engineer's own comment at line 270 records the same class of error caught on themselves: the
first version of that test passed a deadline already in the past, and it passed for the wrong
reason.)*
