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

---

# SECOND INTERIM — the data does not yet say cause (2)

I was handed Q0/Q1/Q2 with the conclusion "it is cause (2): the evidence is
there and the loader is not seeing it." **I do not think that follows yet**, and
the step that does not hold is one measurement being generalised to four other
tenants. Saying so before building on it.

## What the code forces, and it is decisive

Every row the readiness loop rejects increments `gaps`
(`authentication-source-readiness.ts:95-116` — six separate `gaps++; continue`
branches). Then:

    const partial = gaps > 0 || !window.paginationComplete
    const reasonCode = partial ? 'INCOMPLETE_WINDOW' : 'READY'

**So a tenant whose rows were fetched and then dropped cannot report READY.** It
reports PARTIAL / INCOMPLETE_WINDOW. The measured tenant reported
`READY / reasonCode READY` with `latestEventAt: null`.

The only way to reach READY with no events is for the loop to iterate **zero
times** — the bounded SQL returned nothing. Not "returned rows that were
filtered out". Nothing.

## Which tenant that was, and why it changes the reading

The FULL aggregate came from one tenant. Match it against Q1 and Q2:

| | rows in 24h | newest event | Q2 window source |
| --- | --- | --- | --- |
| 83f23fe5 | 11 | 2026-09-13 14:34 | GRAPH_SIGN_INS |
| dcb2a091 | 27 | 2026-09-13 14:16 | M365_AUDIT_STS |
| 27e8b142 | 43 | 2026-09-13 13:15 | M365_AUDIT_STS |
| **6facb85e** | **0** | **2026-09-10 13:56** | **GRAPH_SIGN_INS** |
| 66735f04 | 0 | 2026-08-30 04:24 | M365_AUDIT_STS |

The measured tenant reported `GRAPH_SIGN_INS READY` and
`M365_AUDIT_STS WAITING_FOR_COLLECTION`. Only two tenants snapshot under
GRAPH_SIGN_INS: 83f23fe5 and 6facb85e. Of those, only **6facb85e** can produce
READY-with-no-events, because its window is
`2026-09-12T14:46 → 2026-09-13T14:46` and its newest row is **2026-09-10** —
every one of its 119 rows is older than `window.start`, so the SQL returns zero
and the loop never runs.

83f23fe5 cannot produce it. It has 11 rows inside its own window, so either they
are returned (loop runs, `latestEventAt` non-null) or they are dropped
(`gaps > 0`, status PARTIAL). Neither is READY-with-null.

**So the FULL tenant is 6facb85e, and its READY over no events is correct
behaviour over a collector that stopped three days ago.** It is not the loader
being blind.

## What that means for the three live tenants

**Their evaluation aggregates have not been measured.** The reasoning that
reached cause (2) took 6facb85e's aggregate and applied it to 83f23fe5,
dcb2a091 and 27e8b142. That is the step I do not think holds — and those three
are most likely the `COMPLETED / PARTIAL` population (4,461 runs, 5 tenants),
not the FULL one.

If they are PARTIAL, that is consistent with rows being fetched **and dropped**
— `gaps > 0` — which is a completely different fault from the loader not seeing
them, and it has a different fix.

## The real finding available right now

Whatever the three live tenants turn out to say, Q1 already establishes
something that needs no further query:

**Sign-in collection has stopped for two of five tenants.**
6facb85e last ingested 2026-09-10; 66735f04 last ingested 2026-08-30, with nine
rows total. Both still report a current `lastSuccessfulCollectionAt` and a
window ending *now* — `persistCompletedAuthenticationWindow` stamps the window
from the requested range, not from what came back. So a stalled collector and a
quiet tenant are indistinguishable in the product, which is the same defect
again.

That is real, it is independent of the loader question, and it is worth fixing
whatever else is true.

## What I need to finish this

**Q6 — the deciding query now.** What do the live tenants actually report?

```sql
-- Most recent evaluation aggregate per tenant, for the three with fresh rows.
SELECT customer_tenant_id, status, reason_code, created_at
FROM identity_risk_evaluation_runs
WHERE customer_tenant_id IN (
  '83f23fe5-bfdf-4e21-84fb-12f9627a3d06'::uuid,
  'dcb2a091-ecf5-4bda-8780-a33bfb1b4d63'::uuid,
  '27e8b142-7456-4cba-bdf3-8897f9f801bd'::uuid)
ORDER BY customer_tenant_id, created_at DESC
LIMIT 30;
```

Plus, if the aggregate payload is stored, the per-source block for 83f23fe5 —
specifically `status`, `reasonCode`, `latestEventAt` and `gapCount`.

- **PARTIAL / INCOMPLETE_WINDOW** → rows are being fetched and dropped. The
  fault is in the row filter, and the six `gaps++` branches at
  `authentication-source-readiness.ts:95-116` are the whole search space.
  Hours to localise, once I know which branch.
- **READY with latestEventAt non-null** → the engine is working on those tenants
  and the zero-match question is genuinely "three narrow detectors found
  nothing", i.e. shape C.
- **READY with latestEventAt null on 83f23fe5** → that would contradict the code
  above and I would want to see the row, because it should be impossible.

**Q3 is still worth running** exactly as specified, because it isolates the SQL
predicate from everything downstream. If 83f23fe5's 11 rows come back
`in_window = 11`, the query is fine and the loss is in the loop; if `0`, it is
`expires_at` or the organisation scoping.

## Revised shape

Still **A**, but a different A than I named this morning, and possibly two
faults rather than one:

1. **Collection stalled** on 6facb85e (3 days) and 66735f04 (2 weeks), reported
   as current. Days. Real regardless of anything below.
2. **Rows dropped in the readiness loop** on the live tenants — *if* Q6 returns
   PARTIAL. Hours once localised, and the search space is six branches.

Shape C is not dead: it survives if Q6 shows the live tenants READY with events.

I would not tell Dharmik "the engine has been blind over evidence that was there
the whole time" until Q6 comes back. On the evidence in hand the one tenant we
measured was behaving correctly over a stalled feed, and the tenants with
evidence have not been looked at.

---

# ANSWER: what makes a window INCOMPLETE, and can it become complete

Short version: **`INCOMPLETE_WINDOW` is not a statement about the window.** It is
a fall-through label, and on 83f23fe5 it is being produced by a single unusable
event among eleven.

## 1. The reason code is a catch-all

`risky-users-auth/to-assessment.ts:30`:

    return reasons.length
      ? { status: 'PARTIAL', reasonCode: 'INCOMPLETE_WINDOW' }
      : { status: 'READY',   reasonCode: 'READY' }

Seven specific conditions are named in the branches above it — capacity,
insufficient fields, conflicting duplicates, stale, unavailable, invalid context,
invalid readiness. **Everything else lands on `INCOMPLETE_WINDOW`**, including at
least these seven, all emitted by `evaluate.ts`:

    PAGINATION_INCOMPLETE        SOURCE_GAPS          SOURCE_REPORTED_GAP
    FUTURE_RECORD_EXCLUDED       INGESTION_PRECEDES_EVENT
    MALFORMED_NORMALIZED_EVENT   SOURCE_SCOPE_MISMATCH

So the code that has been reported all day means "there was at least one reason
and it was not one of the seven we modelled". It cannot be diagnosed from, which
is most of why this took a day. This is the safety-net shape: the catch-all for
unmodelled cases leaves the modelled ones with no distinct backstop, and the
better the naming looks, the more silently the gap passes.

## 2. On 83f23fe5, four candidates remain and no more

The source DTO reported `GRAPH_SIGN_INS: READY`. From
`authentication-source-readiness.ts:121-130`, that requires `gapCount === 0`,
`paginationComplete === true`, `state === 'READY'`, `capped === false`. Those are
exactly the inputs to `evaluate.ts:59-66`, so **every source-level reason is
eliminated**. `LOOKBACK_CAPPED` is eliminated too — it maps to `CAPACITY_LIMIT`,
and the rule reported `INCOMPLETE_WINDOW`.

That leaves only the per-event branches, `evaluate.ts:74-78`:

| reason | condition |
| --- | --- |
| `FUTURE_RECORD_EXCLUDED` | `eventAt > asOf` **or** `ingestedAt > asOf` |
| `INGESTION_PRECEDES_EVENT` | `ingestedAt < eventAt` |
| `MALFORMED_NORMALIZED_EVENT` | `validEvent(event)` false |
| `SOURCE_SCOPE_MISMATCH` | `event.source !== input.source` or scope differs |

One of those four is firing on 83f23fe5. Nothing else can be.

## 3. Can it become complete? Yes — but it is all-or-nothing

`reasons` is a `Set` (`evaluate.ts:57`) that is never cleared, and each of those
branches does `reasons.add(...)` then `continue`. So:

**One unusable event out of eleven downgrades the entire tenant to PARTIAL and
sets `assessedIdentities: null`.**

The other ten events are dropped from the evaluation with them. The rule does not
evaluate what it can and report the rest — it reports nothing, and says nothing
about how much it discarded. That matches the measurement exactly:
`assessedIdentities null`, no findings, on a tenant with fresh evidence.

Note the contrast one line earlier: `evaluate.ts:72` skips events older than the
lower bound with a **silent** `continue` and no reason. So "outside the window"
is handled cleanly, and "inside the window but unusable" poisons the run. The
condition is not strictly unsatisfiable — a tenant whose every event normalises
cleanly reaches READY — but it is fragile in a way that scales badly: the more
evidence a tenant has, the likelier one bad row silences all of it.

That is the bug. Not entitlement, not a missing read, not the window.

## 4. Which of the four — three cheap queries

```sql
-- Q7  INGESTION_PRECEDES_EVENT. Should be zero; anything above zero fires it.
SELECT customer_tenant_id, count(*) AS ingested_before_event
FROM sign_in_logs
WHERE ingested_at < event_date_time
GROUP BY customer_tenant_id ORDER BY 2 DESC;
```

```sql
-- Q8  FUTURE_RECORD_EXCLUDED. Events stamped ahead of the evaluator's clock.
SELECT customer_tenant_id, count(*) AS future_events,
       max(event_date_time) AS furthest
FROM sign_in_logs
WHERE event_date_time > now()
GROUP BY customer_tenant_id ORDER BY 2 DESC;
```

```sql
-- Q9  The eleven rows themselves, for 83f23fe5, to eyeball the last two causes.
--     MALFORMED / SCOPE_MISMATCH are shape problems and need the raw row.
SELECT microsoft_sign_in_id,
       event_date_time, ingested_at,
       (raw->>'userId')  IS NOT NULL AS has_user_id,
       (raw->>'appId')   IS NOT NULL AS has_app_id,
       raw->>'appId'     AS app_id,
       raw ? 'hawkviewLimited' AS limited_row,
       raw->>'hawkviewSource'  AS hawkview_source
FROM sign_in_logs
WHERE customer_tenant_id = '83f23fe5-bfdf-4e21-84fb-12f9627a3d06'::uuid
  AND event_date_time > now() - interval '24 hours'
ORDER BY event_date_time DESC;
```

Q9 is the one I would run first. If any row shows `limited_row = true` on a
tenant whose window says `GRAPH_SIGN_INS`, that is `SOURCE_SCOPE_MISMATCH`
directly: rows collected under the Management Activity fallback sitting in a
window attested as Graph. Given dcb2a091 and 27e8b142 both snapshot under
`M365_AUDIT_STS`, a tenant that has switched between paths is likely to hold a
mix — and a mix is exactly what poisons a run under the all-or-nothing rule.

If `app_id` is non-UUID or null on any row, that is
`MALFORMED_NORMALIZED_EVENT` — `authentication-source-readiness.ts:100` already
requires `UUID.test(appId)`, so such a row would also have been counted as a
readiness gap, which contradicts `gapCount = 0`. So I expect Q9 to point at the
limited/source mix rather than at field shape.

## 5. Two fixes, and they are different sizes

**(a) Make the reason code say which.** Hours. `readiness()` in
`to-assessment.ts` already receives the `reasons` set; it discards the
distinction on the last line. Carrying the specific code — or even the count of
dropped events — turns a day of investigation into a glance. I would do this
first regardless of (b), because it is diagnosis infrastructure and everything
else in this feature is harder to see without it.

**(b) Stop one bad event silencing a tenant.** Days, and it is a product
decision rather than a repair. The honest options are to evaluate the usable
events and report how many were dropped — which is the `notYetCited` /
`uninterpreted` distinction this codebase already uses elsewhere — or to keep
all-or-nothing and make the dropped count visible so the refusal is legible. The
current behaviour is the worst of both: it refuses, and it does not say what it
refused over.

## 6. Revised summary of all three tenants

| tenant | shape | cause | size |
| --- | --- | --- | --- |
| 83f23fe5 | evidence seen, rule refuses | one unusable event in the window, reported as `INCOMPLETE_WINDOW` | hours to identify with Q9, then (a) |
| dcb2a091 | premium path refused | entitlement fallback at `:4087`; window stamped `M365_AUDIT_STS` while the rule waits on `GRAPH_SIGN_INS` | days |
| 6facb85e | correct | collection stopped 2026-09-10; reports current because the window is stamped from the requested range | days |

**Shape A**, three distinct faults, none of them the detectors being wrong. The
zero-match figure is not evidence the rules are too narrow — on this data the
rules have never been given a clean run to be narrow on.

---

# THE CAUSE: three error codes are known, everything else silences the tenant

## First, correcting myself

I wrote that exactly four per-event branches remained and "nothing else can be".
That was a bounded read presented as a complete one — I stopped at line 80 of
`evaluate.ts`. There are two more `reasons.add` calls below it, and **one of them
is the cause**. A bounded search proves only its bounds, and I asserted past
mine.

Also: the rejection is **not** in the `gaps++` loop. The source reported READY,
which requires `gaps === 0`, and its `latestEventAt` equals the max event time in
the window — so all eleven rows were accepted by readiness and at least one ran
the full length of the loop. Nothing was dropped there. The two
`INCOMPLETE_WINDOW`s come from different files and mean different things.

## The cause

`risky-users-auth/normalize.ts:26`

    const classify = (code) =>
      code === 50126 ? 'INVALID_CREDENTIAL'
    : code === 0     ? 'SUCCESS'
    : code === 50076 ? 'NON_QUALIFYING'
    :                  'UNKNOWN';

**Three Entra error codes are recognised. Every other code in existence maps to
`UNKNOWN`.**

`risky-users-auth/evaluate.ts:93`

    if (events.some(event => event.outcome === 'UNKNOWN')) reasons.add('UNKNOWN_OUTCOMES');

`UNKNOWN_OUTCOMES` is not matched by any named branch in `readiness()`
(`to-assessment.ts:21-30`), so it falls through to the catch-all on the last
line: `PARTIAL` / `INCOMPLETE_WINDOW`, and the projector nulls
`assessedIdentities`.

**One sign-in carrying any error code other than 0, 50126 or 50076 silences the
entire tenant's rule for that run.**

Two further routes to the same place, same line region:

- `normalize.ts:60` — `errorCode === 0` but a non-empty `failureReason` → UNKNOWN
- `normalize.ts:62` — `isInteractive` present and not exactly `true`/`false` → UNKNOWN

## Why this fits every measurement

| observation | explained |
| --- | --- |
| source `READY`, `gaps === 0` | `UNKNOWN` is a **valid** outcome for `validEvent` (`evaluate.ts:17`), so these rows are accepted by readiness, not dropped |
| `latestEventAt` = 14:34:44Z, the real max | events ran the full loop and reached the `latestEvent` assignment |
| rule `PARTIAL` / `INCOMPLETE_WINDOW` | `UNKNOWN_OUTCOMES` → unnamed → catch-all |
| `assessedIdentities: null` | set whenever the rule is not READY |
| **zero findings across the whole fleet** | every tenant with a realistic sign-in mix trips it |

That last row is the point. Entra routinely emits `50058` (interrupted), `50074`
(strong auth required), `50079` (MFA enrolment), `53003` (conditional access
blocked), `50105` (not assigned), `65001` (consent), `50173` (token expired).
A tenant needs **every single sign-in in the 24-hour window** to be one of three
codes for the rule ever to report. That is not narrow detectors finding nothing —
it is a gate that practically cannot open, which is what you suspected when you
asked whether the condition was satisfiable.

## The query that confirms it — one column

You asked which columns the branches test. For this cause it is one, and the
eleven rows will settle it:

```sql
-- Q10  The deciding column. Any code outside {0, 50126, 50076} silences the run.
SELECT raw->'status'->>'errorCode'   AS error_code,
       count(*)                      AS rows,
       bool_or(raw->>'failureReason' IS NOT NULL
               AND raw->>'failureReason' NOT IN ('', '0', 'None')) AS has_failure_reason,
       bool_or(raw->>'isInteractive' IS NULL)                      AS missing_is_interactive
FROM sign_in_logs
WHERE customer_tenant_id = '83f23fe5-bfdf-4e21-84fb-12f9627a3d06'::uuid
  AND event_date_time >= '2026-09-12T14:45:54.607Z'::timestamptz
  AND event_date_time <= '2026-09-13T14:45:54.607Z'::timestamptz
GROUP BY 1 ORDER BY rows DESC;
```

**Any row whose `error_code` is not `0`, `50126` or `50076` confirms it.** I
expect at least one and probably several.

Two secondary columns, if you want the other routes ruled out in the same pass:
`has_failure_reason` true on an `error_code = 0` row is `normalize.ts:60`;
`missing_is_interactive` is not itself a trigger (undefined is permitted) but a
non-boolean value there is `:62`.

## Fleet-wide version, if you want the scale in one number

```sql
-- Q11  How much of the fleet's recent evidence is unclassifiable.
SELECT customer_tenant_id,
       count(*) AS rows_24h,
       count(*) FILTER (WHERE (raw->'status'->>'errorCode') NOT IN ('0','50126','50076')
                           OR (raw->'status'->>'errorCode') IS NULL) AS unknown_outcome_rows
FROM sign_in_logs
WHERE event_date_time > now() - interval '24 hours'
GROUP BY 1 ORDER BY 2 DESC;
```

If `unknown_outcome_rows > 0` for every tenant with recent evidence, that is the
whole zero-findings figure explained in one column.

## Estimates

**(a) Name the reason.** Hours. `readiness()` has the set and discards it. Until
this changes, every future instance of this costs another day.

**(b) Classify the error codes.** Days, and it is the real fix. The classifier
needs the Entra failure vocabulary, not three constants — at minimum a mapping
that distinguishes *credential failure*, *MFA/CA interruption*, *non-qualifying*
and *genuinely unknown*, since the detectors care about the first.

**(c) Stop one event silencing a tenant.** Days, product decision. `some()` at
`:93` is a fleet-wide switch operated by a single row. Even after (b) there will
be codes nobody has mapped, so (c) is what stops the next unmapped code
reproducing this exactly.

I would do (a) today, (b) next, and treat (c) as the thing that prevents the
recurrence rather than the thing that fixes today.

## dcb2a091 — the second, different fault

Its `GRAPH_SIGN_INS` is `WAITING` with `latestEventAt: null` while holding 27
rows from the last 24 hours, and its latest `SIGN_INS` snapshot is stamped
`M365_AUDIT_STS`. That is consistent with the entitlement fallback at
`tenant-sync.service.ts:4087` having fired: rows collected via the Management
Activity path, the window attested as `M365_AUDIT_STS`, and
`selectedAuthenticationSource` still choosing `GRAPH_SIGN_INS` from the sync
proof — so `window.source !== selected` fails at
`authentication-source-readiness.ts:58` and the Graph source never becomes
ready.

I have not confirmed it; the confirming query is one column:

```sql
-- Q12  Were dcb2a091's recent rows collected via the fallback?
SELECT count(*) FILTER (WHERE microsoft_sign_in_id LIKE 'management:%') AS fallback_rows,
       count(*) FILTER (WHERE microsoft_sign_in_id NOT LIKE 'management:%') AS graph_rows
FROM sign_in_logs
WHERE customer_tenant_id = 'dcb2a091-ecf5-4bda-8780-a33bfb1b4d63'::uuid
  AND event_date_time > now() - interval '24 hours';
```

`fallback_rows = 27` confirms it. **Days**, and it is a licensing question as
much as a code one.

## Where that leaves the original question

Three tenants, three faults, and **none of them is the detectors being wrong**:

- **83f23fe5** — evidence collected and seen; the rule is silenced by one
  unrecognised error code. Hours to confirm, days to fix properly.
- **dcb2a091** — premium path refused; the fallback collects but the rule waits
  on a source that never becomes ready. Days.
- **6facb85e** — no recent evidence; reports current because the window is
  stamped from the requested range. Hours for the distinction.

**Zero matches is not correct behaviour and it is not narrow rules.** The engine
has never been given a run it could complete.
