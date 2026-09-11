// QA: PM's standing rule — no detector declares `monotonic: true` until the
// harness has run against it AND produced findings. This is that run for
// repeated-credential-failure, which the stale-evidence ruling is about to gate
// on. Until now that flag has never been checked for this detector.
//
// held: true is not the result. THREE things have to hold together:
//
//   1. findings were actually produced (findingsSeen > 0), or the run proves
//      only that nothing was asked — VACUOUS, the verdict
//      qa-run-harness-forwarding.ts already refuses to call a pass.
//   2. BOTH firing branches are exercised. This rule fires on
//      `lockouts > 0 OR rejections >= threshold`, and a pool that only ever
//      trips the first leaves the second unverified while the summary line
//      still says the detector holds.
//   3. the harness can FAIL on this detector's event type and these pools.
//      A quiet instrument and a correct detector produce identical output, so
//      the counterexample below is the only thing that separates them.
import { checkMonotonic } from '../evaluation-core/qa-monotonicity-harness.js'
import { credentialFailureDetector } from './detectors/credential-failure.js'
import { normalizeSignInBatch } from '../risky-users-normalization/index.js'
import type { NormalizedEvent } from '../risky-users-normalization/contract.js'
import type { Detector, DetectorResult } from '../evaluation-core/contract.js'

const scope = { organizationId: 'org', customerTenantId: 'tenant', microsoftTenantId: 'ms' }
const APP = '22222222-2222-4222-8222-222222222222'
const users = [
  { id: '11111111-1111-4111-8111-111111111111', upn: 'alice@contoso.com' },
  { id: '33333333-3333-4333-8333-333333333333', upn: 'bob@contoso.com' },
  { id: '55555555-5555-4555-8555-555555555555', upn: 'carol@contoso.com' },
]
const LOCKOUT_TEXT = 'The account is locked, you’ve tried to sign in too many times with an incorrect user ID or password.'
const LOCKOUT_TEXT_ASCII = "The account is locked, you've tried to sign in too many times with an incorrect user ID or password."
const REJECT_TEXT = 'Error validating credentials due to invalid username or password.'

// Spread over 40 days, including events OLDER than the ones a rule fires on. A
// pool of only recent events cannot generate the counterexample for anything
// history-sensitive, which would let a rule pass while still exposed.
const at = (day: number, n: number) => new Date(Date.UTC(2026, 7, 1 + day, 0, 0, n)).toISOString()

let seq = 0
const row = (user: typeof users[number], code: number, day: number) => {
  const id = seq++
  return {
    organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, ingestedAt: new Date(),
    raw: {
      id: `evt-${id}`, createdDateTime: at(day, id % 60), userId: user.id, userPrincipalName: user.upn,
      appId: APP, ipAddress: '203.0.113.9', isInteractive: true,
      status: {
        errorCode: code,
        failureReason: code === 50053 ? LOCKOUT_TEXT_ASCII : code === 50126 ? REJECT_TEXT : '',
      },
    },
  }
}

const normalize = async (rows: readonly ReturnType<typeof row>[]): Promise<readonly NormalizedEvent[]> => {
  const batch = await normalizeSignInBatch({
    scope, source: 'GRAPH_SIGN_INS', rows,
    directory: users.map(u => ({
      organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
      microsoftUserId: u.id, userPrincipalName: u.upn, userType: 'Member',
    })),
    // TWO ARGUMENTS. A one-argument resolver returns the same ref for every user
    // and collapses the whole pool onto one subject, which would make this
    // harness run measure a single-subject rule regardless of the input.
    reference: async (_kind: string, id: string) => `ref-${id}`,
    collectionScope: 'GRAPH_INTERACTIVE_ONLY',
  })
  return batch.applies
}

// Branch 1: lockouts, which fire at count >= 1.
const lockoutPool = await normalize(users.flatMap((u, ui) =>
  Array.from({ length: 6 }, (_, i) => row(u, 50053, ui * 3 + i))))

// Branch 2: rejections only, enough that a random ~42% subset still clears the
// threshold of 5 — otherwise this branch reports held with nothing seen.
const thresholdPool = await normalize(users.flatMap((u, ui) =>
  Array.from({ length: 20 }, (_, i) => row(u, 50126, ui * 5 + (i % 30)))))

// Mixed, plus successes and an excluded code, so the run also covers the case
// where the rule must ignore evidence without letting it suppress anything.
const mixedPool = await normalize([
  ...users.flatMap((u, ui) => Array.from({ length: 4 }, (_, i) => row(u, 50053, ui * 4 + i))),
  ...users.flatMap((u, ui) => Array.from({ length: 8 }, (_, i) => row(u, 50126, 20 + ui + i))),
  ...users.flatMap((u, ui) => Array.from({ length: 6 }, (_, i) => row(u, 0, 30 + ui + i))),
  ...users.map((u, ui) => row(u, 50140, 35 + ui)),
])

const credential = credentialFailureDetector({ rejectionThreshold: 5 }).detector

// THE COUNTEREXAMPLE. Same event type, same pool, same declaration — but
// absence-keyed: it fires on a lockout with NO later success, so adding events
// REMOVES the finding. If the harness cannot catch this, then `held: true` on
// the real detector means only that the harness is quiet.
const absenceKeyed: Detector<NormalizedEvent> = {
  id: 'absence-keyed-counterexample', monotonic: true,
  run: (applicable): DetectorResult => {
    // Read through the same accessor the real detector uses. Reaching for a
    // field that does not exist would make this counterexample fire on nothing
    // and quietly report the harness as unable to fail.
    const outcome = (e: NormalizedEvent) =>
      e.classification.kind === 'APPLIES' ? e.classification.outcome : null
    const succeeded = new Set(applicable.filter(e => outcome(e) === 'PASSWORD_ACCEPTED_COMPLETED').map(e => e.subjectRef))
    const locked = [...new Set(applicable
      .filter(e => outcome(e) === 'LOCKED_OUT_AFTER_REPEATED_FAILURES')
      .map(e => e.subjectRef))].filter(ref => !succeeded.has(ref))
    return {
      status: 'RAN', assessed: applicable.length, declined: {},
      findings: locked.map(ref => ({
        detectorId: 'absence-keyed-counterexample',
        subject: {
          kind: 'DIRECTORY_USER' as const, userRef: ref,
          correlation: { available: false as const, because: 'qa counterexample' },
        },
        signals: [{ signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES', count: 1, latest: null }] as const,
      })),
    }
  },
}

const run = (pool: readonly NormalizedEvent[]) => checkMonotonic(credential, pool, { trials: 500 })
const lockouts = run(lockoutPool)
const threshold = run(thresholdPool)
const mixed = run(mixedPool)
const counterexample = checkMonotonic(absenceKeyed, mixedPool, { trials: 500 })

const shape = (r: ReturnType<typeof run>) => r.held
  ? { held: true, trials: r.trials, findingsSeen: r.findingsSeen, declines: r.declines }
  : { held: false, kind: r.kind, seed: r.seed, trial: r.trial, lost: r.lost.slice(0, 3) }

const branches = [lockouts, threshold, mixed]
const allHeld = branches.every(r => r.held)
const everyBranchSawFindings = branches.every(r => r.held && r.findingsSeen > 0)
// The instrument is silent only because there is nothing to say.
const harnessCanFail = !counterexample.held && counterexample.kind === 'LOST_WHILE_RAN'

console.log(JSON.stringify({
  QA_HARNESS_CREDENTIAL_FAILURE: {
    declaredMonotonic: credential.monotonic,
    poolSizes: { lockoutOnly: lockoutPool.length, thresholdOnly: thresholdPool.length, mixed: mixedPool.length },
    lockoutBranch: shape(lockouts),
    thresholdBranch: shape(threshold),
    mixedWithSuccessesAndExclusions: shape(mixed),
    counterexample: counterexample.held
      ? { held: true, findingsSeen: counterexample.findingsSeen }
      : { held: false, kind: counterexample.kind, trial: counterexample.trial },
    harnessCanFailOnThisEventType: harnessCanFail,
    everyBranchSawFindings,
    verdict: !allHeld
      ? 'VIOLATION: monotonic: true is wrong for repeated-credential-failure'
      : !everyBranchSawFindings
        ? 'VACUOUS: held, but a firing branch produced no findings, so it proves nothing for that branch'
        : !harnessCanFail
          ? 'INCONCLUSIVE: the harness did not catch a known non-monotonic detector on these pools, so held proves only that it is quiet'
          : 'VERIFIED: monotonic: true is checked, not declared - both firing branches produced findings that survived, and the harness caught a known-bad detector on the same pool',
  },
}, null, 2))
