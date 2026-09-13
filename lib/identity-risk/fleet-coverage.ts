/**
 * How much of the fleet the Risky Users screen actually looked at.
 *
 * THE COUNT AND THE COVERAGE ARE ONE FACT WITH TWO RENDERINGS. The page shows
 * `{filteredRows.length} users` in a badge and "N tenants unavailable" in a KPI
 * tile several inches away, and neither knows about the other. A reader asking
 * "is my fleet clean" reads the badge; nothing in it says the number is over a
 * subset.
 *
 * AND THE TILE UNDERCOUNTS, so it does not cover for the badge even at a
 * distance. `fleet-risky-users-hooks.ts` increments `failedTenants` only under
 * `if (assessmentError)`, but the status it derives has four values: LOADING,
 * FAILED, UNAVAILABLE and SUCCESS. A tenant whose assessment came back null is
 * UNAVAILABLE -- it contributed no rows and it is not an error -- so the tile
 * renders "100% tenants synced" over a fleet with tenants nobody assessed.
 * Coverage here is derived from the statuses, which distinguish all four.
 *
 * THE ICON IS THE STRONGEST CLAIM ON THE SCREEN. The empty state pairs "No
 * matching users found" with a green ShieldCheck, and an icon is read before
 * prose, believed faster, and cannot be qualified by a clause. A green shield
 * over a fleet where three of four tenants could not be assessed is the product
 * saying "you are fine" about tenants it never looked at. So the tone is
 * DERIVED here rather than hardcoded in the markup, and exactly one value earns
 * the shield.
 */

export type TenantAssessmentStatus =
  | 'LOADING'
  | 'FAILED'
  | 'UNAVAILABLE'
  | 'SUCCESS'

export type AssessmentCoverage = {
  /** Tenants the current view covers, after the tenant filter. */
  inScope: number
  /** Of those, how many produced an assessment. */
  assessed: number
  /** Still in flight. Not a failure, and not an answer either. */
  loading: number
  /** The request errored. */
  failed: number
  /** Answered, with no assessment in it. */
  unavailable: number
}

/**
 * @param statuses one entry per tenant, as the fleet hook already computes
 * @param selectedTenantId the tenant filter, or 'ALL'
 *
 * Scoped by the filter, because coverage has to describe THIS view. With one
 * tenant selected, "3 of 4 tenants could not be assessed" is about a fleet the
 * reader is not looking at, and a reader who selected a healthy tenant would be
 * warned about somebody else's problem.
 */
export function fleetCoverage(
  statuses: readonly { tenantId: string; status: TenantAssessmentStatus }[],
  selectedTenantId: string
): AssessmentCoverage {
  const inScope =
    selectedTenantId === 'ALL'
      ? statuses
      : statuses.filter((each) => each.tenantId === selectedTenantId)

  return {
    inScope: inScope.length,
    assessed: inScope.filter((each) => each.status === 'SUCCESS').length,
    loading: inScope.filter((each) => each.status === 'LOADING').length,
    failed: inScope.filter((each) => each.status === 'FAILED').length,
    unavailable: inScope.filter((each) => each.status === 'UNAVAILABLE').length,
  }
}

export type EmptyTone =
  /** Nothing found, everything looked at. The only tone that may reassure. */
  | 'QUIET'
  /** Nothing found, and some of the fleet was never looked at. */
  | 'UNKNOWN'
  /** Nothing matched the filters, over a fleet that was fully assessed. */
  | 'FILTERED'

export type RiskyUsersSummary = {
  /** The badge beside "Users requiring review". */
  headline: string
  /** Whether the number is over the whole scope. */
  complete: boolean
  /** The empty state, or null when there are rows. */
  empty: { tone: EmptyTone; title: string; detail: string } | null
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** The tenants that did not answer, phrased by why -- the remedies differ, and
 * "still loading" is not a problem at all. */
function shortfall(coverage: AssessmentCoverage): string {
  const parts: string[] = []
  if (coverage.failed > 0) parts.push(`${coverage.failed} could not be reached`)
  if (coverage.unavailable > 0) {
    parts.push(`${coverage.unavailable} returned no assessment`)
  }
  if (coverage.loading > 0) parts.push(`${coverage.loading} still loading`)
  return parts.join(', ')
}

export function riskyUsersSummary(
  matching: number,
  coverage: AssessmentCoverage,
  filtersActive: boolean
): RiskyUsersSummary {
  const missing = Math.max(0, coverage.inScope - coverage.assessed)
  const complete = missing === 0

  const headline = complete
    ? `${matching} ${plural(matching, 'user', 'users')}`
    : `${matching} ${plural(matching, 'user', 'users')} across ` +
      `${coverage.assessed} of ${coverage.inScope} ${plural(coverage.inScope, 'tenant', 'tenants')}`

  if (matching > 0) return { headline, complete, empty: null }

  if (!complete) {
    return {
      headline,
      complete,
      empty: {
        // NOT QUIET. This is the case the green shield was drawn over.
        tone: 'UNKNOWN',
        title: 'No users to review among the tenants HawkView assessed',
        detail:
          `${missing} of ${coverage.inScope} ${plural(coverage.inScope, 'tenant was', 'tenants were')} ` +
          `not assessed (${shortfall(coverage)}). This is not a statement that ` +
          'those tenants have no risky users.',
      },
    }
  }

  return {
    headline,
    complete,
    empty: filtersActive
      ? {
          tone: 'FILTERED',
          title: 'No users match the selected filters',
          detail:
            `All ${coverage.inScope} ${plural(coverage.inScope, 'tenant', 'tenants')} in scope were ` +
            'assessed. Try adjusting your search terms, tenant selection, or detection source criteria.',
        }
      : {
          tone: 'QUIET',
          title: 'No users require review',
          detail:
            `All ${coverage.inScope} ${plural(coverage.inScope, 'tenant', 'tenants')} in scope were ` +
            'assessed, and no rule finding or Microsoft detection matched anyone. No filters are narrowing this.',
        },
  }
}
