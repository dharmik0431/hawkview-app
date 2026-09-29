/** Counts and empty states for the reported tenant-findings queue.
 * Access setup and collection diagnostics belong to separate surfaces; an
 * empty queue cannot establish that no customer action or risk exists.
 */
export type QueueCoverage = {
  /** Tenants in scope after filtering. */
  inScope: number
  /** Of those, how many reported an attention list at all. */
  read: number
  /** Readable summaries whose evidence remains incomplete or unclassified. */
  incomplete?: number
}

export type QueueSummary = {
  /** The count line beside the heading. Always says what the number is over. */
  headline: string
  /**
   * Whether the number can be read as complete.
   *
   * False does not make it useless -- the findings it found are real. It makes it
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
  const partial = Math.max(0, coverage.incomplete ?? 0)
  if (partial > 0) return {
    headline: `${matching} reported ${plural(matching, 'finding', 'findings')} · Evidence incomplete`,
    complete: false,
    empty: matching > 0 ? null : {
      title: 'No classified findings match this view',
      detail: 'Evidence is incomplete or unclassified. This does not establish zero findings; review tenant evidence details.',
    },
  }
  const complete = unread === 0

  const headline = complete
    ? `${matching} matching ${plural(matching, 'finding', 'findings')}`
    : `${matching} matching ${plural(matching, 'finding', 'findings')} across ` +
      `${coverage.read} of ${coverage.inScope} ${plural(coverage.inScope, 'tenant', 'tenants')}`

  if (matching > 0) return { headline, complete, empty: null }

  if (!complete) {
    return {
      headline,
      complete,
      empty: {
        title: 'No matching tenant findings among the tenants HawkView could read',
        detail:
          `${unread} of ${coverage.inScope} ${plural(coverage.inScope, 'tenant', 'tenants')} ` +
          'did not report an attention list, so this is not a complete answer. ' +
          'It is not a statement that those tenants are quiet.',
      },
    }
  }

  // This describes the findings visible in this view, never all customer actions.
  return {
    headline,
    complete,
    empty: filtersActive
      ? {
          title: 'No tenant findings match these filters',
          detail:
            'No reported tenant findings match the current filters. Try adjusting filters or search query. ' +
            'Customer access setup is shown separately; this is not an exhaustive security assessment.',
        }
      : {
          title: 'No tenant findings reported in this view',
          detail:
            'This queue lists reported tenant findings only. Customer access setup is shown separately; ' +
            'this is not an exhaustive security assessment.',
        },
  }
}
