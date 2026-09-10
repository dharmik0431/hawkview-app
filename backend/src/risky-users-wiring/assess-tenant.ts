import { composeTenantAssessment, type StreamAssessment, type TenantAssessment } from '../evaluation-core/compose.js'
import { evaluate } from '../evaluation-core/evaluate.js'
import { assertAccountsForEveryRow, toEvaluationCoverage, type CollectionScopeSource } from './coverage-bridge.js'
import type { NormalizationBatch, NormalizedEvent } from '../risky-users-normalization/contract.js'
import type { Budget, Detector } from '../evaluation-core/contract.js'

/** Turning what the classifier produced into what the tenant can be told.
 *
 * Still pure: no database, no clock, no HTTP. The controller reads rows and
 * persists the result; this decides what the result is. Keeping the decision
 * testable without a database is the only reason any of today's reasoning could
 * be exercised at all.
 */

/** One evidence stream, already classified.
 *
 * A tenant has exactly ONE authentication stream — Graph or audit, never both,
 * because the collector selects one per tenant and the other is empty by
 * construction. Composing both would gate a tenant's clean zero on a feed it
 * does not use. The stream is named by its source so a withheld claim can say
 * which feed withheld it. */
export type ClassifiedStream =
  /** Collection succeeded, so there is a batch to assess — including a batch
   * that is legitimately empty, which is how a genuinely quiet tenant reaches a
   * confident zero. */
  | Readonly<{
    stream: string
    collection: 'READ'
    batch: NormalizationBatch
    scope: CollectionScopeSource
    detectors: readonly Detector<NormalizedEvent>[]
  }>
  /** Collection did not deliver evidence for this window. A union rather than a
   * flag, because the alternative is a caller passing an empty batch and the
   * assessment reporting "collected and clean" for a window nobody collected —
   * which is this feature's original defect, and it is what a caller does by
   * default when nothing forces the choice.
   *
   * `evidenceFromSync` derives which case applies from the collector's own sync
   * state, so this is a decision the caller records rather than makes. */
  | Readonly<{
    stream: string
    collection: 'NEVER_COLLECTED' | 'UNREADABLE_NOW'
  }>

export type AssessTenantInput = Readonly<{
  streams: readonly ClassifiedStream[]
  budget: Budget
}>

/** The classifier sorts by `eventAt` ascending and asks us not to re-sort, so
 * the core reads recency through this rather than assuming an order. It is the
 * caller's projection of time, which is all the core ever wanted. */
const eventTime = (event: NormalizedEvent): string => event.eventAt

export function assessTenant(input: AssessTenantInput): TenantAssessment {
  const streams: StreamAssessment[] = input.streams.map(stream => {
    if (stream.collection !== 'READ') return unreadStream(stream.stream, stream.collection)
    const coverage = toEvaluationCoverage(stream.batch, stream.scope)
    // Fails loudly rather than quietly under-reporting. A bucket the classifier
    // added and the bridge does not map would otherwise leave coverage looking
    // complete while describing fewer events than were classified — and this is
    // the last place that can still be noticed before it becomes a number on a
    // screen.
    assertAccountsForEveryRow(stream.batch, coverage)
    return {
      stream: stream.stream,
      assessment: evaluate<NormalizedEvent>({
        evidence: {
          availability: 'READ',
          applies: stream.batch.applies,
          coverage,
          timeOf: eventTime,
        },
        detectors: stream.detectors,
        budget: input.budget,
      }),
    }
  })

  return composeTenantAssessment(streams)
}

/** A tenant whose evidence was never collected, or could not be read now.
 *
 * Separate from `assessTenant` because there is no batch to hand it: unread
 * evidence has no events and no coverage, and the contract admits no shape that
 * carries them. Building this as an option on the main path would have meant a
 * batch-shaped hole for callers to fill with something empty, which is how
 * "never collected" and "collected and empty" become the same value. */
export function unreadStream(stream: string, availability: 'NEVER_COLLECTED' | 'UNREADABLE_NOW'): StreamAssessment {
  return {
    stream,
    assessment: evaluate<NormalizedEvent>({
      evidence: { availability },
      detectors: [],
      budget: { maxEvents: 0 },
    }),
  }
}
