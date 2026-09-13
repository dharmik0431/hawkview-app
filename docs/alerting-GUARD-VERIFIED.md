# The migration guard: it still discriminates — and one thing that is only transitionally true

## Engineer's claim holds

`65349ff` widened the guard to accept `varchar(300)` **or** `varchar(400)`. The claim was that
this is "a correction, not a loosening". **Measured against real clusters, one per width:**

| the column, made by hand | result |
|---|---|
| `text` | **REFUSED** |
| `varchar(100)` | **REFUSED** |
| `varchar(300)` | accepted — what this migration creates |
| `varchar(400)` | accepted — what the widening produces |
| `varchar(500)` | **REFUSED** |

`varchar(500)` is the row that settles it. A guard loosened to stop complaining would accept
anything wider; this accepts **exactly the two widths the migration chain produces** and refuses
everything else, including a hand-made column that is *more* generous than needed.

The message is also better than the one it replaces: it now says **DO NOT DROP THIS COLUMN IF IT
HOLDS DATA** and explains which migration produces which width — where the old one told a reader
on a correctly-migrated database to drop a column holding live incident keys.

## My first run of this was wrong, and it is worth saying how

My initial loop reported **all four widths accepted**, which would have been a false finding
against a fix that works. The detector grepped for `does not match the schema` — **the wording
the fix replaced.** The guard was firing loudly the whole time and my instrument could not see
it.

**That is "grep the old wording, not the new", and I wrote that rule down myself.** What caught
it was not the rule but a habit: the result was too clean. Four for four in the same direction,
against a change specifically made to preserve discrimination, was not a plausible shape — so I
looked at the raw output instead of the tally, and the guard was refusing `text` in the first
line of it.

## The question asked: does accepting both widths matter?

**A hand-made `varchar(400)` is harmless.** It is the correct final width, functionally identical
to one the widening produced. The guard exists to prevent a silently *wrong* column, not to
establish provenance — and the missing-migration-record case is already handled by `IF NOT
EXISTS` converging.

**Accepting `varchar(300)` is the one with a consequence, and it is not the hand-made case.**

The catalogue now carries a compile-time guard permitting an alert type id of up to **64
characters**, and its comment derives that number from the **400**-wide column. Measured:

| alert type id | incident key | fits 300 | fits 400 |
|---|---|---|---|
| 36 (today's longest) | 289 | yes | yes |
| 47 | 300 | yes | yes |
| 48 | 301 | **no** | yes |
| **64 (the permitted maximum)** | **317** | **no** | yes |

**So the two guards disagree by seventeen characters.** The catalogue permits ids that produce
keys too long for a 300-wide column, while the migration guard accepts one.

**My judgement: acceptable, with the caveat stated rather than assumed.** Refusing 300 would
re-break the exact bug `65349ff` fixes — a database mid-chain legitimately has 300 — so the guard
is right to accept it. The caveat is that **`300` is correct only as a transitional state**, and
nothing in the guard says so. A reader could take "300 or 400 are both valid" as a durable fact.
It is not: after the chain completes, 300 is a database that has stopped half way.

**Reachability:** latent. It needs a database left at 300 *and* an alert type id over 47
characters. Today's longest is 36 and the compile guard makes a long one a deliberate act. **No
action needed; it should be written down where the 64 is derived**, because that derivation is
the thing that quietly assumes 400.

## The test counts reconciled

Both numbers are true, of different commits, and neither contradicts the other:

- **My earlier ten-of-ten** was **five** tests, in one file, at `e98bf47`.
- **11/11** is **eleven** tests across **two** files at `65349ff` — three added with the verifier
  and the stop button, three more with the suppression store.

Re-run here five times at `65349ff`: **11 pass, 0 fail, every time.**
