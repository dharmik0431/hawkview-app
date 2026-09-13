/**
 * What the Priority Action Queue's count line and empty state may claim.
 *
 * THE SAME SHAPE AS THE BELL, ONE SURFACE FURTHER OUT. The queue rendered
 * `{sortedQueueItems.length} matching alerts`, and that number is built by
 * walking every tenant's attention list. A tenant whose attention could not be
 * read contributes zero items -- `dashboard/page.tsx` sets
 * `attention = attentionReported ? t.attention : []` -- so the count silently
 * treats "we could not read this tenant" as "this tenant has nothing".
 *
 * A count has only a number. Asked whether it is looking at a quiet fleet or an
 * unread one, it cannot answer, and it will read zero and say so confidently.
 * That is the test this module exists to pass.
 *
 * THE EMPTY STATE WAS THE WORSE HALF. It said "No matching alerts found. Try
 * adjusting filters or search query." Two claims: that HawkView looked, and
 * that the reader's filters are why nothing came back. When tenants could not
 * be read, both are wrong, and the second actively sends somebody to adjust
 * filters that have nothing to do with it.
 *
 * The page already keeps `attentionReported` per tenant and warns about partial
 * evidence in a banner. But that banner sits in an else-if chain behind
 * `isError`, `isFetching` and `isStale`, so a background refresh suppresses it
 * -- and it is at the top of the page while the claim is several screens down.
 * A warning that a sentence contradicts has to travel with the sentence.
 */

export type QueueCoverage = {
  /** Tenants in scope after filtering. */
  inScope: number
  /** Of those, how many reported an attention list at all. */
  read: number
}

export type QueueSummary = {
  /** The count line beside the heading. Always says what the number is over. */
  headline: string
  /**
   * Whether the number can be read as complete.
   *
   * False does not make it useless -- the alerts it found are real. It makes it
   * a floor rather than a total.
   */
  complete: boolean
  /** The empty-state sentence, or null when there are items to show. */
  empty: { title: string; detail: string } | null
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/**
 * @param matching how many queue items survived the filters
 * @param coverage how many tenants were in scope and how many could be read
 * @param filtersActive whether a filter or search is narrowing the list, which
 *   is the only circumstance in which "try adjusting filters" is sound advice
 */
export function queueSummary(
  matching: number,
  coverage: QueueCoverage,
  filtersActive: boolean
): QueueSummary {
  const unread = Math.max(0, coverage.inScope - coverage.read)
  const complete = unread === 0

  // THE COUNT NEVER TRAVELS ALONE WHEN IT IS INCOMPLETE. "12 matching alerts"
  // and "12 matching alerts across 10 of 14 tenants" are different claims, and
  // only the second is one this data supports.
  const headline = complete
    ? `${matching} matching ${plural(matching, 'alert', 'alerts')}`
    : `${matching} matching ${plural(matching, 'alert', 'alerts')} across ` +
      `${coverage.read} of ${coverage.inScope} ${plural(coverage.inScope, 'tenant', 'tenants')}`

  if (matching > 0) return { headline, complete, empty: null }

  // ZERO IS WHERE THE MEANINGS COLLAPSE, exactly as it was on the bell.
  if (!complete) {
    return {
      headline,
      complete,
      empty: {
        title: 'No matching alerts among the tenants HawkView could read',
        detail:
          `${unread} of ${coverage.inScope} ${plural(coverage.inScope, 'tenant', 'tenants')} ` +
          'did not report an attention list, so this is not a complete answer. ' +
          'It is not a statement that those tenants are quiet.',
      },
    }
  }

  // Only here -- everything read, nothing found -- may the emptiness be blamed
  // on the filters, and only when there are filters to blame.
  return {
    headline,
    complete,
    empty: filtersActive
      ? {
          title: 'No matching alerts found',
          detail:
            'Every tenant in scope reported its attention list, and none of the ' +
            'items matched. Try adjusting filters or search query.',
        }
      : {
          title: 'Nothing needs action',
          detail:
            'Every tenant in scope reported its attention list, and none raised ' +
            'anything. No filters are narrowing this.',
        },
  }
}
