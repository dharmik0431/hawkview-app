# Launch wiring — the shape, before any migration

**Asked for before code, and this is that.** No migration written, no table created. Four
questions need answering first and three of them change what gets built.

**The central claim is confirmed, and it is worse than "no scheduler".** Nothing outside
`src/alerts/` imports anything from it. Not one file. `intake`, `route`, `statements`,
`applyLimit` and `fold` have **zero callers** in the application.

```bash
grep -rn "from '.*alerts/" --include=*.ts src | grep -v "^src/alerts/"   # no output
```

Five closed steps are a library nobody calls. **Say that in front of any status that lists them
as done** — they are done as designed and unreachable as shipped.

## Three premises that need correcting first

### 1. The findings ARE persisted. It is the telling that is missing.

`identity-risk-evaluator.service.ts:1573` upserts every finding into **`IdentityRiskFinding`**,
keyed on a sha256 of `(organizationId, customerTenantId, subjectType, subjectId, ruleId, bucket,
engineVersion)`, with a real `state` of `OPEN` / `UNKNOWN` / `EXPIRED`.

So "the engine produces findings every five minutes and tells nobody" is exactly right about
**telling** and wrong about **producing into a void**. The findings are durable and queryable
now. That makes the wiring job substantially smaller than building persistence: step 04's
`intake` needs a real table to read, and it already exists.

### 2. A preferences store already exists, and its grain disagrees with the plan

**`NotificationPreference`** — and it is per **user × organisation**, with four category
booleans (`securityEnabled`, `connectionEnabled`, `synchronizationEnabled`, `accountEnabled`),
`minimumSeverity`, `inAppEnabled`, `emailEnabled` and `digestMode`.

The plan says **per-MSP, per-rule, and the twenty rule ids are the grain**. Those are three
disagreements, not one:

| | exists | planned |
|---|---|---|
| who | per user | per organisation |
| what | four categories | twenty rule ids |
| when | no quiet hours | quiet hours |

**This is the decision I need, and it is not a detail.** Routing reads preferences; whichever
grain it reads is the grain the product has. Adding a second store beside this one gives two
places that can disagree about whether somebody wants an email — which is the failure this
whole feature has spent its length refusing.

**My recommendation: extend `NotificationPreference` rather than add a table, and keep the user
grain.** An MSP-level default with a per-user override is two levels and two writers; a single
per-user row with a seeded conservative default is one. Rule-level dispositions can live in a
JSON column keyed by rule id, with the four category booleans kept as the coarse switch they
already are. If you want organisation-level instead, say so — but then something must own the
collision between an MSP default and a user who turned email off.

### 3. `emailEnabled` DEFAULTS TO FALSE, and that is a launch blocker wearing a default's clothes

Every existing preference row has email off. Wire the flow perfectly and **zero emails arrive**,
the acceptance checklist reads "no email", and the next hour goes into debugging wiring that
works.

Three ways out, and this is a product decision: seed it to true for the launch organisations,
default it to true for new rows, or make the acceptance checklist explicitly turn it on as its
first step. **I would take the third** — it is the only one that does not change a stored
preference somebody may have set deliberately, and it puts the switch in front of the person
verifying the launch. But it must be decided rather than discovered.

## The shape question: where lifecycle state lives

Step 03 gives `notifications` an `incident_key`, so an incident is a set of rows sharing one.
What has no home is the lifecycle — condition, ownership, investigation.

**Three candidates, and only one survives.**

**Columns on `notifications`.** Wrong, and demonstrably: an incident spans many rows, so the
state would be stored N times with nothing making the copies agree. Acknowledging an incident
would be N writes, and a partial failure leaves an incident half-acknowledged with no way to
tell. This is the two-fields-one-fact failure at table scale.

**Columns on `IdentityRiskFinding`.** Wrong for a different reason: not every incident comes
from a finding. Step 03 is migrating notifications produced by tenant sync and directory audit,
which have no finding at all. Putting the lifecycle there gives half the incidents a home.

**Its own table, keyed by `incident_key`.** The only one where the state exists once per
incident, and it falls out of what `incident_key` already is: a stable identifier for a set of
rows. One row per incident per organisation, holding the three axes, ownership, and the
timestamps each axis moved.

**So: a new `alert_incidents` table, `@@unique([organizationId, incidentKey])`.** It is a
projection over notifications rather than a parent of them — nothing cascades, and an incident
row missing for a keyed notification is a reportable gap rather than a broken foreign key.

**Not written yet.** Tell me the grain answer and the email-default answer and I will write it
with the same treatment step 03 got: idempotent, type-checked before adding, reversible, and
tested against a throwaway Postgres from four starting states.

## What I judge to be a launch blocker

**The test: does it make the flow wrong, silent, or unrecoverable?**

**Blockers.**

1. **Nothing calls the alerts engine.** The whole scope.
2. **Nothing sends email.** No Resend client exists in the codebase — `emailEnabled` is a field
   name and nothing reads it to send anything. Step 06 is a seam and an unverified signature
   check, not a channel.
3. **`emailEnabled` defaulting to false** — silent, and indistinguishable from broken wiring.
4. **No delivery outcome is recorded anywhere.** Step 06's ledger is a value in memory. A bounce
   that nobody stores is the same silence as no email at all.
5. **The preference grain disagreement**, because routing cannot be written until it is settled
   and rewriting it later means rewriting what reads it.
6. **A working production connection.** Nobody has one. It blocks step 03, which blocks the
   incident key everything else keys on.

**Not blockers — post-launch backlog, written to a file so it is a document rather than a
memory.** The 319 awaiting the classifier, the hop-limit label, the partial index, the
subject-line leak in step 06, and the A2 receipt equivalence. See
`alerting-post-launch-backlog.md`.

**One I cannot classify without you: the 319.** As a *migration* item it is backlog — the rows
sit unkeyed and nothing breaks. But those 319 include the directory-audit rows, and if Green
Technology's acceptance checklist expects to see privileged-change alerts, then the launch does
not deliver what they were shown. **That is a product question about what was promised**, and I
do not know what they were told.

## What I have not done, and why

- **No migration.** You asked to be told the shape first.
- **No handoff rewrite yet.** It should be rewritten as current truth once these decisions land,
  or it will be rewritten twice.
- **The four rollout artefacts are not startable yet.** The release commit needs the work to
  exist; end-to-end results need a connection and a Resend key; rollback readiness needs the
  migrations these decisions produce. The acceptance checklist can be drafted early and should
  be, because writing it will expose what the flow does not yet do.

## Three items reported as open that are not

Verified against the tree, with commits, because they have now been listed three times:

- The merged left-alone number at steps 2 and 3 — `leftAloneLines`, **`1ea8077`**.
- The hop-limit label — `RECOVERY_CHAIN_TOO_DEEP`, **`1ea8077`**.
- The connection section — runbook *Connecting*, **`b6088f2`**.

Cross-session messages have been refused more than twenty times, so commits are the only channel
delivering. That is why this is a file.
