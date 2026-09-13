# The flow, verified from the other end — one blocker

**Commit under test: `0a62f8d`.** Disposable PostgreSQL 15 on loopback, database `hvflow`,
migrations deployed from the commit, UTC server. Nothing ran against production.

## Tests executed, by name and result

Engineer's own suite, run by me, exactly as gated (`HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS=1`):

| test | on a **clean** database | after I added two rows |
|---|---|---|
| `A PERSISTED FINDING REACHES A SEND JOB` | **FAIL** — foreign key | **pass** |
| `NO HISTORICAL SENDS, against the real table` | **FAIL** — foreign key | **pass** |
| `INTAKE YIELDS RATHER THAN BORROWING FROM THE COLLECTORS` | pass | pass |

**The suite cannot run on a clean database.** Nothing in the file creates the organization or the
customer tenant, and `seed()` does not either, so
`notification_preferences_organization_id_fkey` rejects the first insert. I added only those two
rows and changed nothing else. So "proven end to end against a real database" was proven on a
database that already had them.

## BLOCKER — the budget yield strands an alert permanently, and silently

`runIntake` writes incidents, checks the deadline, then writes jobs. The check between them is
commented as **"the safe direction"**: a yield there leaves incidents recorded and no job.

**That state is unrecoverable.** The next run reads the incident, skips the finding as
`INCIDENT_ALREADY_OPEN`, and never writes the job. Measured through the product's own path, with
the clock expiring only after the incident write:

```
yieldedOnBudget=true   incidentsWritten=1   jobsWritten=0
recovery run:          jobsWritten=0        skipped=[INCIDENT_ALREADY_OPEN]
database, permanently: 1 incident, 0 jobs
```

**Nothing reports it.** `neverSent()` enumerates jobs that exist; this incident has none. The
alert is never delivered and no report names it — silent non-delivery, the failure family this
feature exists to remove.

**This is not a crash path.** It is the designed cascade behaviour — intake yielding rather than
borrowing from the collectors — so it fires whenever intake runs out of budget after writing
incidents, which is when the system is busiest.

**And the green test does not cover it.** `INTAKE YIELDS RATHER THAN BORROWING` asserts
`findingsRead: 0` and `incidents: 0` — it exercises the yield that happens **before anything is
read**, the harmless one. The dangerous yield is the other, and it is the one the comment reasons
about.

**The seam cannot express the fix.** `PipelineStore` is `writeIncidents` and `writeJobs`, two
async methods with no transaction handle, so no implementation can make them atomic. Either they
become one call, the store gains a transaction, or the recovery path treats "incident open with
no job" as a case to act on rather than to skip. The last is probably cheapest, and it is a
ruling rather than mine to make.

## There is no production code path

`runIntake` is called by nothing in `src/`. Nothing schedules it. `PipelineStore` has no
implementation outside the integration test — `storeFor(client)` lives in the test file. The
decision logic is production code and the schema is real, but **the chain is joined by the test
rather than by the product.**

## The three checks asked for

**1. The rule constraint, read from the database rather than from the comment.** Confirmed:

```
CHECK (rule_id ~ '^HV-ID-(EXP|CHG|APP|MBX|AUTH)-[0-9]{3}\.v1$' OR rule_id = 'HV-ID-AUTH-005.v2')
```

The namespace is exactly as stated. There is also a version-paired finding-level constraint and a
single `.v2` exception nobody mentioned.

**2. An unmapped finding is a clean no-op with a receipt, not a silent drop.** Seeded real `MBX`
and `APP` findings alongside one mappable `AUTH` finding:

- jobs written for the unmapped two: **0**
- each named individually — `skipped: NO_ALERT_TYPE`, twice, with finding ids
- `unmappedRules: ["HV-ID-APP-001.v1", "HV-ID-MBX-001.v1"]` — the rule ids, which is what
  somebody has to go and add
- `accountingProblems: []`
- second run: 0 new jobs, all three findings named

**This corrects something I reported earlier.** I said `unmappedRules` might be unreachable,
because my negative control used `HV-XX-UNKNOWN-9.v1` and the database refused it. That was my
fixture, not the product: `HV-ID-MBX-001.v1` is constraint-valid and pipeline-unmapped, so the
path is reachable and now demonstrated.

**3. The derivation cannot exceed the column — but the headroom is 11 characters, on a different
column than the one that was widened.** Computed at the worst case every bound allows, from the
real catalogue and the real column widths rather than from one example:

| | worst case | column | headroom |
|---|---|---|---|
| `alert_incidents.incident_key` | **289** | 300 | **11** |
| `alert_send_jobs.message_id` | 335 | 400 | 65 |

`message_id` is comfortable. **The binding constraint is now the incident key.** It overflows at
an alert type id of 48 characters — today's longest is 36 — or a `subject_id` of 140, which the
column caps at 128. **Nothing bounds the alert type id except the catalogue**, so one new type
with a long id breaks inserts in production on a real finding.

## What the green tests did not take

The budget yield between the two writes. A clean database. An unmapped rule. A second
organisation. The worst-case key length. Any production caller.
