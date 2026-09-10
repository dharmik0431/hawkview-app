// QA probe: 9003745 keeps truncated windows away from detectors that could
// invent a finding — but the guard trusts `monotonic`, which is an author's
// declaration. Point a genuinely absence-keyed detector at the REAL truncation
// path, once declared honestly and once mis-declared, and see what the core
// reports. This is the fabrication PM asserted could not happen.
import { evaluate } from './evaluate.js'
import type { Detector, DetectorResult } from './contract.js'

type Ev = Readonly<{ id: string; kind: 'FAILURE' | 'SUCCESS'; user: string; at: string }>
// Oldest first. The SUCCESS that disconfirms the pattern is the NEWEST event,
// so a window truncated to its most recent slice keeps it — but truncated the
// other way, or truncated below it, drops exactly the disconfirming evidence.
const events: readonly Ev[] = [
  { id: 'f1', kind: 'FAILURE', user: 'alice', at: '2026-09-10T00:00:01Z' },
  { id: 'f2', kind: 'FAILURE', user: 'alice', at: '2026-09-10T00:00:02Z' },
  { id: 'f3', kind: 'FAILURE', user: 'alice', at: '2026-09-10T00:00:03Z' },
  { id: 'f4', kind: 'FAILURE', user: 'alice', at: '2026-09-10T00:00:04Z' },
  { id: 's1', kind: 'SUCCESS', user: 'alice', at: '2026-09-10T00:00:05Z' },
]
const absenceKeyed = (declaredMonotonic: boolean): Detector<Ev> => ({
  id: declaredMonotonic ? 'absence-MISdeclared' : 'absence-honest',
  monotonic: declaredMonotonic,
  run: (applicable): DetectorResult => {
    const succeeded = new Set(applicable.filter(e => e.kind === 'SUCCESS').map(e => e.user))
    const accused = [...new Set(applicable.filter(e => e.kind === 'FAILURE' && !succeeded.has(e.user)).map(e => e.user))]
    return { status: 'RAN', assessed: applicable.length, declined: {},
      findings: accused.map(u => ({ detectorId: declaredMonotonic ? 'absence-MISdeclared' : 'absence-honest',
        subject: { kind: 'DIRECTORY_USER' as const, userRef: u, correlation: { available: false as const, because: 'qa probe' } }, observedAt: '2026-09-10T00:00:00.000Z' })) }
  },
})
const run = (detector: Detector<Ev>, maxEvents: number) => evaluate({
  evidence: { availability: 'READ', applies: events,
    coverage: { collectionScope: { declared: true, asked: 'qa fixture: the whole synthetic pool' }, applies: events.length, doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {} },
    timeOf: (e: Ev) => e.at },
  detectors: [detector], budget: { maxEvents },
})
const shape = (a: ReturnType<typeof run>) => ({
  accusations: a.findings.items.map(f => f.subject.kind === 'DIRECTORY_USER' ? f.subject.userRef : '(mailbox)'),
  detectorStatus: a.detectors[0]?.status,
  count: a.count.accuracy === 'NOT_AVAILABLE' ? 'NOT_AVAILABLE' : `${a.count.accuracy} ${a.count.value}`,
})

// Full window: alice's failures ARE followed by a success, so nobody is accused.
const full = run(absenceKeyed(false), 100)
// Truncated below the success, honestly declared non-monotonic -> guard should refuse.
const honest = run(absenceKeyed(false), 3)
// Same truncation, MIS-declared monotonic -> guard is bypassed.
const misdeclared = run(absenceKeyed(true), 3)

console.log(JSON.stringify({
  QA_TRUNCATION_FABRICATION: {
    fullWindow_noTruncation: shape(full),
    truncated_declaredNonMonotonic: shape(honest),
    truncated_MISdeclaredMonotonic: shape(misdeclared),
    guardWorksWhenDeclaredHonestly: honest.findings.items.length === 0,
    fabricatesWhenMisdeclared: misdeclared.findings.items.length > full.findings.items.length,
    verdict: honest.findings.items.length === 0 && misdeclared.findings.items.length > 0
      ? 'GUARD HOLDS on an honest declaration, and FABRICATES on a wrong one — the declaration is the whole protection'
      : 'see values',
  },
}, null, 2))

// SECOND SHAPE. Keep-newest truncation drops the OLDEST events, so it protects
// an absence-keyed rule only when the disconfirming evidence is NEWER. Reverse
// that: "a success with no PRIOR failure" — here the disconfirming event is the
// oldest, and truncation is exactly what removes it.
const priorKeyed = (declaredMonotonic: boolean): Detector<Ev> => ({
  id: 'prior-absence', monotonic: declaredMonotonic,
  run: (applicable): DetectorResult => {
    const failedBefore = new Set(applicable.filter(e => e.kind === 'FAILURE').map(e => e.user))
    const accused = [...new Set(applicable.filter(e => e.kind === 'SUCCESS' && !failedBefore.has(e.user)).map(e => e.user))]
    return { status: 'RAN', assessed: applicable.length, declined: {},
      findings: accused.map(u => ({ detectorId: 'prior-absence',
        subject: { kind: 'DIRECTORY_USER' as const, userRef: u, correlation: { available: false as const, because: 'qa probe' } }, observedAt: '2026-09-10T00:00:00.000Z' })) }
  },
})
const priorFull = run(priorKeyed(false), 100)
const priorMis = run(priorKeyed(true), 1)
console.log(JSON.stringify({
  QA_TRUNCATION_FABRICATION_REVERSE_SHAPE: {
    fullWindow: shape(priorFull),
    truncated_MISdeclaredMonotonic: shape(priorMis),
    fabricated: priorMis.findings.items.length > priorFull.findings.items.length,
    verdict: priorMis.findings.items.length > priorFull.findings.items.length
      ? 'FABRICATION CONFIRMED: an accusation exists on the truncated window that does not exist on the full one'
      : 'no fabrication in this shape either',
  },
}, null, 2))
