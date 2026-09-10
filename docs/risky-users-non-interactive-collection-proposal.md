# Proposal: collecting non-interactive sign-ins

**Status:** proposal only. No collector change is included in this branch.
**Requested by:** PM, who asked for volume and capacity implications before the filter
changes rather than after.

## The finding

`syncSignInLogs` in [`tenant-sync.service.ts:4051`](../backend/src/tenants/tenant-sync.service.ts)
builds exactly one filter:

```
createdDateTime ge <start> and createdDateTime le <end>
```

and requests `auditLogs/signIns?$filter=…&$top=1000`. There is no `signInEventTypes`
filter and no `$select`. Microsoft's documented default for that endpoint is interactive
user sign-ins, so non-interactive traffic is never requested and never stored.

That fully explains `isInteractive` being `true` on 100% of 2,635 collected Graph rows,
and it means the inert `isInteractive` predicate is a symptom, not the disease.

**What I read versus what I assert:** the filter, the absent `$select`, and the bounds
below are read from the source. "Graph's default is interactive-only" is Microsoft's
documented behaviour, not something measured here. The confirming test is cheap: issue one
scratch call with `signInEventTypes/any(t: t eq 'nonInteractiveUser')` against a tenant we
already read and compare row counts.

## Why this is not a one-line filter change

### The byte cap binds long before the row cap, and it throws

Current bounds (all in `tenant-sync.service.ts`):

| Bound | Value |
| --- | --- |
| `GRAPH_LOG_COLLECTION_MAX_MATERIALIZED_BYTES` | 8 MiB per collection call |
| `GRAPH_LOG_COLLECTION_MAX_ROWS` | 100,000 |
| `GRAPH_LOG_COLLECTION_MAX_PAGES` | 100 |
| `GRAPH_LOG_COLLECTION_DEADLINE_MS` | 10 minutes |
| `$top` | 1,000 |
| `INITIAL_LOG_LOOKBACK_DAYS` | 30 |
| `LOG_SYNC_OVERLAP_MINUTES` | 10 |
| `LOG_RETENTION_MONTHS` (`sign_in_logs.expires_at`) | 6 |

8 MiB across 100,000 rows would be 84 bytes per row, which no Graph `signIn` object
approaches. **The row cap is therefore unreachable and the byte cap is the only limit that
ever binds.** At a plausible 2–4 KB per stored row, the effective ceiling is roughly
2,000–4,000 rows per collection call.

That matters because `assertGraphCollectionBounds` **throws**. Exceeding the cap is not a
partial collection — it fails the sync, and the baseline is not advanced.

### The margin, rather than the estimate

A tenant's current interactive volume is roughly 1,300 rows per six weeks (2,635 across two
tenants). A 30-day initial backfill is therefore already within a factor of about two to
three of the byte ceiling.

Microsoft's documentation says non-interactive routinely outnumbers interactive; commonly
cited ratios run 5×–20×. I have not measured ours, and the proposal does not depend on the
figure: **at the low end of that range the initial backfill exceeds 8 MiB, and at the high
end it exceeds it by an order of magnitude.** The decision is robust to the estimate being
wrong by 4×, which is why I am citing the margin rather than defending a number.

Steady-state incremental syncs (10-minute overlap) are not the problem. The initial
backfill is, and so is any catch-up after an outage.

### Downstream, in order

1. **Collection fails rather than degrades.** Above.
2. **Retention multiplies.** `sign_in_logs` keeps six months, deliberately — longer than
   Entra's 7 days (Free) / 30 days (P1/P2), which the research names as a real competitive
   advantage. Six months of a 5–20× larger table is the storage question, and the database
   has daily-snapshot recovery only.
3. **Evaluation windows start truncating.** The risky-users loader reads `LIMIT 10001` and
   my layer caps at `MAX_ROWS_PER_RUN = 10_000`. A 24-hour window for a busy tenant can
   exceed that at 5×. It fails safely — excess rows are counted as
   `BATCH_LIMIT_EXCEEDED`, never vetoing the run — but it is real, silent-to-the-technician
   coverage loss unless the cap moves with the volume.
4. **Coverage honesty.** Today the layer reports coverage over rows handed to it, so it
   reports full coverage of a partial view and *cannot tell the difference*. Whatever is
   decided here, the coverage statement should say which event types were requested.

## Recommendation

Sequenced so that nothing lands before its capacity is known.

1. **Measure first, one scratch call.** Add the `signInEventTypes` filter in a throwaway
   call against one tenant, for one day, and record row count and materialized bytes. That
   gives the real multiplier and the real per-row size — replacing both estimates above
   with facts. No code change ships from this step.
2. **Decide the bound before the filter.** Raise `MAX_MATERIALIZED_BYTES`, or page
   non-interactive traffic in a separate windowed sync with its own budget. My preference is
   a separate sync: it keeps interactive collection working if non-interactive collection
   trips a bound, which is exactly the failure isolation the current single call lacks.
3. **Retire the dead row cap.** `GRAPH_LOG_COLLECTION_MAX_ROWS` is unreachable and reads
   like a live guard. Either make it reachable or remove it, so the next person to reason
   about bounds is not misled.
4. **Then add the filter**, backfill shortened to whatever step 1 shows is safe rather than
   the current 30 days.
5. **Then raise the evaluation caps** to match, and say in the coverage statement which
   event types were requested.

## What I am not proposing

- No change to what the detectors do with non-interactive events. Once collected they
  classify on their result code like anything else, and the `isInteractive` predicate stays
  disproved-as-inert until a control cohort exists for it.
- No change to retention. That is a storage and cost decision, not a classification one.
- Nothing in this branch. The collector is untouched.
