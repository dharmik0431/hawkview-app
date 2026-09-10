/**
 * The view model behind the three Risky Users views: the count on the tenant
 * overview, the list of users, and one user's detail.
 *
 * All three read from here so they cannot disagree with each other, and so the
 * rules that keep them honest are written once:
 *
 *  - A count is exact, a lower bound, or not available. Zero is reachable only
 *    through the exact branch, a lower bound is never zero, and "we cannot
 *    confirm a count" is an answer rather than an error.
 *  - A zero is never shown on its own. It always carries what was evaluated to
 *    produce it and what was not covered, because a bare zero beside an
 *    undisclosed gap is the defect this rebuild exists to remove.
 *  - HawkView's channel and Microsoft's are never merged, summed or blended.
 *    A row records which system reported it, and where Microsoft could not be
 *    consulted the row says that rather than implying Microsoft found nothing.
 *  - Nothing here concludes that a user is safe.
 */
import {
  currentRiskAssessmentUsers,
  hawkViewRiskyUserCountPresentation,
  riskAssessmentEmptyPresentation,
  riskProtectionSummary,
} from './presentation.ts'
import type {
  IdentityRiskChannelReason,
  MicrosoftEntraRiskyUser,
  MicrosoftEntraRiskyUsersView,
  RiskAssessment,
  RiskAssessmentUser,
} from './types'

/* -------------------------------------------------------------------------- */
/* Microsoft channel                                                          */
/* -------------------------------------------------------------------------- */

export type MicrosoftChannelState =
  /** Microsoft reported, and its records can be shown as Microsoft's own. */
  | 'REPORTING'
  /** Microsoft cannot report on this tenant at all. Includes the P2 case. */
  | 'UNAVAILABLE'
  /** Microsoft should be reporting but the latest read did not succeed. */
  | 'INTERRUPTED'
  /** Microsoft has not been evaluated yet on this tenant. */
  | 'NOT_EVALUATED'

export type MicrosoftChannel = {
  state: MicrosoftChannelState
  /** One line, safe to show beside a HawkView count. */
  headline: string
  /** What the MSP is not getting, and what would change it. */
  detail: string
  /**
   * True when the gap is closed by a licence or permission the MSP controls,
   * which is worth telling them plainly rather than burying as "unavailable".
   */
  addressable: boolean
  reasonCode: IdentityRiskChannelReason | null
  observedAt: string | null
}

const microsoftReasonCopy: Readonly<
  Record<IdentityRiskChannelReason, { headline: string; detail: string }>
> = {
  LICENSE_REQUIRED: {
    headline:
      'Microsoft Entra risk detection is unavailable on this tenant — requires Entra ID P2',
    detail:
      'Microsoft only reports risky users for tenants licensed for Entra ID P2. Nothing on this page reflects Microsoft Identity Protection, and a HawkView result of zero does not mean Microsoft would also report zero. Licensing this tenant for P2 would add Microsoft as a second, independent source alongside HawkView.',
  },
  MISSING_PERMISSION: {
    headline:
      'Microsoft Entra risk detection is unavailable — HawkView has not been granted access',
    detail:
      'Reading Microsoft risky users requires the IdentityRiskyUser.Read.All permission on this tenant. Until it is consented, Microsoft cannot be consulted and its absence here says nothing about what Microsoft would report.',
  },
  WAITING_FOR_COLLECTION: {
    headline: 'Microsoft Entra risk detection has not been collected yet',
    detail:
      'The first Microsoft read for this tenant has not completed. This is not an empty result from Microsoft.',
  },
  COLLECTION_FAILED: {
    headline: 'Microsoft Entra risk detection could not be read',
    detail:
      'The latest attempt to read Microsoft risky users did not succeed. Microsoft may be reporting users that are not shown here; this failure does not resolve or dismiss anything.',
  },
  COLLECTION_STALE: {
    headline: 'Microsoft Entra risk detection is out of date',
    detail:
      'The most recent Microsoft records are older than this tenant’s freshness expectation. They are shown as Microsoft last reported them, not as a current position.',
  },
  SOURCE_UNAVAILABLE: {
    headline: 'Microsoft Entra risk detection is unavailable on this tenant',
    detail:
      'Microsoft did not return risky-user evidence. Missing evidence is not an empty result and must not be read as Microsoft finding nothing.',
  },
  EVALUATION_DISABLED: {
    headline: 'Microsoft Entra risk detection is turned off for this tenant',
    detail:
      'Microsoft risky-user collection is disabled in this tenant’s HawkView configuration. Nothing is being read from Microsoft.',
  },
}

const unknownMicrosoftReason = {
  headline: 'Microsoft Entra risk detection is unavailable on this tenant',
  detail:
    'Microsoft is not reporting risky users here and the cause was not reported. Missing evidence is not an empty result; treat this page as HawkView evidence only.',
}

export function microsoftChannel(
  view: MicrosoftEntraRiskyUsersView
): MicrosoftChannel {
  const { status, reasonCode, observedAt } = view.meta
  const copy = reasonCode
    ? microsoftReasonCopy[reasonCode]
    : unknownMicrosoftReason
  const addressable =
    reasonCode === 'LICENSE_REQUIRED' || reasonCode === 'MISSING_PERMISSION'

  if (status === 'AVAILABLE' || status === 'STALE') {
    return {
      state: status === 'STALE' ? 'INTERRUPTED' : 'REPORTING',
      headline:
        status === 'STALE'
          ? microsoftReasonCopy.COLLECTION_STALE.headline
          : 'Microsoft Entra risk detection is reporting on this tenant',
      detail:
        status === 'STALE'
          ? microsoftReasonCopy.COLLECTION_STALE.detail
          : 'Microsoft records are shown as Microsoft reported them. They are a separate source from HawkView findings and are never combined with them.',
      addressable: false,
      reasonCode,
      observedAt,
    }
  }

  if (status === 'ERROR') {
    return {
      state: 'INTERRUPTED',
      headline: microsoftReasonCopy.COLLECTION_FAILED.headline,
      detail: microsoftReasonCopy.COLLECTION_FAILED.detail,
      addressable: false,
      reasonCode,
      observedAt,
    }
  }

  if (status === 'NOT_EVALUATED' || status === 'LEARNING') {
    return {
      state: 'NOT_EVALUATED',
      headline: microsoftReasonCopy.WAITING_FOR_COLLECTION.headline,
      detail: microsoftReasonCopy.WAITING_FOR_COLLECTION.detail,
      addressable: false,
      reasonCode,
      observedAt,
    }
  }

  return {
    state: 'UNAVAILABLE',
    headline: copy.headline,
    detail: copy.detail,
    addressable,
    reasonCode,
    observedAt,
  }
}

/* -------------------------------------------------------------------------- */
/* Detection attribution                                                      */
/* -------------------------------------------------------------------------- */

export type MicrosoftDetection =
  /** Microsoft reported this same identity. */
  | 'REPORTED'
  /** Microsoft is reporting on this tenant and did not report this identity. */
  | 'NOT_REPORTED'
  /** Microsoft could not be consulted at all. */
  | 'UNAVAILABLE'
  /**
   * Microsoft is reporting, but its records cannot be matched to this identity,
   * so no statement either way is possible. This is deliberately distinct from
   * NOT_REPORTED: treating an unmatchable record as "Microsoft found nothing"
   * would be the merge this product must not make.
   */
  | 'NOT_COMPARABLE'

export type RiskyUserDetection = {
  /** Every row in this list is here because HawkView reported it. */
  hawkView: true
  microsoft: MicrosoftDetection
  microsoftRecord: MicrosoftEntraRiskyUser | null
}

/**
 * Matching HawkView identities to Microsoft records requires a key both sides
 * agree on. HawkView identifies subjects by tenant-keyed pseudonym and
 * Microsoft by directory object id, so a caller can only supply the mapping
 * once the contract carries one. Until then the honest answer for a reporting
 * Microsoft channel is NOT_COMPARABLE, never NOT_REPORTED.
 */
export type MicrosoftCorrelation = ReadonlyMap<string, MicrosoftEntraRiskyUser>

function detectionFor(
  userId: string,
  channel: MicrosoftChannel,
  correlation: MicrosoftCorrelation | null
): RiskyUserDetection {
  if (channel.state !== 'REPORTING') {
    return { hawkView: true, microsoft: 'UNAVAILABLE', microsoftRecord: null }
  }
  if (!correlation) {
    return {
      hawkView: true,
      microsoft: 'NOT_COMPARABLE',
      microsoftRecord: null,
    }
  }
  const record = correlation.get(userId) ?? null
  return {
    hawkView: true,
    microsoft: record ? 'REPORTED' : 'NOT_REPORTED',
    microsoftRecord: record,
  }
}

export function detectedByLabel(detection: RiskyUserDetection) {
  switch (detection.microsoft) {
    case 'REPORTED':
      return 'HawkView and Microsoft'
    case 'NOT_REPORTED':
      return 'HawkView only'
    case 'NOT_COMPARABLE':
      return 'HawkView — Microsoft not comparable'
    default:
      return 'HawkView — Microsoft unavailable'
  }
}

/* -------------------------------------------------------------------------- */
/* List                                                                       */
/* -------------------------------------------------------------------------- */

export type RiskyUserPriority = 'LOW' | 'MEDIUM' | 'HIGH'

export type RiskyUserRow = {
  id: string
  name: string
  /**
   * Not carried by the assessment contract today. The list shows the opaque
   * reference instead of inventing an address it was not given.
   */
  email: string | null
  reference: string
  subjectType: 'USER' | 'MAILBOX'
  priority: RiskyUserPriority | null
  priorityLabel: string
  /** Most recent observation across this user's current findings. */
  lastSeen: string | null
  reasons: string[]
  detection: RiskyUserDetection
  protection: { label: string; tone: 'positive' | 'attention' | 'unknown' }
  /** Kept whole so the detail view has the full evidence without a second read. */
  user: RiskAssessmentUser
}

const priorityRank: Record<RiskyUserPriority, number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
}

const priorityLabels: Record<RiskyUserPriority, string> = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
}

export function riskyUserPriorityLabel(priority: RiskyUserPriority | null) {
  return priority ? priorityLabels[priority] : 'Not ranked'
}

function rowFor(
  user: RiskAssessmentUser,
  channel: MicrosoftChannel,
  correlation: MicrosoftCorrelation | null,
  currentOnly: boolean
): RiskyUserRow {
  const findings = currentOnly
    ? user.findings.filter((finding) => finding.activityState === 'CURRENT')
    : user.findings
  const lastSeen =
    findings
      .map((finding) => finding.lastSeen)
      .sort()
      .at(-1) ?? null
  return {
    id: user.id,
    name: user.label,
    email: null,
    reference: user.id,
    subjectType: user.subjectType,
    priority: user.priority,
    priorityLabel: riskyUserPriorityLabel(user.priority),
    lastSeen,
    reasons: findings.map((finding) => finding.title),
    detection: detectionFor(user.id, channel, correlation),
    protection: riskProtectionSummary(user),
    user,
  }
}

export type RiskyUserList = {
  /** Users with at least one current finding — what the count counts. */
  rows: RiskyUserRow[]
  /**
   * Mailbox-scoped and historical evidence. Shown separately and never counted,
   * because folding it into the headline would inflate the number of people who
   * need attention today.
   */
  context: RiskyUserRow[]
}

export function riskyUserList(
  assessment: RiskAssessment | null,
  channel: MicrosoftChannel,
  correlation: MicrosoftCorrelation | null = null
): RiskyUserList {
  if (!assessment) return { rows: [], context: [] }
  const current = currentRiskAssessmentUsers(assessment)
  const currentIds = new Set(current.map((user) => user.id))
  const byPriorityThenRecency = (a: RiskyUserRow, b: RiskyUserRow) => {
    const rank =
      (b.priority ? priorityRank[b.priority] : 0) -
      (a.priority ? priorityRank[a.priority] : 0)
    if (rank !== 0) return rank
    return (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '')
  }
  return {
    rows: current
      .map((user) => rowFor(user, channel, correlation, true))
      .sort(byPriorityThenRecency),
    context: assessment.users
      .filter((user) => !currentIds.has(user.id))
      .map((user) => rowFor(user, channel, correlation, false))
      .sort(byPriorityThenRecency),
  }
}

/* -------------------------------------------------------------------------- */
/* Count                                                                      */
/* -------------------------------------------------------------------------- */

export type RiskyUserCountAccuracy = 'EXACT' | 'AT_LEAST' | 'NOT_AVAILABLE'

export type RiskyUserCount = {
  accuracy: RiskyUserCountAccuracy
  value: number | null
  /** What the tile prints. */
  display: string
  /** What a screen reader says instead of the glyph. */
  accessibleValue: string
  headline: string
  /** What this number is, and what it does not cover. Never omitted. */
  caption: string
  /**
   * Everything the number does not account for. A zero is never rendered
   * without these, and a caller that drops them is dropping the disclosure that
   * makes the zero truthful.
   */
  gaps: string[]
  asOf: string | null
}

export type RiskyUserCountInput = {
  assessment: RiskAssessment | null
  channel: MicrosoftChannel
  /** The latest read failed; any assessment held is from an earlier read. */
  requestFailed?: boolean
  /** A response arrived that this client could not read. */
  contractFailed?: boolean
}

function coverageGaps(
  assessment: RiskAssessment | null,
  channel: MicrosoftChannel
) {
  const gaps: string[] = []
  if (channel.state !== 'REPORTING') gaps.push(channel.headline)
  if (!assessment) return gaps

  const incomplete = assessment.rules.filter(
    (rule) => rule.status !== 'READY' || rule.countsCapped
  )
  if (incomplete.length > 0) {
    gaps.push(
      `${incomplete.length} of ${assessment.rules.length} HawkView ${
        assessment.rules.length === 1 ? 'check' : 'checks'
      } did not complete over current evidence`
    )
  }
  const unreadySources = assessment.sources.filter(
    (source) => source.status !== 'READY' || source.freshness !== 'CURRENT'
  )
  if (unreadySources.length > 0) {
    gaps.push(
      `${unreadySources.length} of ${assessment.sources.length} evidence ${
        assessment.sources.length === 1 ? 'source is' : 'sources are'
      } incomplete or out of date`
    )
  }
  if (assessment.page.hasMore) {
    gaps.push('More users are available than the page that was read')
  }
  return gaps
}

export function riskyUserCount({
  assessment,
  channel,
  requestFailed = false,
  contractFailed = false,
}: RiskyUserCountInput): RiskyUserCount {
  const gaps = coverageGaps(assessment, channel)

  if (requestFailed || contractFailed || !assessment) {
    return {
      accuracy: 'NOT_AVAILABLE',
      value: null,
      display: '—',
      accessibleValue: 'Not available',
      headline: 'Risky users could not be counted',
      caption: contractFailed
        ? 'A response arrived that HawkView could not read, so no current count can be confirmed. This is not zero.'
        : requestFailed
          ? 'The latest assessment could not be loaded, so no current count can be confirmed. Any findings shown are from an earlier read and this failure has not resolved them.'
          : 'No assessment has been reported for this tenant yet. This is not zero.',
      gaps,
      asOf: assessment?.summary?.asOf ?? null,
    }
  }

  const reported = hawkViewRiskyUserCountPresentation(assessment)
  const summary = assessment.summary?.currentUsers

  if (!summary || summary.accuracy === 'UNKNOWN' || summary.value === null) {
    return {
      accuracy: 'NOT_AVAILABLE',
      value: null,
      display: '—',
      accessibleValue: 'Not available',
      headline: 'Risky user count not available',
      caption:
        'HawkView did not report a confirmed total for this tenant. This is not zero — any users it did report are listed below.',
      gaps,
      asOf: reported.asOf,
    }
  }

  if (summary.accuracy === 'AT_LEAST') {
    return {
      accuracy: 'AT_LEAST',
      value: summary.value,
      display: `≥${summary.value.toLocaleString()}`,
      accessibleValue: `At least ${summary.value.toLocaleString()}`,
      headline: 'Risky users, at least',
      caption:
        'A lower bound on distinct users with a current HawkView finding. Partial coverage or a capacity limit prevented a complete tenant count, so the real number may be higher.',
      gaps,
      asOf: reported.asOf,
    }
  }

  if (summary.value === 0) {
    // The one place a confident zero is printed. It carries the scope of the
    // claim and every disclosed gap, because a zero on its own is the defect
    // this rebuild was called to remove.
    const empty = riskAssessmentEmptyPresentation(assessment)
    return {
      accuracy: 'EXACT',
      value: 0,
      display: '0',
      accessibleValue: '0',
      headline: empty?.label ?? 'No risky users reported',
      caption:
        empty?.detail ??
        'HawkView reported no users with a current finding. This covers only the checks below and their reported windows; it does not establish that any user is safe.',
      gaps,
      asOf: reported.asOf,
    }
  }

  return {
    accuracy: 'EXACT',
    value: summary.value,
    display: summary.value.toLocaleString(),
    accessibleValue: summary.value.toLocaleString(),
    headline: summary.value === 1 ? 'Risky user' : 'Risky users',
    caption:
      'Distinct users with at least one current HawkView finding. A user with several findings is counted once. These are investigation leads, not confirmed compromise.',
    gaps,
    asOf: reported.asOf,
  }
}
