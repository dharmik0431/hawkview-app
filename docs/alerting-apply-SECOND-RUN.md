# The apply runbook, performed again — this time on a schema that has the columns

**QA, disposable Postgres 15 on 127.0.0.1:55432, fresh database `hvqa2`, engineer tip
`d9de7b9`.** Synthetic fixture at the stated production shape. No production access.

Companion to `alerting-apply-FIRST-RUN.md`, which is left exactly as written.

## F1 is fixed, and I confirmed it rather than taking the word for it

`20260912120000_notification_incident_key` exists, both columns are in `schema.prisma`, and the
composite index `(organization_id, incident_key)` lands. The runbook's own confirmation query
returns two rows, both nullable `YES`.

## Step 0 idempotency — one of the two cases is safe, the other wedges the database

| the operator | what happens |
|---|---|
| runs step 0 twice on a clean database | **safe.** `No pending migrations to apply.` |
| half-ran it before — columns present, migration never recorded | **fails, and poisons the migration table** |

The second case:

```
Database error code: 42701
ERROR: column "incident_key" of relation "notifications" already exists
```

and then **every subsequent migration is blocked**, not only this one:

```
Error: P3009
migrate found failed migrations in the target database, new migrations will not be applied.
```

It needs `prisma migrate resolve` by hand to clear. **The migration uses bare `ADD COLUMN` and
`CREATE INDEX` with no `IF NOT EXISTS`**, so a database that already has the columns cannot
converge — it can only fail and leave a failed-migration row behind.

**This is reachable, and partly my doing:** the workaround DDL I published in the first-run
record puts an operator in exactly this state. Anyone who ran it to get past the old step 2 now
has the columns and no migration record.

**One-line fix:** `ADD COLUMN IF NOT EXISTS` on both, `CREATE INDEX IF NOT EXISTS` on the index.

## The 44 upper bound — measured, then attacked

At the canonical shape (319 audit, 3 initial-sync, 17 recoveries all recovering sync alerts,
27 plain writable):

```
44 writable, across 44 incidents
319 waiting on the classifier (the key shape does not type)
3 NEVER writable - the key shape cannot name what its subject reads
0 typed, but this row's subject did not resolve
```

**44, with the NEVER line reading exactly 3.** The recovery ruling reaches all 17.

**Then I broke it on purpose**, to check the line is an instrument and not a constant: five
recoveries rewritten to recover a `connection` alert, which names no resource type. Result
**38 writable, NEVER 9** — the shortfall lands exactly where the runner says it will. The line
does what it is advertised to do, so the reading of 3 is a measurement and not a default.

**What that still does not tell anyone:** whether production's 17 recoveries all recover sync
alerts. Mine do because I built them that way. The number Dharmik gets is whatever that line
prints on production data.

## Two of the three exclusion reasons collapse — in the preflight, not in the data

The data keeps all three apart. `mapping.json` carries `TYPE_UNDETERMINED` (319),
`SHAPE_CANNOT_NAME_SUBJECT` (3) and `SUBJECT_UNRESOLVED` (0) as distinct codes, and the
`figures` block carries them as distinct fields. **Step 1 prints them on three lines.**

**Step 2 and step 3 do not.** Both print one merged number:

```
322 left alone by decision, not by refusal.
```

`decision.run.excluded.length` — 319 + 3. The distinction that survives there is
decision-versus-refusal, which is the one the code comments defend. The distinction that is
lost is **waiting-on-the-classifier versus never**, and it is lost at the step an operator reads
immediately before authorising a write.

**Why it matters:** when the classifier lands, an operator who remembers "322 left alone" will
expect 322 to go to 0. It goes to 3. That is the same two-questions-one-number shape the three
headings were introduced to prevent, reappearing one step later.

The fix is presentational and the data already supports it: print the split in the preflight.

## A latent mislabel in the recovery walk — NOT reachable today

`resourceTypeFor` follows `recoveryOf` for **at most 8 hops** and then returns null, which files
the row under *"NEVER writable — the key shape cannot name what its subject reads"*. For a chain
deeper than 8 that label is wrong: the shape **can** name the subject, the walker stopped
looking. I built a 9-deep chain over a key ending `:sync:deep-resource` and it was reported as
permanently unwritable.

**It cannot happen today, and I checked rather than assumed.** Recovery keys are built in one
place — `notifications.service.ts:330`, appending `:recovered:N` to the key passed to
`resolveIncident` — and all four production callers pass a freshly-built non-recovery key
(`tenant:<id>:sync:<resource>`, `tenant:<id>:connection`). Maximum depth is 1. The loop is
defensive, and the bound is unreachable unless somebody later resolves a recovery.

Worth a comment on the `return null`, saying that exhausting the hops is *unknown*, not *never*.
Not worth a fix.

## All five, end to end, on the migrated schema

Step 1 as above. Preflight passed. Apply wrote 44 rows in one statement in one transaction,
`Watched fields disturbed: none`. Verify passed, with 26 + 18 = 44 reconciling by hand against
step 1's `18 unnumbered`. Revert put 43 back and refused 1 that somebody else had re-keyed,
44 of 44 accounted for, while 15 occurrences that arrived after the apply did **not** cause a
refusal — the two scopes hold on the migrated schema as they did on the improvised one.

Measured in SQL afterwards: 365 unkeyed, 1 still keyed (the refused row), **0 audit or
never-writable rows keyed at any point.**

The refused row was a recovery, which is a useful accident: it shows the new ruling's key
reaching the database — `monitoring.recovered`, subject `COLLECTOR`, resource
`recovered-resource-17` — a record-tier incident of its own rather than merged into what it
recovered.
