import assert from 'node:assert/strict'
import test from 'node:test'
import { ALERT_CATALOG } from './alert-catalog.js'
import {
  conditionSatisfied,
  coveredSources,
  everyCoveredSourceReadable,
  type ClearingObservation,
  type SourceState,
} from './alert-clearing.js'

/** EVERY DECLARED RESOLVING CONDITION IS SATISFIABLE.
 *
 * The gap QA found, and it was in my test rather than in the catalogue.
 * `alert-catalog.test.ts` proves every type STATES a condition; `assert.ok(kind)`
 * is satisfied by any non-empty string, including one naming a state the system
 * can never be in. An existence assertion on a field whose CONTENT is the point is
 * a spelling test.
 *
 * It matters in one direction especially: a condition too strong to satisfy
 * produces an alert that never auto-clears, and this feature exists because 353
 * alerts never cleared. The strictness of EVERY_COVERED_SOURCE_READABLE was right;
 * the unchecked half of it was a phone-tier page that could never close.
 *
 * NOTHING HERE WEAKENS A CONDITION TO GO GREEN. If a condition were unsatisfiable
 * the finding would be a defect in the declaration, not a reason to relax it —
 * weakening EVERY_COVERED_SOURCE_READABLE back toward COLLECTOR_REPORTS_SUCCESS
 * would make this file pass by restoring the defect it was ruled out to fix.
 */

const base: ClearingObservation = {
  sources: [],
  connectionVerified: false,
  configurationRestored: false,
  eventsInWindow: 1,
  windowReadableThroughout: false,
}

/** One state per declared kind that SATISFIES it, and one that does not.
 *
 * Both are required. Without the falsifying state a witness that always returned
 * true would report every condition satisfiable, which is the same vacuity one
 * level up — the control needs to discriminate, not merely fire. */
const WITNESS: Record<string, { satisfying: ClearingObservation; falsifying: ClearingObservation }> = {
  COLLECTOR_REPORTS_SUCCESS: {
    satisfying: { ...base, sources: [{ source: 'SIGN_INS', status: 'SUCCESS' }] },
    falsifying: { ...base, sources: [{ source: 'SIGN_INS', status: 'FAILED' }] },
  },
  EVERY_COVERED_SOURCE_READABLE: {
    // The state that makes the strict condition reachable WITHOUT weakening it,
    // which is the whole point of the covered ruling: the licence and consent gaps
    // are not covered, so they do not hold the page open forever.
    satisfying: {
      ...base,
      sources: [
        { source: 'SIGN_INS', status: 'SUCCESS' },
        { source: 'AUDIT_LOGS', status: 'EMPTY' },
        { source: 'EXCHANGE_MAILBOX_CONFIGURATION', status: 'NOT_LICENSED' },
        { source: 'SECURE_SCORES', status: 'PERMISSION_REQUIRED' },
      ],
    },
    // One COVERED source still unreadable, so the claim is not yet true.
    falsifying: {
      ...base,
      sources: [
        { source: 'SIGN_INS', status: 'SUCCESS' },
        { source: 'AUDIT_LOGS', status: 'FAILED' },
      ],
    },
  },
  CONNECTION_VERIFIED: {
    satisfying: { ...base, connectionVerified: true },
    falsifying: { ...base, connectionVerified: false },
  },
  CONFIGURATION_RESTORED: {
    satisfying: { ...base, configurationRestored: true },
    falsifying: { ...base, configurationRestored: false },
  },
  NO_FURTHER_EVENTS_IN_READABLE_WINDOW: {
    satisfying: { ...base, eventsInWindow: 0, windowReadableThroughout: true },
    // Quiet, but across a window nobody could see. Not evidence of anything.
    falsifying: { ...base, eventsInWindow: 0, windowReadableThroughout: false },
  },
}

test('EVERY declared resolving condition is satisfiable, and discriminates', () => {
  assert.ok(ALERT_CATALOG.length >= 7, 'the catalogue was not read')

  let checked = 0
  for (const declaration of ALERT_CATALOG) {
    const witness = WITNESS[declaration.conditionClears.kind]
    // A new kind with no witness is itself the finding: nobody has shown it can be
    // satisfied. Failing here is correct rather than inconvenient.
    assert.ok(witness, `${declaration.conditionClears.kind} has no witness state`)

    assert.equal(
      conditionSatisfied(declaration.conditionClears, witness.satisfying),
      true,
      `${declaration.id} declares a condition nothing can satisfy`)

    assert.equal(
      conditionSatisfied(declaration.conditionClears, witness.falsifying),
      false,
      `${declaration.id} declares a condition that is satisfied by anything`)

    checked += 1
  }
  assert.equal(checked, ALERT_CATALOG.length, 'the sweep must have covered every type')
})

test('the tenant-blindness condition is reachable WITHOUT weakening it', () => {
  // The specific risk in the strictness ruling: if "every covered source" had meant
  // every configured collector, a tenant with one unlicensed source would have an
  // ACT_NOW page that could never close. Production has 147 collectors with 10
  // failed and 7 stale beyond a week, so that tenant exists today.
  const mixed: readonly SourceState[] = [
    { source: 'SIGN_INS', status: 'SUCCESS' },
    { source: 'EXCHANGE_MAILBOX_CONFIGURATION', status: 'NOT_LICENSED' },
    { source: 'SECURE_SCORES', status: 'PERMISSION_REQUIRED' },
    { source: 'SHAREPOINT_USAGE', status: 'UNSUPPORTED' },
  ]
  assert.equal(everyCoveredSourceReadable(mixed), true)
  assert.deepEqual(coveredSources(mixed).map((source) => source.source), ['SIGN_INS'])

  // POSITIVE CONTROL: a genuinely unreadable COVERED source keeps it open, so the
  // above is the covered ruling rather than a function that always says yes.
  assert.equal(
    everyCoveredSourceReadable([...mixed, { source: 'AUDIT_LOGS', status: 'STALE' }]),
    false)
})

test('a tenant with NOTHING covered does not report restored visibility', () => {
  // THE VACUOUS TRUTH REFUSED. `every` over an empty list is true, so a tenant
  // whose every source is unlicensed or permission-blocked would satisfy "every
  // covered source is readable" while HawkView could see nothing whatsoever — a
  // page claiming visibility came back, closing on a tenant it cannot see.
  assert.equal(
    everyCoveredSourceReadable([
      { source: 'EXCHANGE_MAILBOX_CONFIGURATION', status: 'NOT_LICENSED' },
      { source: 'SECURE_SCORES', status: 'PERMISSION_REQUIRED' },
    ]),
    false)
  assert.equal(everyCoveredSourceReadable([]), false, 'no sources at all is not visibility')

  // POSITIVE CONTROL: one covered, readable source is enough to mean something.
  assert.equal(everyCoveredSourceReadable([{ source: 'SIGN_INS', status: 'SUCCESS' }]), true)
})

test('a permission gap is a task, not blindness', () => {
  // The distinction the ruling rests on. Folding PERMISSION_REQUIRED into this
  // condition converts a problem fixable in minutes into a permanently-open
  // blindness page, and buries the consent task under it.
  const consentGapOnly: readonly SourceState[] = [
    { source: 'SIGN_INS', status: 'SUCCESS' },
    { source: 'AUDIT_LOGS', status: 'PERMISSION_REQUIRED' },
  ]
  assert.equal(everyCoveredSourceReadable(consentGapOnly), true, 'the blindness page may close')

  // And the same shape with a FAILED collector may not, because that is the
  // emergency rather than the task.
  assert.equal(
    everyCoveredSourceReadable([
      { source: 'SIGN_INS', status: 'SUCCESS' },
      { source: 'AUDIT_LOGS', status: 'FAILED' },
    ]),
    false)
})

test('readable means what the evidence engine means by it', () => {
  // One notion of readable, not two. SUCCESS and EMPTY are evidence — a genuinely
  // quiet tenant must be able to report a confident zero — and everything else is
  // not, which is `evidenceFromSync`'s judgement rather than a second list here.
  for (const status of ['SUCCESS', 'EMPTY'] as const) {
    assert.equal(everyCoveredSourceReadable([{ source: 'S', status }]), true, status)
  }
  // COVERED statuses only. NOT_CONFIGURED is deliberately absent from this list —
  // it returns false too, but through the empty-covered guard rather than through
  // unreadability, and a test that cannot tell those apart would keep passing
  // while meaning something else.
  for (const status of ['FAILED', 'STALE', 'PENDING', 'RUNNING', 'UNKNOWN'] as const) {
    assert.equal(everyCoveredSourceReadable([{ source: 'S', status }]), false, status)
    assert.deepEqual(
      coveredSources([{ source: 'S', status }]).map((source) => source.status), [status],
      `${status} must be covered, or the assertion above passes for the wrong reason`)
  }
})

test('a source HawkView was never set up to collect does not hold the page open', () => {
  // THE FAILURE THIS EXCLUSION PREVENTS, and the one I argued the wrong way on.
  // A never-configured source does not become readable without somebody
  // configuring it, so counting it as covered gives a phone-tier page with no path
  // to closure — the 353 problem reached through the fix for it.
  const nineAndOne: readonly SourceState[] = [
    ...Array.from({ length: 9 }, (_, index) => ({ source: `S${index}`, status: 'SUCCESS' as const })),
    { source: 'NEVER_SET_UP', status: 'NOT_CONFIGURED' as const },
  ]
  assert.equal(everyCoveredSourceReadable(nineAndOne), true, 'the page must be able to close')
  assert.equal(coveredSources(nineAndOne).length, 9)

  // POSITIVE CONTROL: the same nine with a FAILED tenth may NOT close, because
  // that one is the emergency rather than a setup task.
  assert.equal(
    everyCoveredSourceReadable([
      ...Array.from({ length: 9 }, (_, index) => ({ source: `S${index}`, status: 'SUCCESS' as const })),
      { source: 'BROKEN', status: 'FAILED' as const },
    ]),
    false)

  // And the case I was protecting against is still protected — by the
  // empty-covered guard, not by counting NOT_CONFIGURED as covered.
  assert.equal(
    everyCoveredSourceReadable([{ source: 'NEVER_SET_UP', status: 'NOT_CONFIGURED' }]),
    false,
    'a tenant with nothing configured must not report restored visibility')
})
