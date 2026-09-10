import assert from 'node:assert/strict'
import test from 'node:test'
import { composeTenantAssessment, type StreamAssessment } from './compose.js'
import { evaluate } from './evaluate.js'
import type { Coverage, Detector, Finding } from './contract.js'
import { figure } from './test-support.js'

type Event = Readonly<{ subject: string; match?: boolean }>

const coverage = (parts: Partial<Coverage> = {}): Coverage =>
  ({ collectionScope: { declared: true, asked: 'test fixture: all rows' }, applies: 0, doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {}, ...parts })

const matching: Detector<Event> = {
  id: 'matches-flagged',
  monotonic: true,
  run: applicable => ({
    status: 'RAN', assessed: applicable.length, declined: {},
    findings: applicable.filter(item => item.match).map(item => ({
      detectorId: 'matches-flagged',
      subject: { kind: 'DIRECTORY_USER', userRef: item.subject, correlation: { available: true, shape: 'DIRECTORY_OBJECT_ID', ref: 'guid-' + item.subject } } as const,
      signals: [{ signal: 'TEST_SIGNAL', count: 1, latest: '2026-09-10T00:00:00.000Z' }] as const,
    })),
  }),
}

const userRefOf = (finding: Finding): string | null =>
  finding.subject.kind === 'DIRECTORY_USER' ? finding.subject.userRef : null

/** Built through `evaluate` rather than as literals, so these are assessments
 * the core actually produces — a hand-written one could drift from it and take
 * the composition tests with it. */
const stream = (name: string, events: readonly Event[], options: Partial<{ coverage: Coverage }> = {}): StreamAssessment => ({
  stream: name,
  assessment: evaluate<Event>({
    evidence: {
      availability: 'READ',
      applies: events,
      coverage: options.coverage ?? coverage({ applies: events.length }),
      timeOf: () => 0,
    },
    detectors: [matching],
    budget: { maxEvents: 1000 },
  }),
})

/** Evidence never collected, or unreadable, carries no events — the contract
 * now admits no other shape, so these cannot express the contradiction the
 * earlier fixtures could. */
const unreadStream = (name: string, availability: 'NEVER_COLLECTED' | 'UNREADABLE_NOW'): StreamAssessment => ({
  stream: name,
  assessment: evaluate<Event>({ evidence: { availability }, detectors: [matching], budget: { maxEvents: 1000 } }),
})
const uncollectedStream = (name: string): StreamAssessment => unreadStream(name, 'NEVER_COLLECTED')
const unreadableStream = (name: string): StreamAssessment => unreadStream(name, 'UNREADABLE_NOW')

const found = (subject: string): Event => ({ subject, match: true })

test('rule 1: a stream that could not be read never hides what another stream found', () => {
  const result = composeTenantAssessment([
    stream('sign-ins', [found('alice')]),
    unreadableStream('mailbox-forwarding'),
  ])
  // The finding survives. Suppressing it because some *other* evidence was
  // unreadable is the veto pattern, and it is what put a real detection behind
  // an "unavailable" banner in production.
  assert.deepEqual(result.findings.items.map(userRefOf), ['alice'])
})

test('rule 2: an exact tenant zero requires every stream to have permitted a claim', () => {
  const allClean = composeTenantAssessment([
    stream('sign-ins', [{ subject: 'alice' }]),
    stream('mailbox-forwarding', [{ subject: 'bob' }]),
  ])
  assert.deepEqual(allClean.claim, { permitted: true })
  assert.deepEqual(figure(allClean.count), { accuracy: 'EXACT', value: 0 })

  // One stream short of complete is not complete, however clean the rest read.
  const oneShort = composeTenantAssessment([
    stream('sign-ins', [{ subject: 'alice' }]),
    uncollectedStream('mailbox-forwarding'),
  ])
  assert.equal(oneShort.claim.permitted, false)
  assert.notEqual(oneShort.count.accuracy, 'EXACT')
})

test('rule 3: mixed readable and unreadable streams give a floor, not an unavailable', () => {
  const result = composeTenantAssessment([
    stream('sign-ins', [found('alice'), found('carol')]),
    unreadableStream('mailbox-forwarding'),
  ])
  // What the readable stream established is real and stays reportable. Rounding
  // the whole tenant down to "unavailable" would throw away two confirmed
  // findings to describe a third we could not look for.
  assert.deepEqual(figure(result.count), { accuracy: 'AT_LEAST', value: 2 })
})

test('rule 4: a withheld stream names itself, and streams do not share one reason', () => {
  const result = composeTenantAssessment([
    uncollectedStream('sign-ins'),
    unreadableStream('mailbox-forwarding'),
    stream('audit-log', [{ subject: 'carol' }]),
  ])
  assert.equal(result.claim.permitted, false)
  assert.deepEqual(result.claim.permitted === false && result.claim.withheld, [
    { stream: 'sign-ins', because: 'NEVER_COLLECTED' },
    { stream: 'mailbox-forwarding', because: 'UNREADABLE_NOW' },
  ])
  // Two different failures keep two different sentences, and the stream that
  // answered is not dragged into either. Collapsing these is precisely how one
  // label came to mean both "never collected" and "could not read just now".
  const reasons = result.claim.permitted === false ? result.claim.withheld.map(entry => entry.because) : []
  assert.equal(new Set(reasons).size, 2)
})

test('the corollary falls out rather than being coded: no lower bound of zero', () => {
  // One unreadable stream, nothing found in the readable ones. "At least none"
  // is not a statement, so this must report not-available — and it does so
  // through the same countOf the per-stream path uses, not a special case here.
  const result = composeTenantAssessment([
    stream('sign-ins', [{ subject: 'alice' }]),
    unreadableStream('mailbox-forwarding'),
  ])
  assert.deepEqual(figure(result.count), { accuracy: 'NOT_AVAILABLE', value: null })

  // Exhaustively: no arrangement of streams produces a zero-valued floor, and
  // an exact count appears exactly when the tenant claim is permitted.
  for (const readable of [true, false]) {
    for (const hits of [[], [found('alice')], [found('alice'), found('bob')]]) {
      const composed = composeTenantAssessment([
        stream('sign-ins', hits),
        readable ? stream('mailbox-forwarding', [{ subject: 'zed' }]) : unreadableStream('mailbox-forwarding'),
      ])
      assert.ok(!(composed.count.accuracy === 'AT_LEAST' && composed.count.value === 0))
      assert.equal(composed.count.accuracy === 'EXACT', composed.claim.permitted)
    }
  }
})

test('a tenant with no evidence streams cannot report a clean zero', () => {
  // The empty denominator one level up. Nothing was assessed, so there is
  // nothing to be clean about, and no stream exists to name itself.
  const result = composeTenantAssessment([])
  assert.deepEqual(result.claim, { permitted: false, withheld: [{ stream: null, because: 'NOTHING_APPLICABLE' }] })
  assert.deepEqual(figure(result.count), { accuracy: 'NOT_AVAILABLE', value: null })
})

test('a stream that ran and found nothing is not a stream that failed', () => {
  // Both contribute no findings; only one costs the exact claim. The previous
  // engine could not tell these apart, which is how 1,054 runs of never-exercised
  // detectors read as a clean estate.
  const silent = composeTenantAssessment([stream('sign-ins', [{ subject: 'alice' }])])
  assert.deepEqual(silent.claim, { permitted: true })
  assert.deepEqual(figure(silent.count), { accuracy: 'EXACT', value: 0 })

  const failed = composeTenantAssessment([unreadableStream('sign-ins')])
  assert.equal(failed.claim.permitted, false)
})

test('a user found in two streams is one user', () => {
  const result = composeTenantAssessment([
    stream('sign-ins', [found('alice')]),
    stream('audit-log', [found('alice'), found('bob')]),
  ])
  assert.equal(result.findings.items.length, 3)
  // Counts people, not findings — two streams noticing the same person is one
  // person at risk, and a headline that said three would be inflating it. This
  // is the owner's explicit requirement, so getting it wrong is visible.
  assert.deepEqual(figure(result.count), { accuracy: 'EXACT', value: 2 })
})

test('mailbox findings cross streams without ever becoming people', () => {
  const mailboxStream: StreamAssessment = {
    stream: 'mailbox-forwarding',
    assessment: evaluate<Event>({
      evidence: { availability: 'READ', applies: [{ subject: 'shared-billing' }], coverage: coverage({ applies: 1 }), timeOf: () => 0 },
      detectors: [{
        id: 'external-mailbox-forwarding',
        monotonic: true,
        run: applicable => ({
          status: 'RAN', assessed: applicable.length, declined: {},
          findings: applicable.map(item => ({
            detectorId: 'external-mailbox-forwarding',
            subject: { kind: 'MAILBOX', mailboxRef: item.subject, binding: 'RESOLVED_NEGATIVE' } as const,
            signals: [{ signal: 'TEST_SIGNAL', count: 1, latest: '2026-09-10T00:00:00.000Z' }] as const,
          })),
        }),
      }],
      budget: { maxEvents: 1000 },
    }),
  }

  const result = composeTenantAssessment([stream('sign-ins', [found('alice')]), mailboxStream])
  // Both findings reach the tenant view — rule 1 does not care which namespace.
  assert.equal(result.findings.items.length, 2)
  // But only alice is a person. A shared mailbox has a directory GUID too, and
  // counting it would tell an MSP two humans are affected when one is a room.
  assert.deepEqual(figure(result.count), { accuracy: 'EXACT', value: 1 })
  assert.deepEqual(result.findings.items.map(userRefOf), ['alice', null])
})

test('a partly uninterpretable stream withholds the tenant claim under its own reason', () => {
  const result = composeTenantAssessment([
    stream('sign-ins', [found('alice')], { coverage: coverage({ applies: 1, unknown: { UNRECOGNIZED_OUTCOME: 3 } }) }),
    stream('mailbox-forwarding', [{ subject: 'bob' }]),
  ])
  assert.deepEqual(result.claim, {
    permitted: false,
    withheld: [{ stream: 'sign-ins', because: 'UNINTERPRETED_EVENTS' }],
  })
  assert.deepEqual(figure(result.count), { accuracy: 'AT_LEAST', value: 1 })
})
