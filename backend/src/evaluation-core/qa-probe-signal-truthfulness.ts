// QA probe for the two claims the per-signal contract makes that nothing else
// in this gate checks.
//
// 1. CAPPED. Over budget, `evaluate` truncates to the most recent slice before
//    any detector sees it, so every count from that window is a FLOOR. The core
//    stamps `capped` rather than the detector, because a detector handed an
//    already-truncated slice cannot tell. Rendering a floor as a total is the
//    count-vocabulary defect one level down: AT_LEAST 467 and 467 are different
//    claims and only one of them is safe to say.
//
// 2. EVALUATED-AND-NONE vs NEVER-EVALUATED. `latest: null` means the signal was
//    evaluated and none occurred. A signal ABSENT from the array was never
//    evaluated. That is this feature's signature defect one level down, and a
//    core that drops zero-count signals would erase the distinction silently
//    while every count stayed correct.
import { evaluate } from './evaluate.js'
import type { Detector, DetectorResult, Subject } from './contract.js'

type Ev = Readonly<{ id: number; at: string }>
const t = (n: number) => new Date(Date.UTC(2026, 8, 10, 0, 0, n)).toISOString()
const pool: readonly Ev[] = Array.from({ length: 40 }, (_, i) => ({ id: i, at: t(i) }))
const subject: Subject = { kind: 'DIRECTORY_USER', userRef: 'alice', correlation: { available: false, because: 'qa probe' } }

const detector = (signals: () => readonly [{ signal: string; count: number; latest: string | null }, ...{ signal: string; count: number; latest: string | null }[]]): Detector<Ev> => ({
  id: 'probe', monotonic: true,
  run: (applicable): DetectorResult => ({
    status: 'RAN', assessed: applicable.length, declined: {},
    findings: [{ detectorId: 'probe', subject, signals: signals() }],
  }),
})

const run = (d: Detector<Ev>, maxEvents: number) => evaluate({
  evidence: {
    availability: 'READ', applies: pool,
    coverage: { collectionScope: { declared: true, asked: 'qa fixture: the whole synthetic pool' },
      applies: pool.length, doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {} },
    timeOf: (e: Ev) => e.at,
  },
  detectors: [d], budget: { maxEvents },
})

// ---- 1. CAPPED ----
const plain = detector(() => [{ signal: 'FAILURE', count: 40, latest: t(39) }])
const truncated = run(plain, 10)   // 40 events, budget 10 -> a floor
const whole = run(plain, 1000)     // whole window -> a total

const signalsOf = (a: ReturnType<typeof run>) => a.findings.items.flatMap(f => f.signals)
const truncatedSignals = signalsOf(truncated)
const wholeSignals = signalsOf(whole)

// GUARD: if truncation produced no findings there is nothing to stamp, and a
// clean reading would mean only that the scenario did not run.
const cappedInputCanFail = truncatedSignals.length > 0 && wholeSignals.length > 0

const everyTruncatedSignalCapped = truncatedSignals.length > 0 && truncatedSignals.every(s => s.capped)
const noWholeSignalCapped = wholeSignals.length > 0 && wholeSignals.every(s => !s.capped)
// A floor must not also be sold as an exact total.
const truncatedClaimIsNotExact = truncated.count.accuracy !== 'EXACT'

// ---- 2. EVALUATED-AND-NONE vs NEVER-EVALUATED ----
const looked = detector(() => [
  { signal: 'LOCKED_OUT', count: 0, latest: null },      // evaluated, none occurred
  { signal: 'REJECTED', count: 3, latest: t(9) },
])
const didNotLook = detector(() => [
  { signal: 'REJECTED', count: 3, latest: t(9) },        // LOCKED_OUT never evaluated
])
const lookedSignals = signalsOf(run(looked, 1000))
const didNotLookSignals = signalsOf(run(didNotLook, 1000))

const lockout = lookedSignals.find(s => s.signal === 'LOCKED_OUT') ?? null
// The whole question. A core that drops zero-count signals would make these two
// identical while every count stayed correct.
const zeroSignalSurvives = lockout !== null && lockout.count === 0 && lockout.latest === null
const absenceStaysAbsent = !didNotLookSignals.some(s => s.signal === 'LOCKED_OUT')
const distinguishable = zeroSignalSurvives && absenceStaysAbsent

console.log(JSON.stringify({
  QA_SIGNAL_TRUTHFULNESS: {
    capped: {
      poolSize: pool.length, budget: 10,
      truncated: truncatedSignals.map(s => ({ signal: s.signal, count: s.count, capped: s.capped })),
      whole: wholeSignals.map(s => ({ signal: s.signal, count: s.count, capped: s.capped })),
      truncatedClaim: truncated.count.accuracy,
      wholeClaim: whole.count.accuracy,
      inputCanFail: cappedInputCanFail,
      verdict: !cappedInputCanFail
        ? 'INCONCLUSIVE - no findings on one side, so nothing could be stamped'
        : everyTruncatedSignalCapped && noWholeSignalCapped && truncatedClaimIsNotExact
          ? 'PASS - a truncated window stamps every signal as a floor and does not claim an exact total'
          : `FAIL - truncatedAllCapped=${everyTruncatedSignalCapped} wholeNoneCapped=${noWholeSignalCapped} claimNotExact=${truncatedClaimIsNotExact}`,
    },
    lookedVsDidNotLook: {
      lookedAndFoundNone: lookedSignals.map(s => ({ signal: s.signal, count: s.count, latest: s.latest })),
      neverLooked: didNotLookSignals.map(s => ({ signal: s.signal, count: s.count, latest: s.latest })),
      zeroSignalSurvives, absenceStaysAbsent,
      verdict: distinguishable
        ? 'PASS - "we looked and found none" and "we did not look" reach a reader as different facts'
        : 'FAIL - the two collapse, which is this feature\'s signature defect one level down',
    },
  },
}, null, 2))
