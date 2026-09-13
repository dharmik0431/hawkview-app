# `446ba90` + `09d9c8d` verified: the widening converges, and the phase no longer guesses

## 1. The third in-place edit is corrected, and it corrects in both directions

`backend/qa-migration-third.mjs`. Three routes, and the claim is settled by a **real** message id
rather than by reading the SQL.

| route | before | after `deploy` at the tip | a real 209-character message id |
|---|---|---|---|
| migrated at `0a62f8d^`, the file as it was **actually applied** | 200 / 200 / 200 | **400 / 400 / 400** | refused `22001` → **accepted** |
| migrated at `ac6318f`, the file **edited in place** to 400 | 400 / 400 / 400 | 400 / 400 / 400 — a clean no-op | accepted |
| fresh at the tip | — | 400 / 400 / 400 | — |

Both routes converge on the fresh schema. No failed migrations on any of them. The message id is
the one the U1 end-to-end run produced for one ordinary finding, not one invented to be long.

**And the restore is a restore.** `20260912223000` at `09d9c8d` is blob `212c1594…`, byte-identical
to its content at `0a62f8d^`. The widening lives in `20260913120000_widen_send_job_ids` as
`ALTER COLUMN … TYPE VARCHAR(400)` on all three columns — a no-op where they are already wide,
which the middle route above demonstrates rather than asserts.

### What "so the file matches the checksum" actually buys, since nothing checks it

The subject line claims a match that **no command performs**. Measured earlier and unchanged:
`prisma migrate status` and `prisma migrate deploy` both report health over an applied migration
whose file has been edited, at 7.9.1. So the restore buys nothing *at deploy time*.

What it does buy is worth having and is a different thing:

- **The file is an accurate record of what ran.** Anyone reading `20260912223000` to understand a
  database's schema now gets the truth rather than a later author's intention.
- **The change is expressed as a step every database passes through**, which is what makes the two
  routes above converge. That is the property that matters, and it is the one I measured.
- **A tool that does validate will not fire spuriously** — `migrate dev`, `migrate diff`, anything
  written later.

And one precision on the wording, because somebody will rely on it: the file matches the **content**
that was applied. Whether it matches a **recorded digest** depends on the line endings of the
checkout that applied it, since Prisma hashes the bytes on disk. Content is the durable claim;
digest is environment-dependent.

## 2. The backstop no longer guesses a phase

`IntakePhase` gained `UNKNOWN`, and the service's backstop returns it instead of `READING` — the
value now says what the log beside it always said. The zeros are kept and labelled: *the absence of
a measurement, not a measurement of absence.*

Re-running my fault injection at the tip, unchanged: each injected fault still names its own phase,
the three remain distinct, a yield is still a `RAN` and a failure still is not, and `attempted` on a
`WRITING` failure still equals what a healthy run over the same input wrote. **Adding a fourth
member did not disturb the three.**

## 3. My harness produced one false negative, and the fix is the same rule again

The first run reported `midForward: ok=false` for the already-wide route. Re-run and also reproduced
by hand, it succeeds — exit 0, the widening applied, no complaint. The failure was not reproducible.

**What made it hard to dismiss honestly is that my error capture kept only the last four lines of
stdout**, which for that run were the datasource banner — *a failure with no reason in it*. A report
that says something went wrong and cannot say what reads exactly like a finding about the subject.
It now captures the whole of stdout, stderr and the exit status.

Same round, the same shape twice: my insert fixture also omitted `attempts_made`, so
`DEPLOY_ACTUALLY_WIDENED_IT` read **false** while the widths plainly showed 200 → 400. The tell was
the contradiction between two of my own outputs — and the safe direction again, since a broken
fixture said *not fixed* rather than *fixed*.
