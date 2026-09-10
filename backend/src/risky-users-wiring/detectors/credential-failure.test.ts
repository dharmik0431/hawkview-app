import assert from 'node:assert/strict'
import test from 'node:test'
import { credentialFailureDetector } from './credential-failure.js'
import { evaluate } from '../../evaluation-core/evaluate.js'
import type { EventOutcome, NormalizedEvent } from '../../risky-users-normalization/contract.js'
import type { Finding, FindingSignal } from '../../evaluation-core/contract.js'

/** The detector that produced every finding on real tenants, and which had no
 * unit test until the timestamp defect was found in it. It was exercised only
 * by runs against production, which is why a field could be wrong by eighteen
 * days without anything failing. */

const event = (subjectRef: string, outcome: EventOutcome, eventAt: string): NormalizedEvent => ({
  organizationId: 'org', customerTenantId: 'tenant', microsoftTenantId: 'ms',
  source: 'GRAPH_SIGN_INS',
  eventId: `${subjectRef}-${eventAt}`,
  eventAt,
  ingestedAt: '2026-09-10T23:00:00.000Z',
  subjectRef,
  subjectBinding: 'DIRECTORY_OBJECT_ID',
  applicationRef: 'app',
  errorCode: null,
  clientSource: { qualification: 'NOT_REPORTED', address: null },
  classification: { kind: 'APPLIES', outcome },
})

const run = (events: readonly NormalizedEvent[], maxEvents = 1000) => evaluate<NormalizedEvent>({
  evidence: {
    availability: 'READ',
    applies: events,
    coverage: {
      collectionScope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' },
      applies: events.length,
      doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {},
    },
    timeOf: item => item.eventAt,
  },
  detectors: [credentialFailureDetector().detector],
  budget: { maxEvents },
})

const signalOf = (finding: Finding, name: string): FindingSignal | undefined =>
  finding.signals.find(entry => entry.signal === name)

test('each signal carries its OWN recency, not the family’s', () => {
  // THE DEFECT, reproduced at the smallest size that shows it. On The Raymonds
  // one account had 467 lockouts ending 3 September and a password rejection on
  // the 9th; the finding reported the 9th beside the lockout count, overstating
  // the storm's recency by six days. Measured across the nine live findings the
  // worst was eighteen days — and it was accurate on the tenants where the
  // attack was still running and wrong on the ones where it had stopped, which
  // is the only case where the field changes what anyone does.
  const result = run([
    event('victim', 'LOCKED_OUT_AFTER_REPEATED_FAILURES', '2026-09-03T10:00:00.000Z'),
    event('victim', 'LOCKED_OUT_AFTER_REPEATED_FAILURES', '2026-09-03T11:00:00.000Z'),
    event('victim', 'PASSWORD_REJECTED', '2026-09-09T04:00:00.000Z'),
  ])

  const [finding] = result.findings.items
  assert.ok(finding)
  assert.equal(signalOf(finding, 'LOCKED_OUT_AFTER_REPEATED_FAILURES')?.count, 2)
  // The lockouts' own last occurrence — NOT the later rejection.
  assert.equal(signalOf(finding, 'LOCKED_OUT_AFTER_REPEATED_FAILURES')?.latest?.at, '2026-09-03T11:00:00.000Z')
  assert.equal(signalOf(finding, 'PASSWORD_REJECTED')?.count, 1)
  assert.equal(signalOf(finding, 'PASSWORD_REJECTED')?.latest?.at, '2026-09-09T04:00:00.000Z')

  // And no single field a surface could reach for and pair with the wrong
  // count. Removing `observedAt` is what makes the misrendering unwriteable
  // rather than merely discouraged.
  assert.equal((finding as Record<string, unknown>).observedAt, undefined)
})

test('a recency says what KIND of time it is, and this rule only ever reports event times', () => {
  // The counterpart detector, `external-mailbox-forwarding`, reports
  // STATE_OBSERVED — a read time, because Exchange gives no moment at which a
  // forwarding rule was configured. Both were briefly a bare string, so a
  // renderer told them apart by knowing which rule had produced them.
  //
  // A READ TIME IS ALWAYS RECENT. That made a six-month-old forwarding rule
  // render as the most urgent item on the screen, and made the error grow as
  // collection improved. Everything this rule reports is an event that actually
  // happened, so it must never claim otherwise.
  const result = run([
    event('victim', 'LOCKED_OUT_AFTER_REPEATED_FAILURES', '2026-09-03T10:00:00.000Z'),
    event('victim', 'PASSWORD_REJECTED', '2026-09-09T04:00:00.000Z'),
  ])
  const [finding] = result.findings.items
  assert.ok(finding)
  for (const signal of finding.signals) {
    if (signal.latest === null) continue
    assert.equal(signal.latest.kind, 'EVENT_OCCURRED', `${signal.signal} must report an event time`)
  }
})

test('a signal evaluated and absent is present with a null recency, not omitted', () => {
  // Biolink's fourth account: no lockouts at all, seven rejections. If the
  // array listed only non-zero signals, "we looked for lockouts and found none"
  // and "we never looked for lockouts" would be one state — this feature's
  // signature defect, one level down from an uncollected window reading as a
  // quiet tenant.
  const result = run([0, 1, 2, 3, 4].map(index =>
    event('rejected-only', 'PASSWORD_REJECTED', `2026-09-0${index + 1}T10:00:00.000Z`)))

  const [finding] = result.findings.items
  assert.ok(finding)
  const lockouts = signalOf(finding, 'LOCKED_OUT_AFTER_REPEATED_FAILURES')
  assert.ok(lockouts, 'the evaluated-and-empty signal must still be listed')
  assert.equal(lockouts.count, 0)
  assert.equal(lockouts.latest, null)
  assert.equal(signalOf(finding, 'PASSWORD_REJECTED')?.count, 5)
})

test('counts from a truncated window are marked as floors', () => {
  // The window overflows, so `evaluate` keeps only the most recent events and
  // every count the detector produces is a floor. The detector is handed an
  // already-truncated slice and cannot know — so the core stamps it, and a
  // surface rendering "467" instead of "at least 467" is prevented by the data
  // rather than by remembering to check the claim.
  const events = [0, 1, 2, 3, 4, 5].map(index =>
    event('victim', 'LOCKED_OUT_AFTER_REPEATED_FAILURES', `2026-09-0${index + 1}T10:00:00.000Z`))

  const whole = run(events)
  const truncated = run(events, 3)

  assert.equal(whole.findings.items[0]?.signals.every(signal => !signal.capped), true)
  assert.equal(truncated.findings.items[0]?.signals.every(signal => signal.capped), true)
  // The count really did shrink, so the flag is describing something true
  // rather than being set on a total that happens to be complete.
  assert.equal(signalOf(whole.findings.items[0]!, 'LOCKED_OUT_AFTER_REPEATED_FAILURES')?.count, 6)
  assert.equal(signalOf(truncated.findings.items[0]!, 'LOCKED_OUT_AFTER_REPEATED_FAILURES')?.count, 3)
})

test('the threshold decides a rejection-only subject, and a lockout needs no threshold', () => {
  // Microsoft documents that smart lockout ignores repeats of the SAME wrong
  // password, so one lockout implies varied attempts. Rejections in volume are
  // evidence only in aggregate.
  const oneLockout = run([event('a', 'LOCKED_OUT_AFTER_REPEATED_FAILURES', '2026-09-01T10:00:00.000Z')])
  assert.equal(oneLockout.findings.items.length, 1)

  const fourRejections = run([0, 1, 2, 3].map(index =>
    event('b', 'PASSWORD_REJECTED', `2026-09-0${index + 1}T10:00:00.000Z`)))
  assert.equal(fourRejections.findings.items.length, 0)
})
