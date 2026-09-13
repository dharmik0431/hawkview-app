# Post-launch backlog — alerting

**Everything here is real and none of it blocks launch.** Each entry says what it is, why it is
not a blocker, and what would change that. Kept as a file rather than a memory so that "we knew
about it" is checkable.

Blockers live in `alerting-LAUNCH-BLOCKERS.md`. If an item here is ever promoted, say which
condition below became true.

## 1. The 319 rows awaiting the classifier

`TYPE_FOR_SHAPE` maps `DIRECTORY_AUDIT` to null on purpose: the key shape does not determine the
alert type, and defaulting it would file real privileged changes as routine.

**Not a blocker:** a ruling, already made and honestly reported in every output.
**Promote if:** the classifier ships and these rows are still excluded, or if anything starts
defaulting their type.

## 2. `TENANT_INITIAL_SYNC` is permanently unwritable by construction

`tenant:<id>:initial-sync` types to `monitoring.collector_failing`, whose subject is `COLLECTOR`,
which reads a `resourceType` the initial-sync regex never sets. No classifier and no future data
changes this — the key shape has no segment that could carry one.

**Not a blocker:** the runner now reports it as NEVER writable, so the output is true.
**The open question is a product decision, not a defect:** should these rows have a type at all,
and if so should the shape carry a resource or the type take `TENANT` as its subject?

## 3. The hop limit labels NEVER where it should say UNKNOWN

`resourceTypeFor` follows `recoveryOf` for at most 8 hops, then returns null, which files the row
as *"NEVER writable — the key shape cannot name what its subject reads"*. For a deeper chain that
label is wrong: the shape can name the subject; the walker stopped looking. Demonstrated with a
9-deep chain.

**Not a blocker:** unreachable. Recovery keys are built in exactly one place
(`notifications.service.ts:330`) and all four production callers pass a freshly-built
non-recovery key, so maximum depth is 1.
**Promote if:** anything ever calls `resolveIncident` with a recovery key. A comment on the
`return null` saying "unknown, not never" is the cheap version.

## 4. The preflight merges two of the three exclusion reasons

Steps 2 and 3 print one number — `322 left alone by decision` — which is 319 waiting plus 3
never. The data keeps all three apart and step 1 prints three lines; only the summary merges.

**Not a blocker:** causes no wrong write.
**But see the blockers file** — I recommend doing it before launch anyway, because this exact
shape already reached a status report on this feature, and it is one line.

## 5. The partial index Prisma cannot express

`WHERE incident_key IS NOT NULL` would be much smaller — 44 of 366 rows are keyed and the ratio
stays lopsided until the classifier lands — and every grouping query filters on non-null.
Rejected because Prisma cannot express a partial index, so it would live only in the SQL and read
as drift on the next `migrate dev`.

**Not a blocker:** a considered trade-off on a small table, recorded in the migration.
**Promote if:** the table grows and the keyed ratio stays low.

## 6. `previous` is all-null, so A2 cannot be closed on this path

Every receipt row records `previous: {incidentKey: null, episode: null}`, because the write's own
`incident_key IS NULL` predicate makes null the only reachable prior value. So no input on this
path distinguishes a real read from the hardcoded null that was predeclared as equivalent.

**Not a blocker, and not a defect:** it is a limit on what evidence this path can produce. The
predeclaration was accurate.
**Closes if:** a second apply ever runs over already-keyed rows — then `previous` carries
information and the mutation stops being equivalent.

## 7. Preference-grain hazard for the five non-directory types

Carried from earlier review and **not re-verified by me at `d9de7b9`** — listed so it is not
lost, not as a finding I am standing behind today.

## 8. The gated database-integration suite has no runnable documented setup

Listed here as well as in the blockers file, because the *blocking* part is only that the release
checklist asks for its output. The durable problem is that 14 files of integration coverage
cannot be run by a newcomer: beyond `DATABASE_URL`, `HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS=1`,
a UTC server and `SECRET_ENCRYPTION_KEY`, the remaining prerequisites behind
`IDENTITY_RISK_SOURCE_UNAVAILABLE` are undocumented as far as I could find.

**What would fix it:** one runnable setup, written down, that takes an empty database to a green
run — and if some of those tests fail on purpose, that list belongs beside it.
