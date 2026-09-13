# Alerting — post-launch backlog

**A document rather than a memory.** Everything here was found, judged not to be a launch
blocker, and written down so the judgement is reviewable and the item is not lost.

**The test applied to each: does it make the flow wrong, silent, or unrecoverable?** If yes it
is a blocker and it is in `alerting-launch-shape.md` instead. Everything below fails that test
for a stated reason.

---

## 1. The 319 rows awaiting the classifier

**What.** `TYPE_FOR_SHAPE` maps `DIRECTORY_AUDIT` to `null` on purpose — the key shape does not
determine the alert type, and defaulting it would file real privileged changes as routine. Those
rows are excluded from the step-03 migration and wait for the classifier to be pointed at
historical audit rows.

**Why not a blocker.** The rows sit unkeyed. Nothing breaks, nothing is silently wrong, and the
migration reports them as a decision rather than a failure.

**⚠ CAVEAT THAT COULD PROMOTE IT.** These are the directory-audit rows, and the 301 unclosable
alerts are among them. **If Green Technology were shown privileged-change alerting as part of
what launches, this is a blocker and not a backlog item** — the launch would not deliver what
they were shown. Nobody has told me what they were promised. **Somebody must check that before
this list is accepted.**

**Size.** Scoped: the classifier exists, it is not wired to historical rows.

## 2. The hop-limit label

**What.** `resourceTypeFor` follows a recovery to what it recovers for at most eight parses.

**Why not a blocker.** Unreachable — recovery keys are built in one place and every caller
passes a freshly-built non-recovery key, so maximum depth in production is 1 against a limit
of 8. And exhausting it now reports `RECOVERY_CHAIN_TOO_DEEP` (unknown) rather than "never
writable", so even if it fired the label would be honest. Fixed in `1ea8077`; what remains is
only the theoretical depth.

**Size.** Nothing to do unless recovery-key composition changes.

## 3. The partial index on `incident_key`

**What.** `WHERE incident_key IS NOT NULL` would be much smaller — 44 of 366 rows are keyed, and
the ratio stays lopsided until the classifier lands — and every grouping query filters on
non-null.

**Why not a blocker.** Correctness-neutral. The composite index that exists serves every query;
this one would serve them with less memory.

**Why it was declined rather than deferred by accident.** Prisma's schema cannot express a
partial index, so it would live only in the migration SQL and read as drift on every
`migrate dev`. **A false drift alarm every time somebody regenerates is worse than a slightly
larger index on a small table.** Revisit if this table grows and the ratio stays low.

## 4. The subject line is not modelled — step 06's next leak

**What.** `BodyLine` has no slot for a name, an address, a tenant, or free text, and the deep
link is an opaque id rather than a path. **The subject line is not modelled at all.**

**Why not a blocker for launch.** Whatever composes the subject does not exist yet either, so
nothing is leaking today.

**Why it is the first thing to do when it does.** A body with no slot for a customer name,
under a subject line that has one, is the same feature failing — and the subject is the part
that shows in a notification preview, on a lock screen, and in a mail client's list view.
**Model it the way the body is modelled: a closed vocabulary with no free-text slot**, not a
check on what somebody put there.

## 5. The receipt's `previous` field cannot be distinguished from a hardcoded null

**What.** `ApplyReceipt.changed[].previous` is all-null across every row, because only a
null-keyed row is ever written. A mutation replacing it with a literal `null` survives the whole
suite.

**Why not a blocker.** The field is carried because a revert that reads a recorded value is the
shape that stays correct if a later migration ever writes over a non-null key. It is right, and
today it is unverifiable.

**Predeclared, not discovered.** This was stated as an equivalent mutation before the run, and
QA confirmed the predeclaration was accurate rather than closing it. **Leave it stated. Do not
contrive a fixture to close it** — a fixture that made it distinguishable would have to feed the
apply an input it is designed to refuse, which tests the fixture.

## 6. `windowReadableThroughout` has no evidence to work from

**What.** It needs a collection-attempt history and the database does not keep one. `SyncState`
is current state; `TenantHealthSnapshot`'s density depends on who opened the tenants page.

**Why not a blocker.** Exactly one declared type resolves that way
(`security.suspected_credential_attack`), and its investigation is `ONLY_BY_A_PERSON`
regardless — so what is lost is the condition axis moving to cleared, not an incident stuck in
somebody's queue. Verified against the catalogue: 1 of 7.

**Size.** A schema decision (a collection-attempt history), deliberately deferred rather than
derived from "no failure rows in the window", which fails in the unsafe direction.

## 7. `UNMEASURED_LIMIT` is a guess

**What.** Twenty deliveries per MSP per tick, carrying the sentence *NOT YET MEASURED*.

**Why not a blocker.** It withholds rather than drops, and releases what it withheld, so a wrong
number delays a message rather than losing one. Contrast `STALE_AFTER_MS`, which carries 5,166
runs behind it.

**Size.** One measurement: observed causes per MSP per tick on production data. **Do it after
launch produces that data**, not before by guessing harder.

## 8. `IdentityRiskFinding.ruleId` has no declared alert type

**What.** Three distinct rule namespaces exist — 7 `ALERT_CATALOG` ids, 28 `CHANGE_RULES`, and
`IdentityRiskFinding.ruleId` — and the third has no mapping to an alert type.

**Why not a blocker for the launch flow.** The launch path routes what the catalogue declares.

**Why it will become one.** The moment routing is driven by findings rather than by
notifications, a finding whose rule id maps to no alert type has no route, and the failure will
be silence. **Check this before wiring intake to findings**, not after.

## 9. The repository has pre-existing schema drift, and it is large

**What.** `prisma migrate diff` between a database freshly built by `migrate deploy` and
`schema.prisma` emits roughly eighty statements — RenameIndex, RenameForeignKey and
`ALTER COLUMN … DROP DEFAULT` — across identity-risk, directory and notification tables that
nobody touched. Found while verifying the launch migration. **None of it is caused by the
alerting work**, and the alerting tables themselves come back clean.

**Why not a blocker.** It is naming and defaults, not structure. The deployed database and the
model describe the same tables; Prisma would like the constraints named differently.

**Why it is a trap.** Anyone who runs `prisma migrate dev` gets a vast spurious migration
containing all of it, and will either commit it or spend an afternoon working out why.
**Whoever touches the schema next should expect this and not read it as their own mistake.**

## 10. Quiet hours have two possible timezones and no rule

**What.** The two-grain ruling puts quiet hours at the user grain. Both `users.time_zone` and
`organizations.time_zone` exist and **both are nullable** — so "do not email me at 2am" has no
defined answer when a user has no timezone, and none at all when neither does.

**Why it is not in the migration.** This is why quiet hours were left out of
`20260912190000_alert_incidents_and_dispositions`. Building the column before the fallback is
decided means building the wrong column. Everything that did not depend on the answer was built.

**What needs deciding.** The chain — user, then organisation, then what? — and the both-null
case. UTC is the obvious last resort and it is also the one that silently emails somebody at 2am.

## 11. `digestMode` and the DIGEST disposition may be the same fact twice

**What.** `notification_preferences.digest_mode` already exists, and `DIGEST` is one of the four
dispositions an MSP can now set per rule. If both are read at delivery time, two stores answer
*should this be batched*.

**Why not a blocker today.** Nothing reads either at delivery time, because nothing delivers.

**Why to settle it before wiring.** This is the two-places-one-fact shape, and it is far cheaper
to resolve before something depends on both. The likely answer is that the disposition decides
whether a rule batches and `digest_mode` decides the cadence of the batch a person receives —
two different facts — but that needs stating rather than assuming, which is exactly how the
first three instances of this got in.
