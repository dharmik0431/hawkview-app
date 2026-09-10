// QA: one shape proves one shape. Keep-newest truncation protects an
// absence-keyed rule only when the disconfirming evidence is NEWER than the
// confirming evidence. This enumerates rule shapes through the REAL truncation
// path and reports which fabricate an accusation that does not exist on the
// full window. All are mis-declared monotonic: true, which is the condition the
// standing rule exists to prevent.
import { evaluate } from './evaluate.js'
import type { Detector, DetectorResult, Finding } from './contract.js'

type Ev = Readonly<{ id: string; kind: string; user: string; ip: string; at: string }>
const t = (n: number) => new Date(Date.UTC(2026, 8, 10, 0, 0, n)).toISOString()
const ev = (id: string, kind: string, ip: string, n: number): Ev => ({ id, kind, user: 'alice', ip, at: t(n) })

const accuse = (id: string): Finding => ({
  detectorId: id, subject: { kind: 'DIRECTORY_USER', userRef: 'alice', correlation: { available: false as const, because: 'probe' } },
  observedAt: t(0),
})
const det = (id: string, fires: (e: readonly Ev[]) => boolean): Detector<Ev> => ({
  id, monotonic: true, // deliberately mis-declared for every shape
  run: (applicable): DetectorResult => ({ status: 'RAN', assessed: applicable.length, declined: {}, findings: fires(applicable) ? [accuse(id)] : [] }),
})

// Oldest -> newest. Keep-newest truncation drops from the FRONT.
const pool: readonly Ev[] = [
  ev('a', 'SUCCESS', '10.0.0.1', 1), ev('b', 'FAILURE', '10.0.0.1', 2),
  ev('c', 'FAILURE', '10.0.0.1', 3), ev('d', 'FAILURE', '10.0.0.2', 4),
  ev('e', 'SUCCESS', '10.0.0.2', 5),
]
const shapes: readonly (readonly [string, string, Detector<Ev>])[] = [
  ['presence-keyed (control)', 'any failure at all',
    det('presence', e => e.some(x => x.kind === 'FAILURE'))],
  ['absence, disconfirming NEWER', 'failures with no LATER success',
    det('absence-newer', e => e.some(x => x.kind === 'FAILURE') && !e.some(x => x.kind === 'SUCCESS' && x.at > (e.filter(y => y.kind === 'FAILURE').at(-1)?.at ?? '')))],
  ['absence, disconfirming OLDER', 'success with no EARLIER failure',
    det('absence-older', e => e.some(x => x.kind === 'SUCCESS') && !e.some(x => x.kind === 'FAILURE'))],
  ['first-occurrence', 'activity from an IP with no prior history',
    det('first-seen', e => { const ips = new Set(e.map(x => x.ip)); return ips.size === 1 && e.length > 0 })],
  ['ratio', 'more failures than successes',
    det('ratio', e => e.filter(x => x.kind === 'FAILURE').length > e.filter(x => x.kind === 'SUCCESS').length)],
]

const run = (d: Detector<Ev>, maxEvents: number) => evaluate({
  evidence: { availability: 'READ', applies: pool,
    coverage: { collectionScope: { declared: true, asked: 'ALL' }, applies: pool.length, doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {} }, timeOf: (e: Ev) => e.at },
  detectors: [d], budget: { maxEvents },
})

const rows = shapes.map(([name, rule, d]) => {
  const full = run(d, 100).findings.items.length
  // Every truncation depth, so no single depth can mislead the way one shape did.
  const fabricatesAt = [4, 3, 2, 1].filter(n => run(d, n).findings.items.length > full)
  return { shape: name, rule, accusedOnFullWindow: full > 0, fabricatesAtDepths: fabricatesAt, fabricates: fabricatesAt.length > 0 }
})
console.log(JSON.stringify({
  QA_TRUNCATION_SHAPES: {
    rows,
    fabricating: rows.filter(r => r.fabricates).map(r => r.shape),
    safe: rows.filter(r => !r.fabricates).map(r => r.shape),
    conclusion: `${rows.filter(r => r.fabricates).length} of ${rows.length} shapes fabricate under keep-newest truncation when monotonic is mis-declared`,
  },
}, null, 2))
