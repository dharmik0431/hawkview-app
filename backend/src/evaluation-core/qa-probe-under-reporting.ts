// QA probe: the `considered` gate is a RANGE check. It catches a detector
// claiming MORE than it was handed. Does it catch one claiming FEWER?
// "Ran and found nothing, having looked at 5 of 1000" is the headline defect
// one level down: a believable clean result over evidence nobody examined.
import { evaluate } from './evaluate.js'
import type { Detector, DetectorResult } from './contract.js'

type Ev = Readonly<{ id: number; at: string }>
const events: readonly Ev[] = Array.from({ length: 1000 }, (_, i) =>
  ({ id: i, at: new Date(Date.UTC(2026, 8, 10, 0, 0, i)).toISOString() }))

// Reports considering 5 of the 1000 it was handed, and finds nothing.
const underReporting: Detector<Ev> = {
  id: 'under-reporting', monotonic: true,
  run: (): DetectorResult => ({ status: 'RAN', considered: 5, findings: [] }),
}
// The over-claiming direction the range check DOES catch, for contrast.
const overClaiming: Detector<Ev> = {
  id: 'over-claiming', monotonic: true,
  run: (): DetectorResult => ({ status: 'RAN', considered: 5000, findings: [] }),
}

const run = (detector: Detector<Ev>) => evaluate({
  evidence: {
    availability: 'READ', applies: events,
    coverage: { applies: events.length, doesNotApply: {}, unknown: {}, unprocessable: {} },
    timeOf: (event: Ev) => event.at,
  },
  detectors: [detector], budget: { maxEvents: 10_000 },
})

const shape = (a: ReturnType<typeof run>) => ({
  count: a.count.accuracy === 'NOT_AVAILABLE' ? { accuracy: a.count.accuracy } : { accuracy: a.count.accuracy, value: a.count.value },
  detectorStatus: a.detectors[0]?.status,
  consideredReported: a.detectors[0]?.status === 'RAN' ? a.detectors[0].considered : null,
  covered: a.count.scope.covered,
  notCovered: a.count.scope.notCovered.map(n => n.detectorId),
})

const under = run(underReporting)
const over = run(overClaiming)
console.log(JSON.stringify({
  QA_UNDER_REPORTING: {
    handed: events.length,
    underReporting_claims5: shape(under),
    overClaiming_claims5000: shape(over),
    verdict: under.count.accuracy === 'EXACT'
      ? 'GAP: a detector that looked at 5 of 1000 still supports a confident EXACT result'
      : 'CLOSED: under-reporting is caught',
  },
}, null, 2))
