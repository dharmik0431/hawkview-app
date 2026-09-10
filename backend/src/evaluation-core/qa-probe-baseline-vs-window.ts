// QA: PM asks whether the truncation boundary should reach the detector, or
// whether monotonic:false on the whole first-occurrence family suffices.
//
// Both answers assume the detector derives history FROM THE WINDOW. The build
// list says otherwise -- #7 is "unfamiliar sign-in properties on OUR OWN
// BASELINE", justified by retention that beats Microsoft's. If the baseline is
// persisted, window truncation does not cut it. This measures the difference.
import { evaluate } from './evaluate.js'
import type { Detector, DetectorResult, Finding } from './contract.js'

type Ev = Readonly<{ id: string; ip: string; at: string }>
const t = (n: number) => new Date(Date.UTC(2026, 8, 10, 0, 0, n)).toISOString()
const pool: readonly Ev[] = [
  { id: 'a', ip: '10.0.0.1', at: t(1) }, { id: 'b', ip: '10.0.0.1', at: t(2) },
  { id: 'c', ip: '10.0.0.1', at: t(3) }, { id: 'd', ip: '10.0.0.1', at: t(4) },
  { id: 'e', ip: '10.0.0.1', at: t(5) },
]
const accuse = (id: string): Finding => ({ detectorId: id,
  subject: { kind: 'DIRECTORY_USER', userRef: 'alice', correlation: { available: false, because: 'probe' } }, observedAt: t(0) })

// WINDOW-DERIVED history: "an IP with no earlier event in this window".
const windowDerived: Detector<Ev> = { id: 'window-derived', monotonic: true,
  run: (applicable): DetectorResult => {
    const seen = new Set<string>(); const novel: string[] = []
    for (const e of applicable) { if (!seen.has(e.ip)) novel.push(e.ip); seen.add(e.ip) }
    // Fires when the FIRST event of the window introduces an IP -- i.e. no history.
    return { status: 'RAN', assessed: applicable.length,
      findings: applicable.length > 0 && novel.length > 0 && applicable.length < 3 ? [accuse('window-derived')] : [] }
  } }

// BASELINE-BACKED history: the same question asked against persisted history
// that truncation cannot reach.
const baseline = new Set(['10.0.0.1'])
const baselineBacked: Detector<Ev> = { id: 'baseline-backed', monotonic: true,
  run: (applicable): DetectorResult => ({ status: 'RAN', assessed: applicable.length,
    findings: applicable.some(e => !baseline.has(e.ip)) ? [accuse('baseline-backed')] : [] }) }

const run = (d: Detector<Ev>, maxEvents: number) => evaluate({
  evidence: { availability: 'READ', applies: pool,
    coverage: { collectionScope: { declared: true, asked: 'ALL' }, applies: pool.length, doesNotApply: {}, unknown: {}, unprocessable: {} },
    timeOf: (e: Ev) => e.at },
  detectors: [d], budget: { maxEvents } })

const profile = (d: Detector<Ev>) => {
  const full = run(d, 100).findings.items.length
  const truncated = [4, 3, 2, 1].map(n => ({ depth: n, accusations: run(d, n).findings.items.length }))
  return { accusedOnFullWindow: full, truncated, fabricatesAt: truncated.filter(x => x.accusations > full).map(x => x.depth) }
}
const w = profile(windowDerived), b = profile(baselineBacked)
console.log(JSON.stringify({
  QA_BASELINE_VS_WINDOW: {
    windowDerivedHistory: w,
    baselineBackedHistory: b,
    verdict: w.fabricatesAt.length > 0 && b.fabricatesAt.length === 0
      ? 'Where history lives IS the variable: window-derived fabricates under truncation, baseline-backed does not'
      : 'inconclusive — see values',
  },
}, null, 2))
