// QA: does the harness discriminate? A checker that never fails proves nothing,
// so run it against a detector known monotonic and one known NOT, and require
// it to separate them.
import { checkMonotonic } from './qa-monotonicity-harness.js'
import type { Detector, DetectorResult, DetectorSignal } from './contract.js'

type Ev = Readonly<{ id: string; kind: 'FAILURE' | 'SUCCESS'; user: string }>
const pool: readonly Ev[] = [
  { id: 'f1', kind: 'FAILURE', user: 'alice' }, { id: 'f2', kind: 'FAILURE', user: 'alice' },
  { id: 'f3', kind: 'FAILURE', user: 'bob' }, { id: 'f4', kind: 'FAILURE', user: 'bob' },
  { id: 's1', kind: 'SUCCESS', user: 'alice' }, { id: 's2', kind: 'SUCCESS', user: 'bob' },
  { id: 'f5', kind: 'FAILURE', user: 'carol' }, { id: 's3', kind: 'SUCCESS', user: 'carol' },
]
const finding = (id: string, user: string) => ({
  detectorId: id, subject: { kind: 'DIRECTORY_USER' as const, userRef: user, correlation: { available: false as const, because: 'qa probe' } }, signals: [{ signal: 'FAILURE', count: 1, latest: { at: '2026-09-10T00:00:00.000Z', kind: 'EVENT_OCCURRED' } }] as const,
})

// PRESENCE-keyed: "this user had a failure". Adding events can only add findings.
const monotonic: Detector<Ev> = {
  id: 'presence', monotonic: true,
  run: (events): DetectorResult => ({
    status: 'RAN', assessed: events.length, declined: {},
    findings: [...new Set(events.filter(e => e.kind === 'FAILURE').map(e => e.user))].map(u => finding('presence', u)),
  }),
}

// ABSENCE-keyed: "failures with NO subsequent success". Adding the success
// REMOVES the finding — the exact shape that fabricates on a truncated window.
const notMonotonic: Detector<Ev> = {
  id: 'absence', monotonic: true, // DELIBERATELY MIS-DECLARED, which is the risk
  run: (events): DetectorResult => {
    const succeeded = new Set(events.filter(e => e.kind === 'SUCCESS').map(e => e.user))
    return {
      status: 'RAN', assessed: events.length, declined: {},
      findings: [...new Set(events.filter(e => e.kind === 'FAILURE' && !succeeded.has(e.user)).map(e => e.user))]
        .map(u => finding('absence', u)),
    }
  },
}

const shown = (r: ReturnType<typeof checkMonotonic>) =>
  r.held ? { held: true, trials: r.trials, findingsSeen: r.findingsSeen }
    : { held: false, seed: r.seed, trial: r.trial, lostFindings: r.lost.length, example: r.lost[0] }

const good = checkMonotonic(monotonic, pool, { trials: 300 })
const bad = checkMonotonic(notMonotonic, pool, { trials: 300 })
console.log(JSON.stringify({
  QA_MONOTONICITY_PROOF: {
    presenceKeyed_declaredMonotonic: shown(good),
    absenceKeyed_MISdeclaredMonotonic: shown(bad),
    discriminates: good.held === true && bad.held === false && good.findingsSeen > 0,
    verdict: good.held && !bad.held && good.findingsSeen > 0
      ? 'PASS: harness accepts a genuinely monotonic detector and catches a mis-declared absence-keyed one'
      : 'INCONCLUSIVE: the harness does not separate the two',
  },
}, null, 2))

// THIRD CASE: a detector that DECLINES on the larger set. The finding is gone,
// but the detector never claimed to have looked. Must be reported as
// LOST_TO_DECLINE, distinct from a real violation, and tolerable on request.
const declines: Detector<Ev> = {
  id: 'declines', monotonic: true,
  run: (events): DetectorResult => events.length > 4
    ? { status: 'INAPPLICABLE', because: 'this evidence cannot answer at this size' }
    : { status: 'RAN', assessed: events.length, declined: {},
        findings: [...new Set(events.filter(e => e.kind === 'FAILURE').map(e => e.user))].map(u => finding('declines', u)) },
}
const strict = checkMonotonic(declines, pool, { trials: 300 })
const lenient = checkMonotonic(declines, pool, { trials: 300, declineIsViolation: false })
console.log(JSON.stringify({
  QA_DECLINE_DISTINCTION: {
    strict: strict.held ? { held: true } : { held: false, kind: strict.kind },
    lenientTolerates: lenient.held,
    declinesObserved: lenient.held ? lenient.declines : null,
    verdict: !strict.held && strict.kind === 'LOST_TO_DECLINE' && lenient.held
      ? 'PASS: a decline is reported as its own kind, not as a monotonicity violation, and is tolerable on request'
      : 'FAIL: the harness cannot tell a decline from a real loss',
  },
}, null, 2))

// SIGNAL_LOST_WHILE_RAN. The per-signal contract removed `observedAt`, which
// this harness had been using as part of a finding's identity. Dropping it
// without replacement would have left the harness drawing fewer distinctions
// than before -- a quieter harness reads as a greener product.
//
// So identity narrowed to the subject, and signal survival became its own
// check. That check has to be shown capable of failing, or narrowing the
// identity was simply a weakening with a comment attached.
//
// This detector keeps the SAME finding for the same user as events are added,
// and drops a signal from it once the window grows. Nothing above the signal
// level can see that: the finding is still there and the count is unchanged.
const dropsASignal: Detector<Ev> = {
  id: 'drops-a-signal', monotonic: true,
  run: (events): DetectorResult => {
    const users = [...new Set(events.filter(e => e.kind === 'FAILURE').map(e => e.user))]
    return {
      status: 'RAN', assessed: events.length, declined: {},
      findings: users.map(u => ({
        detectorId: 'drops-a-signal',
        subject: { kind: 'DIRECTORY_USER' as const, userRef: u, correlation: { available: false as const, because: 'qa probe' } },
        signals: (events.length > 4
          ? [{ signal: 'FAILURE', count: 1, latest: { at: '2026-09-10T00:00:00.000Z', kind: 'EVENT_OCCURRED' } }]
          : [{ signal: 'FAILURE', count: 1, latest: { at: '2026-09-10T00:00:00.000Z', kind: 'EVENT_OCCURRED' } },
             { signal: 'CORROBORATING_DETAIL', count: 1, latest: { at: '2026-09-10T00:00:00.000Z', kind: 'EVENT_OCCURRED' } }]
        ) as unknown as readonly [DetectorSignal],
      })),
    }
  },
}
const signalLoss = checkMonotonic(dropsASignal, pool, { trials: 300 })
const findingsHeld = checkMonotonic(
  { ...dropsASignal, run: events => {
    const r = dropsASignal.run(events)
    return r.status === 'RAN'
      ? { ...r, findings: r.findings.map(f => ({ ...f, signals: [f.signals[0]] as const })) }
      : r
  } }, pool, { trials: 300 })
console.log(JSON.stringify({
  QA_SIGNAL_SURVIVAL: {
    signalDropped: signalLoss.held ? { held: true } : { held: false, kind: signalLoss.kind, lost: signalLoss.lost.slice(0, 3) },
    sameDetectorWithSignalsHeldConstant: findingsHeld.held,
    verdict: !signalLoss.held && signalLoss.kind === 'SIGNAL_LOST_WHILE_RAN' && findingsHeld.held
      ? 'PASS: a signal disappearing under a surviving finding is caught, and is not reported for a detector that keeps its signals'
      : 'FAIL: the signal-survival check cannot fail, so narrowing the identity key weakened the harness',
  },
}, null, 2))
