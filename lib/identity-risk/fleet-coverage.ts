/**
 * How much of the fleet the Risky Users screen actually looked at.
 *
 * THE COUNT AND THE COVERAGE ARE ONE FACT WITH TWO RENDERINGS. The page showed
 * `{filteredRows.length} users` in a badge and "N tenants unavailable" in a KPI
 * tile several inches away, and neither knew about the other. Worse, the tile
 * undercounted: `failedTenants` counts only `assessmentError`, while the status
 * has four values, so a tenant that came back UNAVAILABLE was counted as fine.
 *
 * THE ICON IS THE STRONGEST CLAIM ON THE SCREEN. A green ShieldCheck is read
 * before the prose, believed faster, and cannot be qualified by a clause. The
 * tone is derived here so the markup cannot hardcode reassurance, and exactly
 * one tone earns the shield.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY FLEET SIZE IS ITS OWN UNION, AND WHY COULD_NOT_LOOK IS TESTED FIRST
 *
 * The first version of this module computed `missing = inScope - assessed` and
 * `complete = missing === 0`. QA rendered the real page against a fleet of zero
 * and it produced "No users require review", two green ShieldChecks, and the
 * sentence "All 0 tenants in scope were assessed" -- identical to a genuinely
 * clean four-tenant fleet except for the digit inside the sentence doing the
 * reassuring.
 *
 * The cause is a VACUOUS TRUTH: "everything in scope was assessed" holds when
 * there is nothing in scope. Completeness over an empty set is true and means
 * nothing, and it was the one condition standing between an unknown fleet and
 * the shield.
 *
 * And the path there is the worst available one. `fleet-risky-users-hooks.ts`
 * does `safeTenants = tenantsResponse?.tenants ?? []`, so a FAILED TENANT-LIST
 * REQUEST produces an empty array. The statuses then loop over nothing,
 * coverage is `inScope: 0`, and the page never consulted the hook's `isError`
 * at all. The state where HawkView could not find out what the fleet even is
 * rendered as a green shield saying nothing needs review.
 *
 * So size is KNOWN or UNKNOWN rather than a number, because zero is a
 * measurement and unknown is not, and as plain integers they are the same
 * value. COULD_NOT_LOOK is answered BEFORE completeness is tested, because a
 * completeness test over an unknown denominator is the vacuous truth again.
 * That ORDER is the fix; a type alone would not have caught it.
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
  /** Nothing found, and some tenants were never looked at. */
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

/** WHICH ones, capped so a large fleet does not put forty names in a sentence. */
function named(missed: readonly string[]): string {
  if (missed.length === 0) return ''
  const shown = missed.slice(0, 3)
  const rest = missed.length - shown.length
  const list = shown.join(', ')
  return rest > 0 ? `${list}, and ${rest} more` : list
}

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
      headline: `${matching} ${plural(matching, 'user', 'users')} — fleet size unknown`,
      complete: false,
      empty: {
        tone: 'COULD_NOT_LOOK',
        title: 'HawkView could not determine which tenants to assess',
        detail:
          coverage.fleet.because +
          ' Nothing here is a statement about your tenants, and no tenant has been ' +
          'assessed or cleared.',
      },
    }
  }

  const missing = Math.max(0, coverage.inScope - coverage.assessed)
  const complete = missing === 0 && coverage.inScope > 0

  const headline =
    coverage.inScope === 0
      ? `${matching} ${plural(matching, 'user', 'users')}`
      : complete
        ? `${matching} ${plural(matching, 'user', 'users')}`
        : `${matching} ${plural(matching, 'user', 'users')} across ` +
          `${coverage.assessed} of ${coverage.inScope} ${plural(coverage.inScope, 'tenant', 'tenants')}`

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
        title: 'No users to review among the tenants HawkView assessed',
        detail:
          `${missing} of ${coverage.inScope} ${plural(coverage.inScope, 'tenant was', 'tenants were')} ` +
          `not assessed (${shortfall(coverage)}): ${named(coverage.missed)}. ` +
          'This is not a statement that those tenants have no risky users.',
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
