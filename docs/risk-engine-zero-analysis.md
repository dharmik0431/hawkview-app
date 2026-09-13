# Why has the risk engine never matched anything — code-side analysis

Read-only analysis on `agent/risk-engine-zero`, branched from
`agent/alerts-step-01`. No production access used; the queries that would settle
what remains are at the end, for somebody who has it.

---

## First, a correction: the adapter lead is mine and it is false

I was cited as having found that `adaptNativeAssessment` refuses shapes
production produces. **That is not what happened.** While building a capture
harness I wrote a fixture `{ subjects: [], sources: [] }` and the adapter refused
it — correctly. The real contract needs `version`, `available`, `run`, `count`,
and `findings` as an **object** `{ complete, items }` rather than an array. My
fixture was malformed; the adapter was right.

It is also in the wrong layer to explain this. `adaptNativeAssessment` is a
**frontend** adapter reading an API response. The tenants that never reach FULL
report `COMPLETED_EVALUATION_CORE / UNAVAILABLE` and `COMPLETED / PARTIAL` —
backend run states decided long before any browser parses anything. Nothing the
frontend adapter does can produce them.

Please don't spend anything on that lead. It was my error and I would rather
retract it than have it chased.

---

## Question 2 answered from code: the evaluator reads where the collector writes

Ruled out, and cheaply.

- **One production writer** to `sign_in_logs`:
  `tenant-sync.service.ts:4169` → `persistAuthenticationRecords`
  (`authentication-ingestion-integrity.ts:96`). Every other writer in the tree
  is a QA fixture under `risky-users-wiring/qa-*`.
- **The evaluator reads the same table**:
  `authentication-risk-loader.ts:53`, `FROM sign_in_logs`.

There is no split between where evidence is written and where it is read.

The retention delete beside the write is also clean: `LOG_RETENTION_MONTHS = 6`,
rows are stamped `expiresAt = ingestedAt + 6 months`, and the delete is
`expiresAt <= ingestedAt`. Freshly written rows cannot be removed by it. I
checked this specifically because a write-then-delete in one pass would produce
exactly the reported picture.

---

## The mechanism behind "READY and CURRENT with no events"

This is real and it is by design at the layer where it happens.

`tenant-sync.service.ts:4181` calls `persistCompletedAuthenticationWindow(...)`
after a successful page chain. That function's own header says it plainly:

> This metadata contains no events/identities.

So `GRAPH_SIGN_INS: READY, freshness CURRENT, lastSuccessfulCollectionAt current`
means **"a collection completed"**, not **"evidence exists"**. `latestEventAt` and
`latestIngestionAt` are the fields that would carry evidence, and they are
computed from rows actually found — both `null` in the measurement.

The house defect is not that this layer lies. It is that **nothing downstream
distinguishes the two**, so a source with no evidence presents identically to one
with evidence, and two rules built on it report READY while assessing nothing.

## What the evaluator can actually see

Two clamps, both to 24 hours, and they compound:

- `mergeAuthenticationWindow` (`authentication-source-readiness.ts:29`)
  accumulates contiguous windows but clamps the start to
  `max(from, end - 24h)`.
- `prepareAuthenticationEvaluation` (`:128`) clamps again:
  `authorizedFrom = max(window.start, asOf - 24h)`.

So the detectors only ever see **the last 24 hours**. `AUTH_COLLECTION_MAX_AGE_MS`
is 1 hour — if the window end falls further behind than that, the source goes
`COLLECTION_STALE` rather than READY. It reports READY, so collection is running
and current.

**Therefore `latestEventAt: null` means there were no sign-in rows in the last 24
hours for that tenant** — not that rows exist and the window missed them. The
window is as wide as the design allows.

## What that leaves

Two candidates, and they are distinguished by one query.

1. **`sign_in_logs` is empty (or empty within 24h) for these tenants.** Then the
   detectors are correct and the problem is upstream of them — either Graph
   returns nothing, or the collector's own window/filter is too narrow. The
   write is gated on `records.length > 0`, so a quiet tenant legitimately writes
   nothing.
2. **Rows exist within 24h and the evaluator still sees none.** Then the
   generation/window predicate is excluding them, and the fault is in the loader.

`assessedIdentities: 0` on both sign-in rules is consistent with (1): with no
rows there is nothing to assess. Note the third rule, `HV-ID-MBX-001.v1`,
assessed 1 identity from `MAILBOX_RULES` — a different source entirely — so the
pipeline is not globally dead.

---

## Queries that settle it, in order

Each is read-only. **Q0 first** — it is the control: if it returns nothing, the
scoping is wrong and every answer below is meaningless.

```sql
-- Q0  CONTROL. Must return rows; you already measured 366 notifications.
SELECT count(*) AS notifications, count(DISTINCT customer_tenant_id) AS tenants
FROM notifications;
```

```sql
-- Q1  THE DECIDING QUERY. Is there any authentication evidence at all?
SELECT customer_tenant_id,
       count(*)                      AS rows_total,
       count(*) FILTER (WHERE event_date_time > now() - interval '24 hours')
                                     AS rows_last_24h,
       min(event_date_time)          AS oldest_event,
       max(event_date_time)          AS newest_event,
       max(ingested_at)              AS last_ingest
FROM sign_in_logs
GROUP BY customer_tenant_id
ORDER BY rows_total DESC;
```

- **No rows at all** → cause (1). The detectors are correct; the problem is
  collection. Go to Q2.
- **`rows_last_24h = 0` but `rows_total > 0`** → also cause (1), and it says the
  tenants are quiet rather than the collector broken. Note `newest_event`: if it
  is months old, collection stopped.
- **`rows_last_24h > 0`** → cause (2), the loader is excluding them. Go to Q3.

```sql
-- Q2  Did collection actually run, and what window did it claim?
SELECT customer_tenant_id, observed_at,
       payload->>'source'             AS source,
       payload->>'start'              AS window_start,
       payload->>'end'                AS window_end,
       payload->>'paginationComplete' AS pagination_complete
FROM tenant_entra_snapshots
WHERE resource_type = 'SIGN_INS'
ORDER BY observed_at DESC;
```

A current `window_end` with no rows in Q1 means Graph returned an empty page
chain — collection works and there is genuinely nothing to collect.

```sql
-- Q3  Only if Q1 showed rows in the last 24h: do they fall in the window?
--     Substitute one tenant id and its window bounds from Q2.
SELECT count(*) AS in_window
FROM sign_in_logs
WHERE customer_tenant_id = '<tenant>'::uuid
  AND event_date_time >= '<window_start>'::timestamptz
  AND event_date_time <= '<window_end>'::timestamptz
  AND expires_at > now();
```

```sql
-- Q4  Identity side. assessedIdentities draws on this; empty here would zero
--     the sign-in rules independently of any evidence.
SELECT customer_tenant_id, count(*) AS users
FROM directory_users
WHERE deleted_at IS NULL
GROUP BY customer_tenant_id
ORDER BY users DESC;
```

```sql
-- Q5  Is anything being detected and then dropped before it becomes a finding?
SELECT status, reason_code, count(*)
FROM identity_risk_evaluation_runs
GROUP BY status, reason_code
ORDER BY count DESC;
```

---

## Recommendation, stated before the data comes back

I would not hide the feature yet, and I would not call it working either.

**If Q1 returns no rows**, the honest position is that the risk engine has never
had evidence to work on, and three narrow detectors over an empty table finding
nothing is not a defect in the detectors. That is a collection problem, and it
is likely to be days rather than weeks — the write path exists and is wired.

**If Q1 returns rows in the last 24h**, the loader is dropping them and that is
a real bug with a short radius, in one query in `authentication-risk-loader.ts`.

Either way, the thing I would change **regardless of the answer** is smaller than
the investigation: a source that reports READY and CURRENT while carrying
`latestEventAt: null` should not be indistinguishable from one carrying
evidence. That is the same defect this project has fixed on four screens today,
sitting at the top of the pipeline. It is a one-field change in the readiness
DTO and a rendering that respects it — and it would have made this question
answerable from the product instead of from a database.

On hiding: the feature currently shows an MSP "0 risky users" over tenants it has
no evidence for. That is the reassuring-absence shape. If Q1 confirms there is no
evidence, hiding the surface is defensible **until the readiness distinction
above exists** — after which the screen tells the truth and can stay.

---

# INTERIM FINDING

**Shape: most likely A (a wiring or entitlement fault), not C.** One query
settles it, and I can state now why "the tenants are genuinely quiet" has become
the *less* likely reading rather than the safe default.

## The fact that changes the odds

`INITIAL_LOG_LOOKBACK_DAYS = 30` (`tenant-sync.service.ts:1485`).

The collector's window is `latest stored event - 10 minutes`, or, **when nothing
is stored yet, `now - 30 days`**. It then asks Graph for
`createdDateTime ge <start> and le <end>` with no other filter.

So for a tenant with an empty `sign_in_logs`, every collection asks for **thirty
days of interactive user sign-ins**. If `GRAPH_SIGN_INS` reports READY with a
current `lastSuccessfulCollectionAt` and the table is still empty, Graph returned
**zero sign-ins across thirty days** for a tenant with live users. That is not a
quiet tenant; that is a collection that is not returning what it appears to.

This is what moves me off "correct behaviour". Over a 24-hour evaluation window a
small tenant plausibly has nothing. Over a rolling 30-day collection window, an
empty table is very hard to explain benignly.

## Three leads followed and killed, so nobody re-walks them

1. **Collector writes where the evaluator does not read.** False. One production
   writer (`tenant-sync.service.ts:4169`), one reader
   (`authentication-risk-loader.ts:53`), same table.
2. **A `$select` shrinking `raw` so failures are invisible.** False. There is no
   `$select` on the sign-in request, so Graph's default projection - including
   `status.errorCode`, which the credential-failure detectors need - is stored
   whole. The field list I first mistook for a projection is the fingerprint key
   list in `authentication-ingestion-integrity.ts:31`.
3. **The servicePrincipal / managedIdentity exclusion dropping every row.**
   False, and worth stating because it is one `Array.isArray` away from being
   true. `authentication-source-readiness.ts:101` guards on
   `Array.isArray(raw.signInEventTypes)`, and that field is `undefined` on every
   row today, so the predicate never fires. It becomes live the moment anybody
   adds a `$select` - a hazard for that change, not a cause of this one.

## The leading hypothesis

**Entra ID Premium entitlement.** `auditLogs/signIns` requires P1/P2. The
collector handles refusal explicitly (`tenant-sync.service.ts:4087`), matching

    Authentication_RequestFromNonPremiumTenantOrB2CTenant
    "doesn't have premium license"

and on either it falls back to `fetchLimitedLoginActivity` with `limited = true`,
stamping the window as **`M365_AUDIT_STS`** rather than `GRAPH_SIGN_INS`
(`:4181`). Anything else is rethrown (`:4093`).

The measurement says `M365_AUDIT_STS: WAITING, WAITING_FOR_COLLECTION, never
collected`. So on the FULL tenant the fallback has never run, which means the
premium path was not refused there - that tenant is entitled, collection
succeeded, and Graph returned nothing.

For the **six tenants that never reach FULL**, the fallback never having run is
the more telling fact: they are collecting via neither path. That fits an error
which is not one of the two handled strings, and is therefore rethrown rather
than falling back - a permission failure such as a missing `AuditLog.Read.All`
would look exactly like this.

## The one query that decides it

Q1 above, unchanged. Reading it:

| result | shape | what it means |
| --- | --- | --- |
| no rows for any tenant | **A** | collection returns nothing over 30 days. Permission or entitlement. Days, not weeks. |
| rows, but none in last 24h | **C**, with a caveat | tenants genuinely quiet in the evaluated window. The feature works and has nothing to report - but see below. |
| rows in last 24h | **A**, narrower | the loader is excluding them; one predicate in `authentication-risk-loader.ts`. Hours. |

Run **Q0 first**. It is the control: if it returns nothing, the connection is
mis-scoped and every other answer is meaningless.

## Estimates

- **A, entitlement or permission:** days. The handling code exists; what is
  missing is knowing which tenants are entitled and saying so. Verify
  `AuditLog.Read.All`, and carry a per-tenant entitlement state.
- **A, loader window:** hours. One predicate.
- **B, design gap:** only reachable if Q1 shows rows the detectors cannot use at
  all. No evidence for it, and two of the three candidate mechanisms are killed
  above.
- **C, correct:** no work, and I would say so plainly. It would still leave the
  reporting defect below.

## The one thing worth doing whatever Q1 says

A source reporting `READY` and `CURRENT` while carrying `latestEventAt: null`
should not be indistinguishable from one carrying evidence.
`persistCompletedAuthenticationWindow` is explicit that its metadata "contains no
events/identities" - READY means *a collection completed*, not *we have
evidence*. Nothing downstream separates the two, so two rules assessed zero
identities and reported READY, and an MSP is shown "0 risky users" for tenants
the product has no evidence about.

That is the same defect fixed on four screens today, at the top of the pipeline
instead of the bottom. It is a field on the readiness DTO plus a rendering that
respects it, and it would have made this question answerable from the product
rather than from the database.

**On hiding:** if Q1 confirms there is no evidence, hiding the Risky Users
surface is defensible until that distinction exists, because today it makes a
reassuring claim it cannot support. Once it exists the screen tells the truth and
can stay, whether or not the engine ever matches anything.
