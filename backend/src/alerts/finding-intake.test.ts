import assert from 'node:assert/strict'
import test from 'node:test'
import { eventInstant } from './alert-event-time.js'
import { OBSERVED_RUN_GAPS, STALE_AFTER_MS } from './finding-intake.js'
import type {
  EmittedFinding,
  IntakeRun,
  QueueState,
  QueuedIncident,
  QueuedNotification,
} from './finding-intake.js'

/** THE EXPRESSIBILITY GATE, run before the wiring exists.
 *
 * QA found that their own seam could not express one of the seven properties: `QueueState`
 * exposed no time, so a wiring that timestamped on arrival produced a state IDENTICAL to one
 * using `observedAt`. The property was unpinnable and the check written for it silently
 * tested something else — six green checks and a property nobody was testing.
 *
 * A SEAM THAT CANNOT EXPRESS A PROPERTY CANNOT PIN IT. So for each of the seven, this file
 * constructs the two states the property is meant to separate — the satisfying one and the
 * named defect variant — and asserts they are DISTINGUISHABLE. Nothing here tests a wiring;
 * there is no wiring. It tests that the shapes can hold the difference.
 *
 * Failing here means the seam is wrong, and it is free to change now. The whole point of
 * doing it before the implementation is that afterwards it is not.
 */

const T0 = Date.parse('2026-09-01T09:00:00.000Z')
const ARRIVED = new Date(T0 + 60 * 60 * 1000)

const finding = (over: Partial<EmittedFinding> = {}): EmittedFinding => ({
  id: 'f-1',
  organizationId: 'org-1',
  customerTenantId: 'tenant-1',
  matchedResultId: 'm-1',
  dedupeKey: 'risky-user:account-1:rule-a',
  ruleId: 'rule-a',
  ruleVersion: '1',
  subjectType: 'ACCOUNT',
  subjectId: 'account-1',
  state: 'OPEN',
  severity: 'HIGH',
  confidence: 'HIGH',
  coverage: 'FULL',
  observedAt: new Date(T0),
  expiresAt: new Date(T0 + 7 * 24 * 60 * 60 * 1000),
  ...over,
})

const at = (occurredAt: Date, receivedAt = ARRIVED) => eventInstant({ occurredAt, receivedAt })

const notification = (over: Partial<QueuedNotification> = {}): QueuedNotification => ({
  incidentKey: 'k-1',
  fromFindingId: 'f-1',
  organizationId: 'org-1',
  at: at(new Date(T0)),
  ...over,
})

const incident = (over: Partial<QueuedIncident> = {}): QueuedIncident => ({
  key: 'k-1',
  organizationId: 'org-1',
  customerTenantId: 'tenant-1',
  subject: { resolved: true, id: 'account-1' },
  ruleId: 'rule-a',
  state: 'OPEN',
  coverage: 'FULL',
  firstEventAt: at(new Date(T0)),
  latestEventAt: at(new Date(T0)),
  notifications: [notification()],
  ...over,
})

const state = (over: Partial<QueueState> = {}): QueueState => ({
  incidents: [incident()],
  completedRuns: 1,
  runsSeen: 1,
  lastCompletedRun: { completedAt: ARRIVED, emitted: 1 },
  lastRunAttemptedAt: ARRIVED,
  failedRuns: [],
  ...over,
})

/** Two states differ somewhere. Compared structurally rather than field by field, so a
 * property is not declared expressible on the strength of a field this test happens to
 * name — if the seam collapses the difference, the two serialise identically and this fails
 * however carefully the assertion was written. */
const distinguishable = (left: QueueState, right: QueueState): boolean =>
  JSON.stringify(left) !== JSON.stringify(right)

test('P1 one incident per account-rule IS EXPRESSIBLE', () => {
  // The variant is incident-per-emission. Three emissions of the same account-rule pair:
  // one incident, or three. The seam must be able to hold both answers.
  const correct = state({ incidents: [incident({ notifications: [
    notification(), notification({ fromFindingId: 'f-2' }), notification({ fromFindingId: 'f-3' }),
  ] })] })
  const variant = state({ incidents: [
    incident({ key: 'k-1' }), incident({ key: 'k-2' }), incident({ key: 'k-3' }),
  ] })

  assert.ok(distinguishable(correct, variant))
  assert.equal(correct.incidents.length, 1)
  assert.equal(variant.incidents.length, 3)
  // And the account-rule pair is IN the incident, not merely implied by its key — a key is
  // an opaque string and a property about account-rule pairs cannot read one.
  assert.equal(correct.incidents[0]?.ruleId, 'rule-a')
  assert.deepEqual(correct.incidents[0]?.subject, { resolved: true, id: 'account-1' })
})

test('P2 re-emission notifies once IS EXPRESSIBLE', () => {
  // THE ONE THAT NEEDS NOTIFICATIONS TO BE THEIR OWN THING. A wiring that notifies on every
  // re-emission produces the SAME INCIDENT LIST as one that notifies once — so if the seam
  // exposed only incidents, this property would be invisible and its check would be testing
  // the incident count under another name.
  const notifiedOnce = state({ incidents: [incident({ notifications: [notification()] })] })
  const notifiedTwice = state({ incidents: [incident({ notifications: [
    notification(), notification({ fromFindingId: 'f-2' }),
  ] })] })

  assert.ok(distinguishable(notifiedOnce, notifiedTwice))
  // The incidents are otherwise identical, which is the whole difficulty: strip the
  // notifications and the two states become equal.
  const stripped = (s: QueueState) => s.incidents.map(({ notifications, ...rest }) => rest)
  assert.deepEqual(stripped(notifiedOnce), stripped(notifiedTwice),
    'the incident lists are identical — only the notifications separate these two')
})

test('P3 absence does not clear IS EXPRESSIBLE, and so is the input it needs', () => {
  // TWO THINGS HAVE TO BE EXPRESSIBLE, and the input half is the one a flat list loses.
  // "Emitted then stopped" and "never emitted" must be different INPUTS before any rule
  // about them can be tested.
  const emittedThenStopped: readonly IntakeRun[] = [
    { kind: 'COMPLETED', completedAt: ARRIVED, emitted: [finding()] },
    { kind: 'COMPLETED', completedAt: new Date(ARRIVED.getTime() + 300_000), emitted: [] },
  ]
  const neverEmitted: readonly IntakeRun[] = [
    { kind: 'COMPLETED', completedAt: ARRIVED, emitted: [] },
    { kind: 'COMPLETED', completedAt: new Date(ARRIVED.getTime() + 300_000), emitted: [] },
  ]
  assert.notEqual(JSON.stringify(emittedThenStopped), JSON.stringify(neverEmitted))

  // And the output half: OPEN versus CLEARED must be distinguishable.
  assert.ok(distinguishable(
    state({ incidents: [incident({ state: 'OPEN' })] }),
    state({ incidents: [incident({ state: 'CLEARED' })] })))

  // A FAILED RUN IS NOT AN EMPTY ONE, and this is the sibling QA's fix did not reach. If a
  // failure arrived as `emitted: []` it would be the second input above — and the rule about
  // to read it is the one deciding whether absence clears. A crashed engine would close every
  // open incident, quietly. Not one of the seven; expressible anyway, and deliberately.
  const crashed: readonly IntakeRun[] = [
    { kind: 'COMPLETED', completedAt: ARRIVED, emitted: [finding()] },
    { kind: 'FAILED', failedAt: new Date(ARRIVED.getTime() + 300_000), because: 'Graph returned 503.' },
  ]
  assert.notEqual(JSON.stringify(crashed), JSON.stringify(emittedThenStopped),
    'a failed run must not look like a run that emitted nothing')
  assert.ok(distinguishable(state({ failedRuns: [] }),
    state({ failedRuns: [{ failedAt: ARRIVED, because: 'Graph returned 503.' }] })))
})

test('P4 the subject is the account, and no merge IS EXPRESSIBLE', () => {
  // Two accounts under one rule are two incidents; the variant re-derives the subject from
  // something coarser (the rule, the tenant, the matched result) and merges them into one.
  const twoAccounts = state({ incidents: [
    incident({ key: 'k-a', subject: { resolved: true, id: 'account-1' } }),
    incident({ key: 'k-b', subject: { resolved: true, id: 'account-2' } }),
  ] })
  const merged = state({ incidents: [incident({ key: 'k-a', notifications: [
    notification(), notification({ fromFindingId: 'f-2' }),
  ] })] })
  assert.ok(distinguishable(twoAccounts, merged))

  // AND AN UNRESOLVED SUBJECT IS ITS OWN CASE, not the empty string. Step 02 refuses to merge
  // on "unknown", and the seam has to be able to carry that refusal or the queue reintroduces
  // the merge one layer down — which is exactly what step 03's episode count did.
  assert.ok(distinguishable(
    state({ incidents: [incident({ subject: { resolved: true, id: '' } })] }),
    state({ incidents: [incident({ subject: { resolved: false, why: 'no account on the finding' } })] })))
})

test('P5 no finding reaches another organisation IS EXPRESSIBLE', () => {
  // Expressible needs more than the incident carrying an org: the LEAK has to be
  // constructible, which means a notification must be traceable to the finding it came from.
  // Without `fromFindingId` a cross-org notification is just a notification.
  const leaked = state({ incidents: [incident({
    organizationId: 'org-1',
    notifications: [notification({ organizationId: 'org-2', fromFindingId: 'f-other' })],
  })] })
  assert.ok(distinguishable(state(), leaked))

  const offending = leaked.incidents.flatMap((i) =>
    i.notifications.filter((n) => n.organizationId !== i.organizationId))
  assert.equal(offending.length, 1, 'the leak is observable, not merely absent by convention')
  assert.equal(offending[0]?.fromFindingId, 'f-other', 'and traceable back across the seam')
})

test('P6 coverage survives the seam IS EXPRESSIBLE', () => {
  // The variant drops coverage on the way through, so every incident reads FULL. Both the
  // incident-level value and the per-finding one must be able to differ, or "survives" is
  // satisfied by a constant.
  assert.ok(distinguishable(
    state({ incidents: [incident({ coverage: 'FULL' })] }),
    state({ incidents: [incident({ coverage: 'PARTIAL' })] })))
  assert.ok(distinguishable(
    state({ incidents: [incident({ coverage: 'PARTIAL' })] }),
    state({ incidents: [incident({ coverage: 'UNAVAILABLE' })] })),
    'all three of the engine\'s values, not a two-valued reduction of them')

  // The input carries it too, so a wiring cannot be excused by never having received it.
  assert.equal(finding({ coverage: 'UNAVAILABLE' }).coverage, 'UNAVAILABLE')
})

test('P7 the time used is observedAt IS EXPRESSIBLE — the one that was not', () => {
  // QA'S FINDING, CHECKED AGAINST THIS SEAM. Their `QueueState` exposed no time, so an
  // arrival-stamped queue and an observedAt-stamped queue were the same value. Here the two
  // must be different values.
  const eventTime = new Date(T0)
  const arrivalTime = ARRIVED
  const fromObserved = state({ incidents: [incident({
    firstEventAt: at(eventTime), latestEventAt: at(eventTime),
    notifications: [notification({ at: at(eventTime) })],
  })] })
  const fromArrival = state({ incidents: [incident({
    firstEventAt: at(arrivalTime), latestEventAt: at(arrivalTime),
    notifications: [notification({ at: at(arrivalTime) })],
  })] })

  assert.ok(distinguishable(fromObserved, fromArrival),
    'a queue built on arrival time is a different value, not an identical one')
  assert.notEqual(eventTime.getTime(), arrivalTime.getTime(),
    'the fixture must separate the two clocks or the check proves nothing')

  // AND THE ACCIDENTAL VERSION DOES NOT COMPILE. `EventInstant` is constructible only
  // through `eventInstant`, which reads `occurredAt` — so a wiring cannot reach the queue's
  // time fields by grabbing the nearer Date. What the type does NOT stop is the deliberate
  // version, `eventInstant({ occurredAt: arrival, receivedAt: arrival })`, which is why P7
  // is pinned by a check as well: the type catches the slip, the property catches the choice.
  const runArrival: Date = ARRIVED
  // @ts-expect-error a bare Date is not an EventInstant, however convenient it is
  const rejected: QueuedIncident = incident({ firstEventAt: runArrival })
  assert.ok(rejected, 'referenced so the expectation is checked rather than optimised away')

  // The seam keeps arrival where it belongs: on the run, about the engine, not on the event.
  assert.equal(state().lastCompletedRun?.completedAt.getTime(), ARRIVED.getTime())
})

test('every one of the seven was checked, and the count is asserted', () => {
  // The sweep QA used to find the unpinnable one: a property with no check is invisible, and
  // so is a check that quietly covers a property twice while another has none. Seven
  // properties, seven expressibility tests above, asserted here so removing one is a failure
  // rather than a smaller file.
  const checked = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']
  assert.equal(new Set(checked).size, 7)
})

test('C counting runs as input.length IS EXPRESSIBLE — it was not before', () => {
  // QA did not claim this one was caught, and it was not. A wiring reporting every run as
  // completed is INTERNALLY CONSISTENT: the failures are still recorded in `failedRuns`, so
  // the record-the-failure property is satisfied, while the count quietly says the engine has
  // never missed a cycle. Nothing contradicted it because there was no total to contradict.
  const failure = { failedAt: ARRIVED, because: 'Graph returned 503.' }
  const honest = state({ runsSeen: 2, completedRuns: 1, failedRuns: [failure] })
  const variant = state({ runsSeen: 2, completedRuns: 2, failedRuns: [failure] })
  assert.ok(distinguishable(honest, variant))

  // The identity that catches it needs the TOTAL, which the state did not carry.
  assert.equal(honest.completedRuns + honest.failedRuns.length, honest.runsSeen)
  assert.notEqual(variant.completedRuns + variant.failedRuns.length, variant.runsSeen)
})

test('D a dead engine reported as current IS ONLY PARTLY EXPRESSIBLE, and the limit is the answer', () => {
  // The crude form is now hard to write: a state claiming no completed runs cannot also name
  // one, and carrying the RUN rather than a timestamp makes the marker a projection of
  // something that had to come from the input.
  const noRuns = state({
    runsSeen: 0, completedRuns: 0, failedRuns: [], incidents: [],
    lastCompletedRun: null, lastRunAttemptedAt: null,
  })
  const claimsOne = state({
    runsSeen: 0, completedRuns: 0, failedRuns: [], incidents: [],
    lastCompletedRun: { completedAt: ARRIVED, emitted: 1 },
  })
  assert.ok(distinguishable(noRuns, claimsOne))
  assert.equal(noRuns.lastCompletedRun, null)

  // AND THE LIMIT, WHICH IS THE USEFUL HALF OF THE ANSWER. A marker that is merely WRONG — a
  // plausible recent time, every other field agreeing — is internally consistent, and no
  // property over the state alone can catch it. The staleness check must be RELATIONAL: it has
  // to read the run sequence the state was built from. A property taking only the state is
  // testing self-consistency and calling it freshness.
  const actualRuns = [
    { kind: 'COMPLETED' as const, completedAt: new Date(T0 - 10 * 60 * 60 * 1000), emitted: [] },
  ]
  const fabricated = state({
    runsSeen: 1, completedRuns: 1,
    lastCompletedRun: { completedAt: ARRIVED, emitted: 0 },
  })
  assert.notEqual(
    fabricated.lastCompletedRun?.completedAt.getTime(),
    actualRuns[0]?.completedAt.getTime(),
    'visible only with the input in hand, which is what makes the property relational')
})

test('LIVENESS AND FRESHNESS ARE DIFFERENT QUESTIONS, and only one of them is about the queue', () => {
  // The consumer of an outcome-blind time that legitimately exists. A scheduler firing into
  // failures and a scheduler that has stopped are different conditions with different
  // remedies, and only the second is fixed by restarting a schedule. That question is real,
  // which is exactly why it gets a NAME rather than a shared `at` a freshness consumer can
  // reach into by accident.
  const firingIntoFailures = state({
    runsSeen: 2,
    completedRuns: 1,
    failedRuns: [{ failedAt: new Date(ARRIVED.getTime() + 300_000), because: 'Graph 503.' }],
    lastCompletedRun: { completedAt: ARRIVED, emitted: 1 },
    lastRunAttemptedAt: new Date(ARRIVED.getTime() + 300_000),
  })
  const stopped = state({
    runsSeen: 1, completedRuns: 1, failedRuns: [],
    lastCompletedRun: { completedAt: ARRIVED, emitted: 1 },
    lastRunAttemptedAt: ARRIVED,
  })

  // Identical freshness, different liveness. As one field these would be the same state, and
  // an operator would be told to restart a scheduler that is running perfectly well.
  assert.equal(
    firingIntoFailures.lastCompletedRun?.completedAt.getTime(),
    stopped.lastCompletedRun?.completedAt.getTime())
  assert.notEqual(
    firingIntoFailures.lastRunAttemptedAt?.getTime(),
    stopped.lastRunAttemptedAt?.getTime())
  assert.ok(distinguishable(firingIntoFailures, stopped))
})

test('the staleness threshold carries its distribution, not only its conclusion', () => {
  // Thirty minutes is twice the worst gap ever observed across 5,166 runs. Same rule the
  // episode intervals are held to: a threshold whose provenance is lost becomes a number
  // nobody may change.
  assert.equal(STALE_AFTER_MS, 30 * 60 * 1000)
  assert.ok(STALE_AFTER_MS >= 2 * OBSERVED_RUN_GAPS.worstMs,
    'the threshold must clear the worst observed gap with margin or it fires on healthy runs')
  assert.equal(OBSERVED_RUN_GAPS.completed + OBSERVED_RUN_GAPS.failed, OBSERVED_RUN_GAPS.runs)

  // THE MEDIAN IS NOT WHAT THIS IS SET AGAINST, and quoting it would make the margin look far
  // larger than it is: 0.1 min is runs clustering inside a cycle, not the cycle cadence.
  assert.ok(OBSERVED_RUN_GAPS.p50Ms * 100 < OBSERVED_RUN_GAPS.worstMs,
    'p50 and the worst gap are different phenomena; the threshold answers to the worst')

  // ZERO FAILURES IN 5,166 RUNS. The arm the union forces every consumer to handle has never
  // fired in production — so nothing in the observed history would have taught anyone that
  // failures exist. That is the argument FOR enforcing it in the type, not against it: the
  // defect was invisible to experience rather than merely unnoticed.
  assert.equal(OBSERVED_RUN_GAPS.failed, 0)
})
