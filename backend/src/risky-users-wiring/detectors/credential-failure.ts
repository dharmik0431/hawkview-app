import type { EventOutcome, NormalizedEvent } from '../../risky-users-normalization/contract.js'
import type { CorrelationRef, Finding } from '../../evaluation-core/contract.js'
import type { FeedBoundDetector } from '../feed-capability.js'

/** Somebody is trying passwords against this account.
 *
 * The first detector bound to real evidence, and deliberately the simplest
 * defensible one rather than the cleverest available.
 *
 * TWO SIGNALS, and the first is the strong one:
 *
 * A LOCKOUT is Microsoft telling us smart lockout fired, which it does only
 * after repeated failures — and Microsoft documents that it ignores repeats of
 * the SAME wrong password specifically so a stale-credential client does not
 * trigger it. So a lockout implies VARIED attempts, which is the difference
 * between a phone with an old password saved and somebody guessing. One is
 * enough to report.
 *
 * REJECTIONS in volume are attack evidence in aggregate and nothing on their
 * own: a person mistyping twice is not a finding. The threshold is a product
 * judgement rather than a measurement, so it is a parameter and the finding
 * says which value produced it.
 *
 * Presence-keyed and therefore monotonic: more events can only add findings,
 * never remove one. That is what lets it run on a truncated window — and it is
 * the reason this rule was chosen first over the interrupt family, which is
 * absence-keyed and cannot.
 */

const FAMILY: readonly EventOutcome[] = ['LOCKED_OUT_AFTER_REPEATED_FAILURES', 'PASSWORD_REJECTED']

const outcomeOf = (event: NormalizedEvent): EventOutcome | null =>
  event.classification.kind === 'APPLIES' ? event.classification.outcome : null

/** The classifier says how it bound the subject; the finding carries that
 * through so the read path can join Microsoft's channel on the right key.
 * Inventing a shape here would produce a join that silently matches nothing. */
const correlationFor = (event: NormalizedEvent): CorrelationRef =>
  event.subjectBinding === 'DIRECTORY_OBJECT_ID'
    ? { available: true, shape: 'DIRECTORY_OBJECT_ID', ref: event.subjectRef }
    : { available: true, shape: 'USER_PRINCIPAL_NAME', ref: event.subjectRef }

export function credentialFailureDetector(
  options: Readonly<{ rejectionThreshold: number }> = { rejectionThreshold: 5 },
): FeedBoundDetector {
  return {
    requires: FAMILY,
    detector: {
      id: 'repeated-credential-failure',
      monotonic: true,
      run: applicable => {
        const bySubject = new Map<string, { lockouts: number; rejections: number; latest: NormalizedEvent }>()
        let considered = 0
        let otherOutcome = 0

        for (const event of applicable) {
          const outcome = outcomeOf(event)
          if (outcome === null || !FAMILY.includes(outcome)) {
            // Accounted for rather than merely skipped. A detector that
            // narrows its own input and says nothing is the defect the sum
            // invariant exists to catch, and this is where it would start.
            otherOutcome += 1
            continue
          }
          considered += 1
          const running = bySubject.get(event.subjectRef)
            ?? { lockouts: 0, rejections: 0, latest: event }
          bySubject.set(event.subjectRef, {
            lockouts: running.lockouts + (outcome === 'LOCKED_OUT_AFTER_REPEATED_FAILURES' ? 1 : 0),
            rejections: running.rejections + (outcome === 'PASSWORD_REJECTED' ? 1 : 0),
            // Events arrive sorted ascending, so the last one seen is the most
            // recent — what a technician wants beside the finding.
            latest: event,
          })
        }

        const findings: Finding[] = []
        for (const [subjectRef, tally] of bySubject) {
          if (tally.lockouts === 0 && tally.rejections < options.rejectionThreshold) continue
          findings.push({
            detectorId: 'repeated-credential-failure',
            subject: {
              kind: 'DIRECTORY_USER',
              userRef: subjectRef,
              correlation: correlationFor(tally.latest),
            },
            observedAt: tally.latest.eventAt,
          })
        }

        return {
          status: 'RAN',
          considered,
          declined: (otherOutcome > 0 ? { NOT_A_CREDENTIAL_FAILURE_OUTCOME: otherOutcome } : {}) as Readonly<Record<string, number>>,
          findings,
        }
      },
    },
  }
}
