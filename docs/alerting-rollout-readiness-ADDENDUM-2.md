# Addendum 2 to `alerting-rollout-readiness.md`

For Engineer to apply. I am not landing it — the stale-index hazard has not changed.

Everything below is measured on this branch unless it says otherwise. Where a fact came from
production it says so and says who read it, because I have no production access.

---

## A. Replaces the opening paragraph's scope sentence

> Four artefacts, in the order they were asked for…

The release is no longer backend-only. **Four screens now carry this feature**, and the document
does not mention them because it was written before that scope existed:

- **the alert settings page** — where an MSP chooses what counts as urgent, and where a setting
  that cannot take effect is now named rather than shown as saved;
- **the notification inbox and the bell** — which now carry the alert type and the effective tier;
- **the Risky Users fleet screen** — the count, its coverage, and the icon;
- **the dashboard's Priority Action Queue** — a count that walked every tenant and let an
  unreadable one contribute zero.

Two of those were shipping a reassurance they had not earned. Both are fixed and verified.

---

## B. Goes into §3, *Migrations and rollback* — and one sentence there must be removed

### The rule is **forward migrations only**, and nothing is standing behind it

An earlier reading held that Prisma validates recorded checksums, so a post-application edit to a
migration would be caught at deploy. **It does not.** Measured at Prisma **7.9.1**, on a database
with all 59 migrations applied, with one applied migration's file then modified so its checksum no
longer matches the recorded one:

```
prisma migrate status  →  "Database schema is up to date!"     exit 0
prisma migrate deploy  →  "No pending migrations to apply."    exit 0
```

Neither validates it. `deploy` is what the container runs on every start, so **deploy is migrate**
and an edit to an already-applied migration is silent in exactly the place a guard was assumed to
be. (`migrate dev` is a different command; it was not tested and is not what ships.)

So the rule is not a discipline with a safety net behind it. It is the only thing standing there.
**A believed safety net is worse than a known gap, because it is the reason nobody looks.**

### Three in-place edits were made. Two are corrected; one is not

| migration | in-place edits | corrected forward |
|---|---|---|
| `20260912190000_alert_incidents_and_dispositions` | 2 | **yes**, by `dcca63e` |
| `20260912223000_alert_send_jobs` | 1 | **not yet** |
| `20260912120000_notification_incident_key` | 2 | **not needed** — checked, both routes converge |

`dcca63e` was verified by migrating four databases along four different routes and comparing their
**whole schemas** — columns, check constraints, keys, indexes, applied migrations. All converge on
a fresh migrate; zero failed migrations; a second deploy is a clean no-op; and stored rows are
translated (`RING`→`ACT_NOW`, `EMAIL`/`DIGEST`→`ACT_TODAY`) with **none dropped**.

**The uncorrected one.** `0a62f8d` widened `alert_send_jobs.message_id` and `.idempotency_key` from
`VARCHAR(200)` to `(400)` by editing the file. On a database that applied the original:

- `prisma migrate deploy` at the tip → *All migrations have been successfully applied*, exit 0
- the widths afterwards → **still 200**; a fresh database at the tip has **400**
- a **real** message id from the end-to-end run — 209 characters, produced by one ordinary
  finding — is refused with `22001 value too long`, **before and after** the deploy

It fails on the **first real alert**, not on a settings write: the commit is all-three-tables-or-
none, so no incident, no notification, no job, while Prisma reports a healthy database. The remedy
is a forward `ALTER COLUMN … TYPE VARCHAR(400)`, a no-op where they are already 400.

### The premise under all of this is now settled

*Read in production by PM, read-only.* **None of the three alerting migrations has ever been
applied to production** — `20260912120000`, `20260912190000` and `20260912223000` are absent from
`_prisma_migrations`. So those tables will be created fresh at the correct width, and the widening
migration matters for **every other database** — staging, developer machines, any QA cluster — and
not for production.

### The two older migrations are closed

`20260902090000_add_identity_risk_platform` (3 in-place edits) and
`20260829150000_add_workspace_audit_evidence` (1) predate this feature and touch tables holding
production data. *Read in production by PM:* both recorded checksums match the committed files, and
independently, both edits' timestamps predate the application. Two sources agreeing. **Nobody needs
to look at them before shipping.**

### If you ever compare a migration checksum

Prisma hashes the **bytes on disk**. A Windows checkout with CRLF records a different digest from a
Linux checkout with LF, for the same file, and **neither is wrong** — the same file legitimately has
two recorded checksums depending on where it was applied. Hash the bytes the other system hashed,
or you will measure your line endings. This nearly produced a report that the next deploy would
fail to boot.

---

## C. New section, after §2 — *What the screens say, and what they refuse to say*

Every result here comes from **rendering the real page** and reading what a person would see, icon
included, over fixtures registered before the code existed.

**The alert settings page.** A disposition is now a tier (`ACT_NOW | ACT_TODAY | RECORD_ONLY`),
not a delivery channel. A value outside that vocabulary is refused at the write — five ways, all
`400` or `403`, none writing a row — and the database refuses one directly too. The endpoint is
**not** public: no token, a forged token and a valid single-factor token are all refused, and none
of them writes.

**A setting that cannot take effect is named at both ends.** A stored key that is not a catalogue
id — a risk rule id, which is exactly what that column held before the rename — appears on the
settings page as an unrecognised key *and* in the intake report, with the reason. A run with no
such row names nothing.

**The fleet screen.** Five distinct empty states, and the green shield appears on exactly one:

| what happened | what it says | shield |
|---|---|---|
| every tenant assessed, nothing found | No users require review · *All 4 tenants in scope were assessed…* | **green** |
| some tenants unreadable | No users to review among the tenants HawkView assessed · *3 of 4 were not assessed (1 could not be reached, 2 returned no assessment): ten-1, ten-2, ten-3* | none |
| still loading | *…4 of 4 not assessed (4 still loading)* | none |
| no tenants connected | No tenants are in scope · *There is nothing to assess, which is not the same as nothing being wrong* | none |
| the tenant list failed | **HawkView could not determine which tenants to assess** · *Nothing here is a statement about your tenants, and no tenant has been assessed or cleared* | none |

The last two were one screen under a green shield until today.

---

## D. Goes into §*What is deliberately not in this release*

**A setting changes what the product SHOWS. It does not change how the product REACHES you.**

Re-measured at `ac6318f` with the same end-to-end probe that found the earlier gap — an HTTP write
through the settings endpoint, then a tick, then the rows it wrote:

| what the organisation stored | the notification's severity | send jobs |
|---|---|---|
| nothing (the catalogue says `ACT_NOW`) | `critical` | 1 |
| `ACT_NOW` | `critical` | 1 |
| `ACT_TODAY` | **`high`** | 1 |
| `RECORD_ONLY` | **`info`** | **0** |

So a choice is visible in the product, not only in the settings page. An earlier draft of this
addendum said a setting *cannot escalate*; that was measured before `73222f6` and **it is wrong** —
the effective tier owns the notification's tone.

**What is still deliberately absent is routing.** Both non-silencing tiers queue the same job
through the same channel. SMS is deferred, so `ACT_NOW` and `ACT_TODAY` differ in what a person
sees and not in how they are reached.

**Raising a tier above the catalogue's own judgement is unreachable today**, and for a reason worth
knowing rather than a defect: both alert types a setting currently reaches are already `ACT_NOW`,
so there is nothing below to raise. The mapping is a total table over the three tiers applied to
the *effective* tier, so it is direction-free and will apply the moment a reachable type sits lower.

**And one consequence an operator should know before an MSP lowers something.** `critical` rows are
shown in-app whatever an individual's notification switch says — an existing product rule, not a
new one. Lowering a type from `ACT_NOW` to `ACT_TODAY` therefore takes its rows out of that
always-shown set, so a person who has muted in-app notifications stops seeing them. That is the
organisation's setting interacting with an individual's, it is the intended reading, and it is a
real effect of lowering rather than a change of colour.

---

## E. Two open items an operator would want on the front page

1. **The widening migration** (§B) — needed for every database except production.
2. **The intake service's backstop reports the wrong phase.** When the tick throws outside its three
   guarded regions, the service logs `phase: UNKNOWN` and *returns* `phase: READING` with the work
   lost recorded as zero. The log is honest and the value is a guess, and `READING` is the phase
   that means *nothing was decided and nothing was lost*. `IntakePhase` has no `UNKNOWN` member, so
   the return type cannot say what the log says.

Neither blocks the record-only release. Both should be closed before anything drains the queue.
