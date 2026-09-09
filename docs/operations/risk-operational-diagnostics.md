# Risk operational diagnostics (version 1)

These backend-only records diagnose execution branches, not identities or risk.
They use the existing server logger. There is no endpoint, migration, permission,
source collection, schedule, backfill, UI, or memory-lane change.

## Closed records and privacy

`risk_cycle_diagnostic`: exactly `version: 1`, `eventName`, and `reason`.
One record is attempted per authenticated scheduled invocation. No tenant count,
eligibility total, attempt count, risky-user count, identifier, correlation ID,
label, exception, payload, URL, or secret is included.

`risk_reader_diagnostic`: exactly `version: 1`, `eventName`,
`reason: AGGREGATED`, and `counters`. Its fixed seven counters are
`NO_COMPLETED_RUN`, `MEMORY_LANE_BUSY`, `SCOPED_SOURCE_UNAVAILABLE`,
`STORED_ASSESSMENT_INVALID`, `KEY_UNAVAILABLE`, `READ_FAILED`, and `SUCCESS`.
They count process-wide read-branch occurrences, not tenants or risky users.
Flush is at most once per 60 seconds; each counter saturates at 65,535 and is
reset before the log attempt. No per-request reader record is emitted.
The normal logging platform may attach its own server timestamp/revision.

Counters are local, volatile, non-durable hints. Restarts, multiple instances,
logger failure, saturation, or process termination can lose observations. There
is no cross-instance aggregation, retry queue, or implied historical retention.
Existing platform log access and retention apply; do not broaden access or export
adjacent raw logs. A failed logger cannot change results, HTTP status, leases,
collection admission, source evidence or memory protections.

## Interpretation

Cycle reasons: `CONFIG_UNAVAILABLE`, `MAINTENANCE_DEFERRED`,
`ADMISSION_BUDGET_EXHAUSTED`, `DEPENDENCY_UNAVAILABLE`, `MEMORY_LANE_BUSY`,
`LEASE_BUSY`, `NO_ELIGIBLE_WORK`, `ATTEMPT_FAILED`, `RETURNED_UNCOMMITTED`,
`COMMITTED`, `CANDIDATE_INELIGIBLE`, `CYCLE_CLAIM_FAILED`,
`SCOPE_SELECTION_FAILED`, `ATTEMPT_RECORD_FAILED`, `KEY_ENSURE_FAILED`,
`EVALUATION_FAILED`.

The five specific failure reasons identify the existing await boundary, never
the thrown error or an affected tenant. They outrank generic `ATTEMPT_FAILED`
(retained as controller/unknown fallback) and commits. Equal-priority specific
failures preserve the first observed stage; a single record is not an exhaustive
account of a mixed cycle.

`CANDIDATE_INELIGIBLE` is observed only at the existing locked active-owner,
active-tenant, or connected-connection rejection branches. It preserves the
original rejection, cursor advancement and internal failed counter, with no new
query or eligibility inference. It ranks below commits and all failures, so an
expected skip cannot hide useful work or an unexpected failure. Hard-disable,
configuration, wrapping root, key-history, ciphertext and query failures remain
`KEY_ENSURE_FAILED`; that label is not evidence of a broken key. Observer failure
does not change admission, transaction cleanup, key zeroization or throws.

One next natural closed cycle record after independently verified deployment can
distinguish expected eligibility rejection from an unexpected execution stage.
It cannot identify a tenant, prove the backlog healthy, establish a root cause
within a stage, or establish source/risky-user count correctness. Do not change
keys, permissions or capacity on this stage label alone.

`COMMITTED` is emitted only following the assessment evaluator's `COMPLETED`
return, which follows successful resolution of its persistence transaction.
OFF, hard-disabled, in-progress, replayed and legacy-only returns do not prove a
new assessment commit. The old internal cycle `completed` counter is deliberately
not logged: it counts evaluator returns, not durable assessment commits.
A mixed cycle reports the higher-priority failure/defer reason, never allowing
one successful commit to conceal a failure or an uncommitted result. Absence of
`COMMITTED` therefore does not prove there were no commits in that cycle.

Reader `SUCCESS` means the bounded persisted projection returned, **not** that
source evidence is complete/current, that the HTTP response passed all subsequent
authorization checks, or that any tenant has zero risk. In particular, persisted
unavailable or stale evidence may still be read successfully.
`MEMORY_LANE_BUSY` means the reader declined contention without queueing; it does
not mean first collection never occurred. `NO_COMPLETED_RUN` means the existing
causal/scoped run lookup returned no readable run; it does not prove underlying
Microsoft logs are absent. These records cannot establish any particular tenant's
cause or whether every eligible tenant was assessed.

## Controlled observation after reviewed deployment

1. Prove the exact deployed revision and normal health first.
2. In the authorized normal Render log UI, filter **only** the two exact event
   names above, over the next natural scheduled invocation/ordinary authorized
   application activity. Do not invoke manual collection, backfill, or private
   diagnostic endpoints. Do not retrieve unrelated logs, secrets or tenant rows.
3. Read only the closed reason/counters. A scheduler `MEMORY_LANE_BUSY` or
   reader busy counter identifies aggregate contention; config, budget, lease,
   absence, stored-shape, key, scoped-source and read failures are distinct.
4. Treat this as branch evidence, not completed Risky Users acceptance. A natural
   commit plus successful read still needs separately authorized source/summary
   truth validation. No recorded event is not proof of a healthy pipeline.

If the normal log surface cannot restrict observation to these records, stop at
that access boundary. Do not use shell/private-DB workarounds or loosen guards.
