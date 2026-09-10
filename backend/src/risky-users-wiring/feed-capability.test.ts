import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bindToFeed, capabilityOf, outcomeDeclarationGaps, unreachableRequirements, type FeedBoundDetector,
} from './feed-capability.js'
import { evaluate } from '../evaluation-core/evaluate.js'
import type { EventOutcome, NormalizedEvent } from '../risky-users-normalization/contract.js'
import type { Coverage } from '../evaluation-core/contract.js'

/** The real shape of the problem: a rule that reads "failures, then a success". */
const failuresThenSuccess: FeedBoundDetector = {
  detector: {
    id: 'invalid-attempts-then-success',
    monotonic: true,
    run: applicable => ({ status: 'RAN', considered: applicable.length, declined: {}, findings: [] }),
  },
  requires: ['PASSWORD_REJECTED', 'PASSWORD_ACCEPTED_COMPLETED'],
}

const feed = (name: string, outcomes: readonly EventOutcome[]) =>
  ({ feed: name, reachable: new Set(outcomes) })

const coverage = (applies: number): Coverage => ({
  collectionScope: { declared: true, asked: 'test fixture' },
  applies, doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {},
})

test('a feed that cannot produce half the pattern is identified before the rule runs', () => {
  // The audit feed's real historical state: failures, and no source of
  // successes whatsoever.
  const failuresOnly = feed('audit', ['PASSWORD_REJECTED'])
  assert.deepEqual(unreachableRequirements(failuresThenSuccess, failuresOnly), ['PASSWORD_ACCEPTED_COMPLETED'])

  const bothReachable = feed('graph', ['PASSWORD_REJECTED', 'PASSWORD_ACCEPTED_COMPLETED'])
  assert.deepEqual(unreachableRequirements(failuresThenSuccess, bothReachable), [])
})

test('an inert rule reports that it cannot run, rather than that it found nothing', () => {
  // Without this the detector reports considered: N, matched: 0 — a healthy
  // silent detector — and nothing anywhere distinguishes "no compromise
  // happened" from "this rule could never have fired here".
  const bound = bindToFeed(failuresThenSuccess, feed('audit', ['PASSWORD_REJECTED']))
  const events = [{ eventAt: '2026-09-10T00:00:00.000Z' }] as unknown as NormalizedEvent[]
  const result = evaluate<NormalizedEvent>({
    evidence: { availability: 'READ', applies: events, coverage: coverage(1), timeOf: event => event.eventAt },
    detectors: [bound],
    budget: { maxEvents: 100 },
  })

  const report = result.detectors[0]
  assert.equal(report?.status, 'INAPPLICABLE')
  assert.match(report?.status === 'INAPPLICABLE' ? report.because : '', /PASSWORD_ACCEPTED_COMPLETED/)
  assert.match(report?.status === 'INAPPLICABLE' ? report.because : '', /audit/)

  // It narrows the count's scope rather than gating the claim — the same
  // treatment as a check whose source lacks conditional-access data, because it
  // is the same fact.
  assert.deepEqual(result.count.scope.covered, [])
  assert.equal(result.count.scope.notCovered.length, 1)
})

test('the rule is replaced, never dropped', () => {
  // Filtering it out would leave the tenant one check short with nothing saying
  // so — the disappearance this design exists to prevent.
  const bound = bindToFeed(failuresThenSuccess, feed('audit', ['PASSWORD_REJECTED']))
  assert.equal(bound.id, failuresThenSuccess.detector.id, 'same identity, so the scope can name it')
  assert.equal(bound.monotonic, failuresThenSuccess.detector.monotonic)
})

test('a feed that supports the pattern gets the real detector, untouched', () => {
  const bound = bindToFeed(failuresThenSuccess, feed('graph', ['PASSWORD_REJECTED', 'PASSWORD_ACCEPTED_COMPLETED']))
  assert.equal(bound, failuresThenSuccess.detector, 'not a wrapper — the detector itself')
})

test('the real capability sets come from the classifier, not from deriving its tables', () => {
  // Engineer 3's warning, pinned. Deriving the audit set from the reason-name
  // table yields a feed with NO successes — audit successes come from
  // `Operation`, where no logon error exists — which would declare every
  // failures-then-success rule inapplicable on that feed. The original
  // inert-detector bug, re-created by the machinery built to detect it, and
  // worse because it would be stated confidently rather than passing silently.
  const audit = capabilityOf('M365_AUDIT_STS')
  assert.ok(audit.reachable.has('PASSWORD_ACCEPTED_COMPLETED'),
    'the audit feed reaches successes; a derived set would say it does not')
  assert.ok(audit.reachable.has('PASSWORD_REJECTED'))

  // So the rule that could never fire there now runs there.
  assert.deepEqual(unreachableRequirements(failuresThenSuccess, audit), [])
  assert.equal(bindToFeed(failuresThenSuccess, audit), failuresThenSuccess.detector)
})

test('a rule needing an outcome the audit feed cannot express is inapplicable there, and runs on Graph', () => {
  const needsChallengeNotPassed: FeedBoundDetector = {
    detector: failuresThenSuccess.detector,
    requires: ['PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED'],
  }
  const audit = capabilityOf('M365_AUDIT_STS')
  const graph = capabilityOf('GRAPH_SIGN_INS')

  // Unreachable on audit: no reason name maps to it, so no audit row can
  // produce one however the tenant behaves.
  assert.deepEqual(unreachableRequirements(needsChallengeNotPassed, audit),
    ['PASSWORD_ACCEPTED_CHALLENGE_NOT_PASSED'])
  assert.notEqual(bindToFeed(needsChallengeNotPassed, audit), needsChallengeNotPassed.detector)

  // Reachable on Graph, so it runs there.
  assert.deepEqual(unreachableRequirements(needsChallengeNotPassed, graph), [])
})

test('a mapped-but-never-observed outcome must not make a rule inapplicable', () => {
  // The mirror falsifier, and the direction that bites: a check that only ever
  // verifies the INAPPLICABLE path would pass a capability set that declares
  // everything inapplicable. A quiet window is not an incapable feed.
  //
  // The post-password interrupt family has never been observed on Graph — zero
  // rows, all tenants, all history — but it is mapped, so a rule reading it
  // must still RUN there and be allowed to find nothing.
  const interrupt: FeedBoundDetector = {
    detector: failuresThenSuccess.detector,
    requires: ['PASSWORD_ACCEPTED_CHALLENGE_ISSUED', 'PASSWORD_ACCEPTED_REGISTRATION_REQUIRED'],
  }
  const graph = capabilityOf('GRAPH_SIGN_INS')
  assert.deepEqual(unreachableRequirements(interrupt, graph), [],
    'mapped-not-observed is reachable: the tenant had a good month, the feed is not incapable')
  assert.equal(bindToFeed(interrupt, graph), interrupt.detector, 'so it runs, and may honestly find nothing')
})

test('a rule reading an outcome it did not declare is caught, in the dangerous direction', () => {
  // The direction that bites: the rule reads something nobody said it needed,
  // so it never goes INAPPLICABLE and quietly runs on a feed that cannot feed
  // it — the inert detector, arrived at through an under-declaration instead of
  // through nobody asking.
  const underDeclared: FeedBoundDetector = {
    detector: {
      id: 'reads-more-than-it-says',
      monotonic: true,
      run: applicable => ({
        status: 'RAN',
        considered: applicable.length,
        declined: {},
        findings: applicable.some(item => item.classification.kind === 'APPLIES' && item.classification.outcome === 'PASSWORD_ACCEPTED_COMPLETED') ? [] : [],
      }),
    },
    requires: ['PASSWORD_REJECTED'],
  }
  const gaps = outcomeDeclarationGaps(underDeclared)
  assert.deepEqual(gaps.readNotDeclared, ['PASSWORD_ACCEPTED_COMPLETED'])
  assert.deepEqual(gaps.declaredNotRead, ['PASSWORD_REJECTED'])
})

test('an honest declaration has no gaps in either direction', () => {
  const honest: FeedBoundDetector = {
    detector: {
      id: 'says-what-it-reads',
      monotonic: true,
      run: applicable => ({
        status: 'RAN',
        considered: applicable.length,
        declined: {},
        findings: applicable.some(item =>
          item.classification.kind === 'APPLIES' && item.classification.outcome === 'PASSWORD_REJECTED' || item.classification.kind === 'APPLIES' && item.classification.outcome === 'PASSWORD_ACCEPTED_COMPLETED') ? [] : [],
      }),
    },
    requires: ['PASSWORD_REJECTED', 'PASSWORD_ACCEPTED_COMPLETED'],
  }
  assert.deepEqual(outcomeDeclarationGaps(honest), { readNotDeclared: [], declaredNotRead: [] })
})

test('a mention that is not a read can be explained, per detector and not globally', () => {
  // Engineer 3's caveat, which cost them a false pass: a shared allowlist lets
  // one explanation cover a mention somewhere else, so a NEW unexplained
  // mention stops failing. Keyed per detector, this one still fails.
  const guarded: FeedBoundDetector = {
    detector: {
      id: 'excludes-one',
      monotonic: true,
      run: applicable => ({
        status: 'RAN',
        considered: applicable.length,
        declined: {},
        // Mentioned in order to be skipped, not read for its meaning.
        findings: applicable.filter(item => item.classification.kind !== 'APPLIES' || item.classification.outcome !== 'BLOCKED_BY_CONTROL').length >= 0 ? [] : [],
      }),
    },
    requires: [],
    mentionsNotRead: ['BLOCKED_BY_CONTROL'],
  }
  assert.deepEqual(outcomeDeclarationGaps(guarded).readNotDeclared, [])

  // The same detector with a second, unexplained mention still fails — the
  // explanation covers what it names and nothing else.
  const alsoReadsAnother: FeedBoundDetector = {
    ...guarded,
    detector: {
      ...guarded.detector,
      run: applicable => ({
        status: 'RAN',
        considered: applicable.length,
        declined: {},
        findings: applicable.filter(item =>
          item.classification.kind !== 'APPLIES' || item.classification.outcome !== 'BLOCKED_BY_CONTROL' && item.classification.kind === 'APPLIES' && item.classification.outcome === 'PASSWORD_REJECTED').length >= 0 ? [] : [],
      }),
    },
  }
  assert.deepEqual(outcomeDeclarationGaps(alsoReadsAnother).readNotDeclared, ['PASSWORD_REJECTED'])
})
