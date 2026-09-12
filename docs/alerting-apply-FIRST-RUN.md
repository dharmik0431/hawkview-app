# The apply runbook, performed — first execution by anybody

**QA, against a disposable Postgres 15 on 127.0.0.1:55432, database `hvqa`, at engineer tip
`a98a514` in a detached worktree.** Synthetic fixture only. No production access, no production
data, no credential from anywhere.

Until now the runner's own header said it: *"NOTHING IN THIS FILE HAS BEEN RUN."* It has now.

## What was run, and what happened

| step | result |
|---|---|
| `save-mapping` | 47 writable / 319 type-undetermined / 0 subject-unresolved, **three sections separated and labelled by question** |
| `preflight` clean | PASSED — *"319 left alone by decision, not by refusal"* |
| `preflight` dirty | ABORTED, the moved row named with saw/now digests |
| `apply` | 47 rows, one statement, one transaction, receipt written |
| `verify` | VERIFY PASSED, the two `[  ]` lines reconciled by hand against step 1 |
| `revert` | 46 put back, 1 refused, 47 of 47 accounted for |
| apply after a post-preflight write | ABORTED by the in-transaction re-check, nothing written |
| **apply against a concurrent committed writer** | **ROWCOUNT MISMATCH 46/47, rolled back, nothing written** |

## F1 — BLOCKING. The migration this whole procedure depends on does not exist

`incident_key` and `episode` appear in code and docs and **in no migration and not in
`schema.prisma`**. `save-mapping` passes because it reads through Prisma and never selects them.
`STORE_QUERY` does, so **step 2 is where an operator meets it**:

```
Raw query failed. Code: 42703. Message: column "incident_key" does not exist
```

Reproduced deliberately by dropping the columns and running preflight. The runner's comment
anticipates the error and says the migration "is part of this work" — but it was never written,
and **the runbook has no step that creates them**, so "apply the migration" is not an action the
operator can take. Following the document end to end is currently impossible on any database.

**What I had to invent to proceed**, and it is a guess, not a specification:

```sql
ALTER TABLE notifications ADD COLUMN incident_key varchar(300), ADD COLUMN episode integer;
```

Types taken from `applyStatement`'s own casts; the length mirrors `dedupe_key`. **The real
migration still has to decide two things this document never states:** whether `incident_key`
is indexed, and whether the fields join `schema.prisma` — while they are absent from the
schema, every consumer other than these raw queries is blind to them.

## F2 — every `TENANT_INITIAL_SYNC` row is permanently unwritable, by construction

Not "waiting on its subject becoming resolvable". It cannot ever resolve:

```
tenant:<id>:initial-sync  ->  TENANT_INITIAL_SYNC
                          ->  TYPE_FOR_SHAPE  ->  monitoring.collector_failing
                          ->  declaration subject: COLLECTOR
                          ->  subjectFor(COLLECTOR) reads parseDedupeKey(...).resourceType
                          ->  the initial-sync regex sets tenantIdInKey ONLY
                          ->  resourceType is null  ->  SUBJECT_UNRESOLVED, always
```

The key shape has no segment that could carry a resource type, so no classifier and no future
data changes this. Ten such rows in my fixture were excluded 10/10 — 100% of the shape rather
than a sample.

Found by accident, and worth saying how: my first fixture used that shape for 10 of its 47
writable rows and `save-mapping` returned **37 writable, 10 subject-unresolved**. I checked
whether that was my fixture or the product before reporting either. It is both — the product
behaviour is real, and my fixture was wrong about which shapes are writable, which is how I
learned it.

**The runbook already says a large subject-unresolved count "is a finding". It does not say one
whole key shape contributes 100% of itself to that count, permanently.** Whether production
holds `tenant:*:initial-sync` rows I cannot see.

## What this run does NOT establish

- **The receipt's `previous` is all-null across all 47 rows**, so this run cannot tell a real
  read from the hardcoded null predeclared as equivalent in A2. That predeclaration is
  accurate and I did not close it: `n.incident_key IS NULL` in the write makes null the only
  reachable previous value, so no input on this path can.
- **366 / 47 / 319 is PM's production figure reproduced in a synthetic fixture, not measured.**
  I have no production access. The fixture was built to that shape; it does not confirm it.
- **My episode figures (15 numbered / 32 null) are artefacts of my fixture**, which joins no
  `DirectoryAuditLog` rows, so audit rows carry no occurrence time. Not production values.
- The 25-second block in the concurrency test is my own sleeping blocker, not the apply's cost.

## Cosmetic

The runbook's expected abort block ends `Re-run step 1`; the runner prints
`Re-run save-mapping`. The runner's wording is better. A note, not a defect.
