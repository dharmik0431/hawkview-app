# `dcca63e` verified — and a third in-place edit it does not correct

Two probes: `backend/qa-migration-converge.mjs` (four routes, full schema comparison) and
`backend/qa-migration-third.mjs` (the edit the first probe could not reach).

**The instrument is a schema comparison, not a checklist.** Asking "did it fix the constraint" tests
the thing I already knew to look for. Four databases are migrated by four different routes and
their whole schemas compared — columns, check constraints, keys, indexes, applied migrations — so
anything that failed to converge shows up whether or not I thought of it.

## The correction works, in both directions

| route | result |
|---|---|
| migrated before the first in-place edit of this feature, then brought forward | **converges on fresh** |
| migrated where the table exists as it was actually applied (`rule_id`, channel CHECK), seeded, then brought forward | **converges on fresh** |
| migrated at `6fdfa4a` — the half-corrected state — then brought forward | **converges on fresh** |
| a second `deploy` on that one | `No pending migrations to apply` |

Zero failed migrations on any of them. No `P3009`, no partial state.

**And the rows survive and are translated as documented.** Starting from a database holding
`RING`, `EMAIL`, `DIGEST`, `RECORD_ONLY` under the column named `rule_id`:

| before | after |
|---|---|
| `RING` | `ACT_NOW` |
| `EMAIL` | `ACT_TODAY` |
| `DIGEST` | `ACT_TODAY` |
| `RECORD_ONLY` | `RECORD_ONLY` |

Four rows in, four rows out — **none dropped**, which is the part a translation can quietly get
wrong. Afterwards `ACT_NOW` is accepted and `RING` is refused with `23514`. The column is
`alert_type_id`.

**And `20260912190000` is restored to the exact blob it had before the first edit** — `e0fc8a6f`,
byte-identical — so the checksum a database recorded matches the file again. Not a rewrite that
happens to be equivalent.

So: it corrects where correction is needed, it is a no-op where it is not, and it is not a
migration that "works" by doing nothing.

---

## The third edit, and it is not corrected

`git log --diff-filter=M` on the migration directory does not list two edits. It lists ten, across
five migrations:

| migration | in-place edits | corrected forward |
|---|---|---|
| `20260912190000_alert_incidents_and_dispositions` | 3 (one is `dcca63e`'s restore) | **yes** |
| `20260912223000_alert_send_jobs` | 1 | **no** |
| `20260912120000_notification_incident_key` | 2 | not needed — see below |
| `20260902090000_add_identity_risk_platform` | 3 | unexamined (earlier feature) |
| `20260829150000_add_workspace_audit_evidence` | 1 | unexamined (earlier feature) |

### `0a62f8d` widened two columns in place, and a deploy does not carry it

It changed `alert_send_jobs.message_id` and `.idempotency_key` from `VARCHAR(200)` to `VARCHAR(400)`
by editing `20260912223000`.

**My first probe did not exercise this**, and I want that recorded rather than glossed: the route I
used starts before that migration existed at all, so it only ever applied the widened version.
Reachable is not reached, and a route that never met the old file proves nothing about a database
that did. The second probe starts at `0a62f8d^`, where the migration exists in the form that was
actually applied.

| | |
|---|---|
| widths on that database before | `alert_send_jobs.message_id` **200**, `idempotency_key` **200**, `alert_send_attempts.message_id` **200** |
| `prisma migrate deploy` at the tip | `All migrations have been successfully applied.` — exit 0, zero failed |
| widths **after** | **still 200** |
| widths on a fresh database at the tip | **400** |

**And a real message id does not fit.** Taken verbatim from the U1 end-to-end run earlier today —
not invented to be long, just what `incident/${scoped}` produces for one ordinary finding — it is
**209 characters**, and the insert is refused with `22001 value too long for type character
varying(200)`. Before the deploy and after it.

That is nine characters over, with synthetic short ids. A real subject id is a UUID or a UPN and an
alert type id may be up to 64 characters, so 209 is a floor rather than a typical case.

**What happens on such a database:** the first tick that decides to send anything fails on the
write. The commit is all-three-tables-or-none, so no incident, no notification, no job — the tick
reports `FAILED` / `WRITING` (which `28b6ddd` now makes legible), and Prisma reports a healthy,
fully-migrated database. It fails on the **first real alert**, not on a settings write, which makes
it worse than the two that were corrected.

**The remedy is the same shape as the one that just worked:** a forward migration doing
`ALTER TABLE … ALTER COLUMN … TYPE VARCHAR(400)` on all three columns, which is a no-op where they
are already 400.

### `20260912120000_notification_incident_key` does not need one

Its two edits (`1ea8077`, `65349ff`) changed a guard and made the `ADD COLUMN` idempotent. A
database that applied the original has the column at `varchar(300)` — the same end state the edited
file produces — so old and new converge, and the convergence run confirms it: that route reaches
the fresh schema exactly. **Registered, checked, found not to apply**, which is different from not
checked.

### Two older migrations, named rather than assessed

`20260902090000_add_identity_risk_platform` (3 edits) and `20260829150000_add_workspace_audit_evidence`
(1) predate this feature and touch tables that carry production data. I have not examined them and
I am not going to guess: the same probe pointed at the commit before each edit would answer it, and
it is a short job for whoever owns that area.

---

## The same premise as before, and the same answer

All of this matters only if some database applied the pre-edit file. I did not check production and
will not. **The remedy does not depend on the answer** — a forward migration is correct whether or
not the premise holds, which is the whole point of the rule this commit establishes, and the reason
the rule should be applied to the third edit as well as the two.

## One instrument note

My first convergence run produced no output for twenty minutes and then died with
`database "hvmigold" is being accessed by other users`. An earlier run of the same probe was still
alive and holding a connection, so the second run's `DROP DATABASE` blocked. Nothing was wrong with
the subject; a background task I had not stopped was. Worth the line because a probe that appears to
hang looks like a slow database, and I nearly went looking in Postgres.
