import type { EventOutcome, NormalizedEvent } from '../../risky-users-normalization/contract.js'
import type { CorrelationRef, DetectorFinding } from '../../evaluation-core/contract.js'
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
        type Tally = Readonly<Record<EventOutcome, { count: number; latest: string | null }>> & { latestEvent: NormalizedEvent }
        const blank = (event: NormalizedEvent): Tally => ({
          LOCKED_OUT_AFTER_REPEATED_FAILURES: { count: 0, latest: null },
          PASSWORD_REJECTED: { count: 0, latest: null },
          latestEvent: event,
        } as Tally)
        const bySubject = new Map<string, Tally>()
        let assessed = 0
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
          assessed += 1
          const running = bySubject.get(event.subjectRef) ?? blank(event)
          bySubject.set(event.subjectRef, {
            ...running,
            // Events arrive sorted ascending, so the last one seen of a GIVEN
            // outcome is that outcome's most recent — tracked per signal rather
            // than once for the family. One shared timestamp is what let 467
            // lockouts render beside a later rejection's date, overstating the
            // lockouts' recency by six days on a real tenant.
            [outcome]: { count: running[outcome].count + 1, latest: event.eventAt },
            latestEvent: event,
          } as Tally)
        }

        const findings: DetectorFinding[] = []
        for (const [subjectRef, tally] of bySubject) {
          const lockouts = tally.LOCKED_OUT_AFTER_REPEATED_FAILURES
          const rejections = tally.PASSWORD_REJECTED
          if (lockouts.count === 0 && rejections.count < options.rejectionThreshold) continue
          findings.push({
            detectorId: 'repeated-credential-failure',
            subject: {
              kind: 'DIRECTORY_USER',
              userRef: subjectRef,
              correlation: correlationFor(tally.latestEvent),
            },
            // BOTH signals, always, including one this subject never produced.
            // This rule reads both, so both were evaluated, and `count: 0` with
            // `latest: null` says "we looked and found none". Omitting the empty
            // one would make it indistinguishable from a signal never
            // evaluated — the same collapse as an uncollected window reading as
            // a quiet tenant, one level down.
            signals: [
              { signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES', count: lockouts.count, latest: lockouts.latest },
              { signal: 'PASSWORD_REJECTED', count: rejections.count, latest: rejections.latest },
            ],
          })
        }

        return {
          status: 'RAN',
          assessed,
          declined: (otherOutcome > 0 ? { NOT_A_CREDENTIAL_FAILURE_OUTCOME: otherOutcome } : {}) as Readonly<Record<string, number>>,
          findings,
        }
      },
    },
  }
}
