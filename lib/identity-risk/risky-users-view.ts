/**
 * The view model behind the three Risky Users views: the count on the tenant
 * overview, the list of users, and one user's detail.
 *
 * All three read from here so they cannot disagree with each other, and so the
 * rules that keep them honest are written once:
 *
 *  - A count is exact, a lower bound, withheld, or unavailable. Zero is
 *    reachable only through the exact branch, and a lower bound is never zero.
 *  - Withheld and unavailable are not the same thing and never share wording.
 *    Withheld means HawkView will not guess: nothing is broken, no retry helps,
 *    and the reason is specific enough to send a technician somewhere.
 *    Unavailable means the read failed, which is a fault and says so.
 *  - When a count is withheld, what HawkView does know is shown beside it. The
 *    findings exist even when the total does not.
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
  RiskAssessmentCountReason,
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

export type RiskyUserCountAccuracy =
  | 'EXACT'
  | 'AT_LEAST'
  /**
   * HawkView could count but will not, because any number it produced would be
   * a guess. This is a statement about coverage, not a failure: nothing is
   * broken, no retry helps, and the findings behind it are still real. It must
   * never be presented as an error or an empty state — a technician who reads a
   * withheld count as breakage opens a support ticket, which is a worse outcome
   * than the dishonest number would have been.
   */
  | 'WITHHELD'
  /** The assessment could not be loaded or read. This one is a failure. */
  | 'UNAVAILABLE'

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
   * What HawkView does know, when it will not give a number. "3 mailboxes
   * forwarding externally; cannot confirm how many belong to users" is far more
   * useful than a blank, and it is true — the findings exist even when the
   * count does not.
   */
  known: string[]
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

/**
 * Why an exact total was withheld, in words that send a technician somewhere.
 * These are deliberately not interchangeable: "we could not confirm whether
 * these mailboxes belong to people" and "we could not interpret some sign-in
 * events" are different problems with different next steps, and collapsing them
 * into one generic "unavailable" is the defect this rebuild exists to remove.
 */
const withheldReasonCopy: Readonly<
  Record<RiskAssessmentCountReason, { headline: string; caption: string }>
> = {
  UNRESOLVED_SUBJECT_IDENTITY: {
    headline: 'Not counted — findings could not be tied to people',
    caption:
      'HawkView found activity worth reviewing but could not establish which of it belongs to a person, so it will not state a number of users. The mailbox or account binding was stale, missing, duplicated or ambiguous. The findings themselves are listed below and are unaffected.',
  },
  UNINTERPRETABLE_EVIDENCE: {
    headline: 'Not counted — some evidence could not be interpreted',
    caption:
      'This tenant’s evidence contains sign-in codes or events that HawkView does not recognise. Rather than count around them and imply the rest is the whole picture, HawkView withholds the total. What it did interpret is listed below.',
  },
  CAPACITY_LIMIT: {
    headline: 'Not counted — more evidence than a single assessment covers',
    caption:
      'This tenant produced more matching evidence than one assessment reads, so a tenant-wide total would understate it. What was read is listed below.',
  },
  INCOMPLETE_WINDOW: {
    headline: 'Not counted — the evidence window is incomplete',
    caption:
      'The evidence window HawkView assessed does not cover the full period, so a tenant total would describe part of it as though it were all of it. Findings inside the window are listed below.',
  },
  COLLECTION_STALE: {
    headline: 'Not counted — the evidence is out of date',
    caption:
      'The most recent collection for this tenant is older than its freshness expectation. Findings are shown as they were last observed rather than counted as a current position.',
  },
  SOURCE_UNAVAILABLE: {
    headline: 'Not counted — an evidence source is unavailable',
    caption:
      'One of the sources this count depends on did not return evidence. A total drawn from the remaining sources would look like a tenant-wide answer without being one.',
  },
}

const unreportedWithheldReason = {
  headline: 'Not counted — HawkView could not confirm a total',
  caption:
    'HawkView did not report a confirmed number of users for this tenant, and did not report why. It is not zero. Any users it did report are listed below.',
}

/**
 * What is still true when the count is not. Built from the findings that were
 * returned, so it never claims more than the assessment did.
 */
function knownDespiteNoCount(assessment: RiskAssessment | null) {
  if (!assessment) return []
  const byReason = new Map<string, Set<string>>()
  for (const user of assessment.users) {
    for (const finding of user.findings) {
      if (finding.activityState !== 'CURRENT') continue
      const key = `${finding.title} ${user.subjectType}`
      const subjects = byReason.get(key) ?? new Set<string>()
      subjects.add(user.id)
      byReason.set(key, subjects)
    }
  }
  return Array.from(byReason.entries())
    .map(([key, subjects]) => {
      const [title, subjectType] = key.split(' ')
      const noun =
        subjectType === 'MAILBOX'
          ? subjects.size === 1
            ? 'mailbox'
            : 'mailboxes'
          : subjects.size === 1
            ? 'account'
            : 'accounts'
      return `${title}: ${subjects.size} ${noun}`
    })
    .sort()
}

function coverageGaps(
  assessment: RiskAssessment | null,
  channel: MicrosoftChannel
) {
  const gaps: string[] = []
  if (channel.state !== 'REPORTING') gaps.push(channel.headline)
  if (!assessment) return gaps

  // A check that cannot run on this tenant's evidence bounds what any number
  // here means, so it is disclosed beside the number rather than left to the
  // coverage panel further down the page.
  const inapplicable = assessment.rules.filter(
    (rule) => rule.status === 'INAPPLICABLE'
  )
  if (inapplicable.length > 0) {
    gaps.push(
      `${inapplicable.length} of ${assessment.rules.length} HawkView ${
        assessment.rules.length === 1 ? 'check' : 'checks'
      } cannot run on this tenant’s evidence: ${inapplicable
        .map((rule) => rule.title)
        .join(', ')}`
    )
  }
  const incomplete = assessment.rules.filter(
    (rule) =>
      rule.status !== 'INAPPLICABLE' &&
      (rule.status !== 'READY' || rule.countsCapped)
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
  const known = knownDespiteNoCount(assessment)

  // A read that failed is a failure and says so — it is actionable, a retry
  // may fix it, and it is a different thing from HawkView declining to guess.
  if (requestFailed || contractFailed || !assessment) {
    return {
      accuracy: 'UNAVAILABLE',
      value: null,
      display: '—',
      accessibleValue: 'Not available',
      headline: contractFailed
        ? 'The latest response could not be read'
        : requestFailed
          ? 'The latest assessment could not be loaded'
          : 'No assessment has been reported yet',
      caption: contractFailed
        ? 'A response arrived that HawkView could not read, so no current count can be confirmed. This is not zero.'
        : requestFailed
          ? 'The latest assessment could not be loaded, so no current count can be confirmed. Any findings shown are from an earlier read and this failure has not resolved them.'
          : 'HawkView has not evaluated this tenant yet. This is not zero.',
      known,
      gaps,
      asOf: assessment?.summary?.asOf ?? null,
    }
  }

  const reported = hawkViewRiskyUserCountPresentation(assessment)
  const summary = assessment.summary?.currentUsers

  if (!summary || summary.accuracy === 'UNKNOWN' || summary.value === null) {
    // Withheld on purpose. Nothing is broken and no retry helps, so this reads
    // as a statement about what the evidence supports, with the specific reason
    // HawkView gave and the findings that are true regardless.
    const copy = summary?.reason
      ? withheldReasonCopy[summary.reason]
      : unreportedWithheldReason
    return {
      accuracy: 'WITHHELD',
      value: null,
      display: '—',
      accessibleValue: 'Not counted',
      headline: copy.headline,
      caption: copy.caption,
      known,
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
      known,
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
      known,
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
    known,
    gaps,
    asOf: reported.asOf,
  }
}
