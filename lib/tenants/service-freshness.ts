/**
 * How old a section's data is, and whether the section may be read as evidence.
 *
 * Twelve of fourteen tenant sections render whatever they hold with no
 * indication of its age, so a screen built on a collector that stopped
 * seventeen days ago looks exactly like a screen built on live data. That is
 * the same defect as a count over stale rows, one layer down: a true-looking
 * answer resting on evidence that stopped arriving.
 *
 * One module rather than a label assembled in each section. The sentence
 * "this list is empty because nobody is in it" and the sentence "this list is
 * empty because we could not look" differ by one fact and read identically if
 * either is composed by hand eleven times.
 *
 * Semantics follow signins-section.tsx, which already did this correctly, so
 * that this is one implementation of an existing behaviour and not a second
 * opinion about it.
 */
import type { ServiceSyncFreshness, TenantBundle } from '@/types/tenant-data'

/**
 * The services a section can ask about.
 *
 * Fewer than the collectors that exist. A collector with no owning service in
 * the backend registry contributes to none of these and cannot be surfaced
 * here at all -- Secure Scores and the Exchange mailbox configuration collector
 * are both in that position today, which is a gap in the registry rather than
 * something a section can paper over.
 */
export type ServiceFreshnessKey =
  | 'office365'
  | 'entraId'
  | 'exchange'
  | 'sharePointOneDrive'
  | 'signInLogs'
  | 'auditLogs'

type FreshnessSource = {
  syncFreshness?: TenantBundle['syncFreshness']
  tenant?: { syncFreshness?: TenantBundle['syncFreshness'] } | null
} | null

/**
 * The freshness for one service, from wherever the bundle happens to carry it.
 *
 * Two locations because the payload has carried it in both; taking either is
 * how exchange-section.tsx already reads it. Null means this response said
 * nothing about the service, which is its own state and not a synonym for
 * current.
 */
export function serviceFreshness(
  source: FreshnessSource,
  key: ServiceFreshnessKey
): ServiceSyncFreshness | null {
  return (
    source?.syncFreshness?.services?.[key] ??
    source?.tenant?.syncFreshness?.services?.[key] ??
    null
  )
}

export type FreshnessTone = 'ok' | 'attention' | 'unknown'

export type FreshnessPresentation = {
  label: string
  tone: FreshnessTone
  /**
   * Why the label says what it says. Never empty, because a label with no
   * explanation makes the reader do the arithmetic and they will not.
   */
  detail: string
  /**
   * Whether this section's contents may be read as a picture of the tenant.
   *
   * False whenever collection is failed, stale, never run, or unreported. A
   * section showing rows it cannot vouch for is the defect; a section saying so
   * is the product.
   */
  trustworthy: boolean
}

function formatWhen(value: string | null): string | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : null
}

/**
 * The label, its tone, and whether the data below it can be relied on.
 *
 * Never a bare date. A timestamp with no judgement attached asks the reader to
 * work out whether seventeen days is a problem, and the whole reason this
 * exists is that nobody does that while scanning a screen.
 */
export function freshnessPresentation(
  freshness: ServiceSyncFreshness | null
): FreshnessPresentation {
  if (!freshness) {
    return {
      label: 'Freshness unknown',
      tone: 'unknown',
      detail:
        'This response did not say when the data below was last collected, so its age cannot be established. Read it as undated rather than current.',
      trustworthy: false,
    }
  }

  if (freshness.status === 'RUNNING') {
    return {
      label: 'Syncing',
      tone: 'unknown',
      detail:
        'A collection is running now. What is shown below is from before it started.',
      trustworthy: false,
    }
  }

  if (
    freshness.status === 'NOT_COLLECTED' ||
    freshness.freshnessStatus === 'NEVER_SYNCED'
  ) {
    return {
      label: 'Never collected',
      tone: 'attention',
      detail:
        'HawkView has never successfully collected this data for this tenant. Nothing below is a picture of the tenant, and this is not the same as the tenant having nothing.',
      trustworthy: false,
    }
  }

  if (freshness.status === 'FAILED') {
    const last = formatWhen(freshness.lastSuccessfulCollectionAt)
    return {
      label: 'Collection failing',
      tone: 'attention',
      detail: last
        ? `The most recent collection attempt failed. What is shown below is from ${last} and has not been refreshed since.`
        : 'The most recent collection attempt failed and there is no earlier success to fall back on.',
      trustworthy: false,
    }
  }

  if (freshness.status === 'STALE' || freshness.freshnessStatus === 'STALE') {
    const last = formatWhen(freshness.lastSuccessfulCollectionAt)
    return {
      label: 'Stale',
      tone: 'attention',
      detail: last
        ? `Last successful collection ${last}. What is shown below is older than this data is expected to be.`
        : 'This data is older than it is expected to be, and no successful collection time was reported.',
      trustworthy: false,
    }
  }

  if (freshness.status === 'PARTIAL') {
    const count = freshness.partialFailures.length
    return {
      label: `Partial — ${count} ${count === 1 ? 'collector needs' : 'collectors need'} attention`,
      tone: 'attention',
      // Deliberately not "some data is missing". Which part is missing is not
      // known here, so a reader must not conclude the rest is complete.
      detail:
        'Some collectors behind this section did not complete, so what is shown may be missing rows rather than reflecting a smaller tenant.',
      trustworthy: false,
    }
  }

  if (freshness.status === 'PENDING') {
    return {
      label: 'Collection pending',
      tone: 'unknown',
      detail:
        'A collection has been scheduled and has not run yet. Nothing below reflects it.',
      trustworthy: false,
    }
  }

  const last = formatWhen(freshness.lastSuccessfulCollectionAt)
  if (!last) {
    // SUCCESS with no timestamp. The status is reassuring and unverifiable, so
    // it is not repeated as though it were.
    return {
      label: 'Freshness unknown',
      tone: 'unknown',
      detail:
        'Collection reported success without saying when, so the age of the data below cannot be established.',
      trustworthy: false,
    }
  }

  return {
    label: `Updated ${last}`,
    tone: freshness.freshnessStatus === 'AGING' ? 'unknown' : 'ok',
    detail:
      freshness.freshnessStatus === 'AGING'
        ? 'Collected successfully, and older than its usual interval.'
        : 'Collected successfully within its expected interval.',
    trustworthy: freshness.freshnessStatus !== 'AGING',
  }
}

/**
 * What an empty section means, which depends entirely on whether we looked.
 *
 * This is the distinction the product exists for. An empty user list because
 * the collector failed is not an empty user list, and the two render
 * identically unless something says otherwise -- the reader sees nothing and
 * concludes there is nothing.
 *
 * Returns null when the section has rows, because the qualification belongs to
 * the emptiness and attaching it to a populated list would be noise.
 */
export function emptySectionMeaning(
  freshness: ServiceSyncFreshness | null,
  isEmpty: boolean
): string | null {
  if (!isEmpty) return null
  const presentation = freshnessPresentation(freshness)
  if (presentation.trustworthy) {
    return 'Collection succeeded and returned nothing, so this is an empty result rather than a missing one.'
  }
  return `Nothing is shown here, and that is not a finding: ${presentation.detail}`
}
