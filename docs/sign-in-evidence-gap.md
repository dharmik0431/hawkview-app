# Two tenants have no recent sign-in evidence, and the product says they are current

Standalone because it is true today, independent of alerting, and survives
whatever happens to this release. Read-only analysis; no production access used.

## The measurement

From `sign_in_logs`, grouped by tenant:

| tenant | rows | in last 24h | newest event | last ingested |
| --- | ---: | ---: | --- | --- |
| 83f23fe5 | 2632 | 11 | 2026-09-13 14:34Z | 2026-09-13 14:45Z |
| dcb2a091 | 1908 | 27 | 2026-09-13 14:16Z | 2026-09-13 14:26Z |
| 27e8b142 | 1134 | 43 | 2026-09-13 13:15Z | 2026-09-13 13:25Z |
| **6facb85e** | 119 | **0** | **2026-09-10 13:56Z** | 2026-09-10 |
| **66735f04** | 9 | **0** | **2026-08-30 04:24Z** | 2026-08-30 |

Three days and two weeks respectively, against three tenants ingesting minutes
ago.

## A correction to how I first described this

I called it a stalled collector. **That is not what the data shows**, and the
distinction matters because it changes who fixes it.

The `SIGN_INS` snapshot for 6facb85e was observed at **2026-09-13 14:46:21Z** —
minutes before the measurement, with `paginationComplete: true`. So collection
**is running and is succeeding** for that tenant today. It is running, asking
Graph for a window ending now, completing the page chain, and receiving nothing.

So the two readings are:

1. the tenant genuinely has had no interactive sign-ins since 2026-09-10, or
2. Graph is returning an empty page chain for a reason that is not an error —
   permissions narrowed, licence lapsed, tenant disconnected.

Both are possible and **the product cannot tell them apart**, which is the
finding.

## Why it reports as current

`tenant-sync.service.ts:4181` calls `persistCompletedAuthenticationWindow(...)`
with the **requested** `start` and `end`, and it is reached whether or not
anything came back — the only preceding gate is
`if (records.length !== rows.length) throw`, which compares validated rows to
fetched rows, so zero-and-zero passes cleanly.

The function's own header is explicit:

> This metadata contains no events/identities.

So the window advances to "now" on every successful empty collection, and
`lastSuccessfulCollectionAt` advances with it. A tenant that has produced no
evidence for two weeks is indistinguishable, in every downstream surface, from
one that produced evidence a minute ago:

- source status `READY`
- freshness `CURRENT`
- `lastSuccessfulCollectionAt` current
- `latestEventAt` **null** — the only field that differs, and nothing reads it

That last line is the whole defect. The information needed to tell the two apart
is already carried on the DTO and nothing consumes it.

## Why this matters more than the zero-match question

An MSP looking at 6facb85e sees a tenant reporting healthy collection and zero
risky users. Both statements are true in the narrow sense and together they say
"this tenant is fine". What is actually true is "HawkView has had no
authentication evidence about this tenant for three days and cannot say whether
it is fine".

This is the same defect fixed on four screens today — a confident nothing
standing where the truth is that we could not look — except it is at the top of
the pipeline, so every screen below inherits it no matter how carefully each one
is written.

## What I would do about it

**Not a repair — a distinction.** The readiness DTO already carries
`latestEventAt` and `lastSuccessfulCollectionAt`. What is missing is anything
that reads both and says which of these a source is:

| | collected | has evidence |
| --- | --- | --- |
| `READY` + `latestEventAt` non-null | yes | yes |
| `READY` + `latestEventAt` null | yes | **no** |

The second row needs its own state and its own sentence — "collected
successfully, no authentication evidence in the window" — so that a screen can
say it, and so that "no risky users" is never rendered over it without that
qualification.

**Estimate: hours for the distinction, plus whatever rendering picks it up.**
It is smaller than the investigation that found it.

## What is not yet known, and the query for it

Whether 6facb85e and 66735f04 are quiet or blocked. One query separates them:

```sql
-- Sync outcomes for the two silent tenants. A run that errors, or a permission
-- or licence failure, distinguishes "blocked" from "quiet".
SELECT customer_tenant_id, resource_type, status,
       last_error_code, last_error_message,
       last_successful_at, last_attempt_at
FROM sync_states
WHERE customer_tenant_id IN (
  '6facb85e-7a71-472f-b5ea-2938ee25fe3b'::uuid,
  '66735f04-168d-4836-b23c-93a217f4a461'::uuid)
  AND resource_type IN ('SIGN_INS','USERS')
ORDER BY customer_tenant_id, resource_type;
```

- a `last_error_code` on `SIGN_INS` → blocked, and the code names the cause
- clean, with `last_successful_at` current → genuinely quiet, and the tenants
  are small (9 and 119 rows lifetime), which is consistent

Either answer leaves the distinction above worth building, because the product
should say which one it is.
