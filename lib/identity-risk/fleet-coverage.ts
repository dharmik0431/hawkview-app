/**
 * Coverage still gates absence claims, even though the list count is a neutral
 * observation. Availability reasons belong to the source-specific disclosure;
 * an optional source limitation does not establish a fleet sync failure.
 * Unknown tenant enumeration and a known empty fleet must never earn QUIET.
 */
export type TenantAssessmentStatus =
  | 'LOADING'
  | 'FAILED'
  | 'UNAVAILABLE'
  | 'SUCCESS'

export type TenantStatusEntry = {
  tenantId: string
  tenantName?: string
  status: TenantAssessmentStatus
}

/**
 * Whether HawkView knows what the fleet is.
 *
 * UNKNOWN is not "zero tenants". It is "the request that would have told us did
 * not succeed", and it must never be given a denominator.
 */
export type FleetSize =
  | { kind: 'KNOWN' }
  | { kind: 'UNKNOWN'; because: string }

export type AssessmentCoverage = {
  /** Whether the fleet could be enumerated at all. */
  fleet: FleetSize
  /** Tenants the current view covers, after the tenant filter. */
  inScope: number
  /** Of those, how many produced an assessment. */
  assessed: number
  loading: number
  failed: number
  unavailable: number
  /**
   * WHICH tenants were missed, not merely how many.
   *
   * Somebody told three were missed cannot act on that without going to find
   * which three, and the filter beside the list shows all of them unmarked.
   */
  missed: string[]
}

/**
 * @param statuses one entry per tenant, as the fleet hook already computes
 * @param selectedTenantId the tenant filter, or 'ALL'
 * @param fleet whether the tenant list itself could be read
 *
 * Scoped by the filter, because coverage has to describe THIS view. With one
 * tenant selected, "3 of 4 tenants could not be assessed" is about a fleet the
 * reader is not looking at.
 */
export function fleetCoverage(
  statuses: readonly TenantStatusEntry[],
  selectedTenantId: string,
  fleet: FleetSize = { kind: 'KNOWN' }
): AssessmentCoverage {
  const inScope =
    selectedTenantId === 'ALL'
      ? statuses
      : statuses.filter((each) => each.tenantId === selectedTenantId)

  const missed = inScope
    .filter((each) => each.status !== 'SUCCESS')
    .map((each) => each.tenantName ?? each.tenantId)

  return {
    fleet,
    inScope: inScope.length,
    assessed: inScope.filter((each) => each.status === 'SUCCESS').length,
    loading: inScope.filter((each) => each.status === 'LOADING').length,
    failed: inScope.filter((each) => each.status === 'FAILED').length,
    unavailable: inScope.filter((each) => each.status === 'UNAVAILABLE').length,
    missed,
  }
}

export type EmptyTone =
  /** Nothing found, and every tenant in a fleet we could enumerate was looked
   * at. The ONLY tone that may reassure. */
  | 'QUIET'
  /** Nothing matched the filters, over a fleet that was fully assessed. */
  | 'FILTERED'
  /** Nothing found, and some tenants lack complete combined evidence. */
  | 'UNKNOWN'
  /** The fleet itself could not be enumerated. Not a statement about tenants. */
  | 'COULD_NOT_LOOK'
  /** The fleet is known and empty. True, and not a security result. */
  | 'NO_FLEET'

export type RiskyUsersSummary = {
  headline: string
  complete: boolean
  empty: { tone: EmptyTone; title: string; detail: string } | null
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export function riskyUsersSummary(
  matching: number,
  coverage: AssessmentCoverage,
  filtersActive: boolean
): RiskyUsersSummary {
  // FIRST, BEFORE ANY COMPLETENESS TEST. An unknown fleet has no denominator, so
  // every ratio below it is vacuously satisfied -- which is exactly how a failed
  // tenant-list request earned a green shield.
  if (coverage.fleet.kind === 'UNKNOWN') {
    return {
      headline: `${matching} ${plural(matching, 'user', 'users')} shown — fleet size unknown`,
      complete: false,
      empty: {
        tone: 'COULD_NOT_LOOK',
        title: 'HawkView could not determine which tenants to assess',
        detail:
          coverage.fleet.because +
          ' Nothing here is a statement about your tenants, and no tenant has been ' +
          'confirmed to have complete current evidence from both sources.',
      },
    }
  }

  const missing = Math.max(0, coverage.inScope - coverage.assessed)
  const complete = missing === 0 && coverage.inScope > 0

  const headline = `${matching} ${plural(matching, 'user', 'users')} shown`

  if (matching > 0) return { headline, complete, empty: null }

  // A KNOWN FLEET OF ZERO IS TRUE AND IS NOT A SECURITY RESULT. "No users
  // require review" over nothing onboarded reassures about a question nobody
  // asked, and it is the same screen an unknown fleet used to produce.
  if (coverage.inScope === 0) {
    return {
      headline,
      // THE COMPUTED VALUE, NOT A HARDCODED false. Returning false here made
      // the `&& coverage.inScope > 0` guard above unobservable -- a mutation
      // restoring the exact vacuous completeness QA found killed no test,
      // because this path never read it. Two spellings of one answer, and the
      // wrong one was the only one anybody could see.
      complete,
      empty: {
        tone: 'NO_FLEET',
        title: 'No tenants are in scope',
        detail: filtersActive
          ? 'No tenant matches the current filter, so nothing has been assessed for this view.'
          : 'No Microsoft 365 tenants are connected to this organisation yet. There is nothing to assess, which is not the same as nothing being wrong.',
      },
    }
  }

  if (!complete) {
    return {
      headline,
      complete,
      empty: {
        tone: 'UNKNOWN',
        title: 'No matching users shown',
        detail:
          'Available evidence does not establish that there are no risky users. ' +
          'Open evidence availability beside the page title for source-specific details.',
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
            'confirmed to have complete evidence from both sources. Try adjusting your search terms, tenant selection, or detection source criteria.',
        }
      : {
          tone: 'QUIET',
          title: 'No users require review',
          detail:
            `All ${coverage.inScope} ${plural(coverage.inScope, 'tenant', 'tenants')} in scope were ` +
            'confirmed to have complete evidence from both sources, and no rule finding or Microsoft detection matched anyone in the assessed evidence. No filters are narrowing this.',
        },
  }
}
