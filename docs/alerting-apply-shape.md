# Step 03 apply: the shape, before anything is written

Approved: the mapping the dry run produces — 364 alerts, nine forms, six key shapes, 317
directory-audit rows consolidating to **71 episodes** (62 attributed + 9 standing alone), and
47 rows whose episodes are unrecoverable.

**Nothing here has run. Nothing has been written.** This is the shape, as asked.

## Two findings from the schema that change the shape

### The migration cannot re-key. It can only annotate.

```prisma
model Notification {
  dedupeKey  String  @map("dedupe_key")
  @@unique([organizationId, dedupeKey])
}
```

**317 rows collapsing to 71 incidents means 317 rows would have to share 71 dedupe keys, and
the unique constraint forbids it.** So "the migration is a re-keying" is not literally
available: rewriting `dedupeKey` to a consolidated incident key either violates uniqueness or
requires deleting 246 rows — and deleting them breaks the constraint that the underlying events
are preserved.

**So the apply adds columns and modifies nothing that exists.** Consolidation is expressed by
many rows sharing an `incident_key`, not by fewer rows existing.

This is not a workaround. It is the shape the constraints already imply, and it makes three
other requirements fall out for free — see reversibility, delivery and idempotency below.

### `NotificationUserState` is the second reason

Read and dismissed state is per notification id, cascading on delete. Consolidating by deleting
or merging rows would **silently discard which alerts a person had already read.** Nobody would
notice until an MSP's list came back unread. Annotating cannot do this, because the rows the
state points at are untouched.

## PM's three questions

### Is it idempotent if run twice?

**Yes, and the two outcomes stay distinguishable rather than collapsing into "no change".**

The apply populates two previously-null columns with values that are a pure function of the
row. Running it again computes the same values. But *already applied* and *nothing to do* are
different facts, so the executor reports per row:

| outcome | meaning |
|---|---|
| `APPLIED` | the columns were null and now hold the mapping |
| `ALREADY_APPLIED` | they already held **exactly** these values |
| `DIFFERS` | they hold **different** values — refused, not overwritten |
| `REFUSED_ROW_CHANGED` | the mapping inputs moved since the plan was computed |

`DIFFERS` is the one that matters. Merging it into `ALREADY_APPLIED` would let a second
migration silently overwrite a first, and the report would say "already done".

### What happens to a row that has changed since the dry run measured it?

**It is refused, individually, and named in the report.**

Each planned write carries a fingerprint of *the mapping's inputs* — `dedupeKey`,
`occurrenceCount`, and the joined audit record's `event_date_time`. At write time the
fingerprint is re-checked; a mismatch refuses that row and continues.

**The fingerprint deliberately excludes `resolvedAt`, `updatedAt` and the user states**, because
a row that was resolved since the dry run still maps to the same incident. Fingerprinting the
whole row would let unrelated churn block the migration — which sounds safe and is the failure
where you re-run six times and it never completes.

**That choice is a decision, not a detail**, so it is written here rather than buried: the
migration treats a change to the *mapping inputs* as invalidating, and everything else as not.

### How does a partial failure leave the table?

**Untouched.** 364 rows is one transaction, so the outcomes are: fully applied, or nothing.

There is no batching and therefore no resumable half-state to reason about. If the row count
ever grows past what one transaction should hold, that is a different design and it needs a
per-row applied marker before it is written — not a batch loop added to this one.

## Reversibility, stated plainly

> **To revert: set `incident_key` and `episode` to NULL for every notification where they are
> not null. Nothing else changes.**

That is the whole procedure. It is short because the migration only ever writes two columns
that were null before it and that nothing else writes — so the previous value is known by
construction rather than recorded in a journal.

**No journal is needed, and that is a property of the shape rather than an omission.** A
journal exists to remember a value you overwrote; this overwrites nothing.

**What is not reversible: nothing.** No row is deleted, no existing column is modified, no user
state is touched.

## No historical alert is delivered

Three independent reasons, and the third is the one that is not mine to guarantee:

1. **The apply writes only two new columns.** It does not touch `first_occurred_at`,
   `last_occurred_at`, `state`, or `resolved_at` — the fields anything watching for new activity
   would read.
2. **The plan has no variant that can emit.** Its writes are `SET_INCIDENT_KEY` and
   `SET_EPISODE`; there is no enqueue shape to construct, so "must not deliver" is not a rule
   somebody could forget.
3. **Nothing downstream turns a row update into a delivery** — and this is the part I checked
   rather than assumed. `notifications.service.ts` reads and upserts on the request path; there
   is no trigger, poller or subscriber on the table. **But that is a fact about today's code,
   and the migration cannot enforce it.** If delivery ever becomes update-driven, this
   guarantee weakens silently, so it belongs in the "what to check first" list rather than in
   the reasons this is safe forever.

## The episode column

Nullable, **no default**. A default would say every existing row is episode 1, which is a claim
about 364 rows nobody measured. Null means *not computed*, and the **47 unrecoverable rows stay
null permanently** — which is the honest state and, crucially, distinguishable from episode 1.

Same reasoning as the nullable coverage column added earlier in this repo, and the same reason
`incidentsWithUnrecoverableEpisodes` is not counted as one each.

## The re-measurement, made structural rather than procedural

> *"An approval is for a mapping, not for a procedure."*

Agreed, and it should not depend on somebody remembering to look. **The apply takes the
approved figures as an argument and refuses to write if what it measures now differs:**

```
applyApproved(rows, approved: { total: 364, episodes: 71, attributed: 62,
                                standingAlone: 9, unrecoverable: 47 })
```

A drift is not an error to suppress — it is the report Dharmik needs to see before anything is
written. So the refusal prints the old and new figures side by side and writes nothing.

## What I cannot do, and who it needs

**I cannot re-run the dry run against production.** This worktree has no production access and
the release hold forbids it. That request needs someone who has both.

The apply itself writes to production data, which is the same category. **I can build it,
test it against fixtures, and hand over the exact command — I cannot run it**, and I would not
without Dharmik saying so directly rather than relayed.

## What to check first when this breaks

1. **Did a row get `DIFFERS` rather than `ALREADY_APPLIED`?** That is two migrations disagreeing,
   and the second must not win by being later.
2. **Are any `incident_key` values shared across organisations?** They should not be — the key
   carries the organisation — and if they are, the encoding has regressed.
3. **Did anything get delivered?** Check the notification send path for activity in the apply
   window. Reason 3 above is a fact about today's code, not a guarantee.
