import { rowSource } from '../risky-users-normalization/index.js'
import type { NormalizationSource } from '../risky-users-normalization/contract.js'

/** Which feed produced this tenant's rows — read off the rows, not asserted.
 *
 * THE DEFECT THIS EXISTS FOR. The reader used to take `source` as an input while
 * the classifier decided per row from `hawkviewSource`. Two layers holding the
 * same fact, and nothing forcing them to agree, so on three real tenants the
 * caller said Graph, the rows were audit, and all 2,246 of them came back
 * unselected. Coverage described nothing, every guard passed, and the tenant was
 * reported as NOTHING_APPLICABLE — a confident silence over evidence we had
 * already collected and simply not looked at.
 *
 * The rule that generalises out of it: an asserted input either has to be
 * derived or has to announce itself. In the same file `--sync` is asserted and
 * the dump PRINTS what it assumed, so no run can be quoted without its
 * assumption travelling alongside; `source` was asserted and silent. Same
 * mechanism, opposite outcome.
 *
 * Reuses the classifier's own `rowSource` rather than re-reading `hawkviewSource`
 * here. A second copy of a closed vocabulary is a second thing to keep in step,
 * and keeping them in step is the exact thing that just failed.
 */

export type FeedDecision =
  | Readonly<{
    feed: NormalizationSource
    /** Read off the rows. The only trustworthy answer. */
    from: 'ROWS'
    /** Rows carrying a source name this build does not know. Not an error here:
     * they are passed to the classifier like any other row and land in
     * `SOURCE_UNRECOGNIZED`, where they are counted rather than assumed away. */
    rowsWithUnrecognizedSource: number
  }>
  | Readonly<{
    feed: NormalizationSource
    /** No row could decide it, because there were none to ask. Named rather than
     * silently defaulted: a quiet tenant still needs a feed to bind detectors
     * to, and which one was assumed changes whether a check reports INAPPLICABLE
     * — so the assumption travels with the answer. */
    from: 'NO_ROWS_TO_DERIVE_FROM'
    rowsWithUnrecognizedSource: number
  }>

export function decideFeed(
  raws: readonly Record<string, unknown>[],
  feedIfNoRows: NormalizationSource,
): FeedDecision {
  const feeds = new Set<NormalizationSource>()
  let rowsWithUnrecognizedSource = 0
  for (const raw of raws) {
    const feed = rowSource(raw)
    if (feed === null) rowsWithUnrecognizedSource += 1
    else feeds.add(feed)
  }

  // A documented invariant, and worth failing on rather than picking a winner.
  // `ClassifiedStream` states that a tenant has exactly one authentication
  // stream because the collector selects one per tenant. If that stops being
  // true, choosing either feed here silently discards the other one's rows —
  // the same disappearance this function exists to end, arriving through its
  // own fix. Refusing says so instead.
  if (feeds.size > 1) {
    throw new Error(
      `This tenant's rows come from more than one feed (${[...feeds].sort().join(', ')}). `
      + 'Assessing one would silently discard the other, and the collector is supposed to '
      + 'select a single feed per tenant, so this is a collection fault rather than a '
      + 'question about which to prefer.')
  }

  const [only] = feeds
  return only === undefined
    ? { feed: feedIfNoRows, from: 'NO_ROWS_TO_DERIVE_FROM', rowsWithUnrecognizedSource }
    : { feed: only, from: 'ROWS', rowsWithUnrecognizedSource }
}
