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
  CorrelationRef,
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
  /**
   * Microsoft records are present while the channel reports itself unable to
   * produce any. Both cannot be true, and the panel says so rather than
   * printing one of them over the other.
   */
  | 'CONTRADICTORY'

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
      'Microsoft only reports risky users for tenants licensed for Entra ID P2. Nothing on this page reflects Microsoft Identity Protection, and a HawkView result of zero does not mean Microsoft would also report zero. Licensing this tenant for P2 would add Microsoft’s own determinations alongside HawkView’s findings, including detections drawn from telemetry HawkView cannot see.',
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
  const recordCount = view.users?.length ?? 0

  // Microsoft verdicts also reach us through sign-in evidence, which does not
  // need an Entra ID P2 licence. So records can be present on a tenant whose
  // risky-users channel truthfully reports itself unlicensed, and left alone
  // this panel would print "requires Entra ID P2" directly above them.
  //
  // (One such tenant held 932 of those verdicts on 2026-09-10, up from 921
  // ninety minutes earlier. The count is an illustration with a date on it,
  // not the reason — the reason is that the two facts are independent, which
  // does not decay.)
  //
  // Neither half is safe to suppress: hiding the records would withhold what
  // Microsoft said, and hiding the status would imply a working channel that
  // may not be. So the disagreement is what gets rendered.
  if (
    recordCount > 0 &&
    (status === 'UNAVAILABLE' || status === 'NOT_EVALUATED')
  ) {
    return {
      state: 'CONTRADICTORY',
      headline: `Microsoft reported ${recordCount} ${
        recordCount === 1 ? 'record' : 'records'
      } while its channel reports itself unavailable`,
      detail:
        'These two cannot both be right. The records below are shown as Microsoft reported them, and the channel status above them should not be relied on until that is resolved. Microsoft verdicts can reach HawkView through sign-in evidence without an Entra ID P2 licence, so records here do not by themselves mean the tenant is licensed.',
      addressable: false,
      reasonCode,
      observedAt,
    }
  }
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
/* Microsoft verdict polarity                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Microsoft's channel is a list of risk-related *conclusions*, and some of those
 * conclusions are that a sign-in was safe. A surface that iterates the list and
 * paints every row as a detection shows a technician something Microsoft cleared
 * as something Microsoft flagged, and the technician disables an account over
 * it. Every part of the pipeline can be correct and the screen still lies.
 *
 * Polarity is therefore resolved before anything renders, and an unrecognised
 * verdict is never allowed to fall to the risk side.
 */
export type MicrosoftVerdictPolarity =
  /** Microsoft currently considers this identity at risk. */
  | 'ACTIVE_RISK'
  /** Microsoft concluded this was safe. Not a finding. */
  | 'CLEARED'
  /** Microsoft considers this closed - remediated or dismissed. */
  | 'CLOSED'
  /** Microsoft said something this client does not recognise. */
  | 'UNRECOGNISED'

const clearedRiskDetails = new Set([
  'adminConfirmedSigninSafe',
  'aiConfirmedSigninSafe',
  'adminConfirmedAccountSafe',
])

export function microsoftVerdictPolarity(
  user: MicrosoftEntraRiskyUser
): MicrosoftVerdictPolarity {
  // An explicit safe conclusion settles it, whatever the state says.
  if (user.riskDetail && clearedRiskDetails.has(user.riskDetail))
    return 'CLEARED'
  switch (user.riskState) {
    case 'atRisk':
    case 'confirmedCompromised':
      return 'ACTIVE_RISK'
    case 'confirmedSafe':
    case 'none':
      return 'CLEARED'
    case 'remediated':
    case 'dismissed':
      return 'CLOSED'
    default:
      // unknownFutureValue, or anything a later Microsoft adds. Deliberately
      // not ACTIVE_RISK: guessing upward invents a detection Microsoft never
      // made, and that is the direction that gets an account disabled.
      return 'UNRECOGNISED'
  }
}

export const microsoftPolarityLabel: Readonly<
  Record<MicrosoftVerdictPolarity, string>
> = {
  ACTIVE_RISK: 'Microsoft reports risk',
  CLEARED: 'Microsoft concluded safe',
  CLOSED: 'Closed by Microsoft',
  UNRECOGNISED: 'Verdict not recognised',
}

/**
 * `dismissed` is where Microsoft's *automatic* remediation lands, not
 * `remediated`. Rendering it as "someone waved this away" turns a machine
 * assessment into apparent human negligence, so the actor is named from
 * riskDetail rather than inferred from the state.
 */
export function microsoftVerdictDetail(user: MicrosoftEntraRiskyUser): string {
  const detail = user.riskDetail
  if (!detail || detail === 'none') return ''
  switch (detail) {
    case 'aiConfirmedSigninSafe':
      return 'Microsoft\u2019s automated assessment concluded this sign-in was safe'
    case 'adminConfirmedSigninSafe':
      return 'An administrator confirmed this sign-in was safe'
    case 'adminConfirmedAccountSafe':
      return 'An administrator confirmed this account was safe'
    case 'adminConfirmedSigninCompromised':
      return 'An administrator confirmed this sign-in was compromised'
    case 'adminConfirmedUserCompromised':
      return 'An administrator confirmed this user was compromised'
    case 'adminDismissedAllRiskForUser':
      return 'An administrator dismissed all risk for this user'
    case 'adminDismissedRiskForSignIn':
      return 'An administrator dismissed the risk for this sign-in'
    case 'm365DAdminDismissedDetection':
      return 'An administrator dismissed this detection in Microsoft 365 Defender'
    case 'userPassedMFADrivenByRiskBasedPolicy':
      return 'The user satisfied MFA required by a risk-based policy'
    // Microsoft's own documentation notes this identifier is misleading: it
    // means a secure password change, not a self-service reset flow. The word
    // "reset" is deliberately not rendered from it.
    case 'userPerformedSecuredPasswordReset':
    case 'userPerformedSecuredPasswordChange':
      return 'The user completed a secure password change'
    case 'userChangedPasswordOnPremises':
      return 'The user changed their password on-premises'
    case 'adminGeneratedTemporaryPassword':
      return 'An administrator issued a temporary password'
    case 'hidden':
      return 'Microsoft is not disclosing the detail on this tenant'
    default:
      return 'Microsoft reported a detail this client does not recognise'
  }
}

/**
 * `hidden` does not mean "no risk". It means the tenant is not licensed for
 * Identity Protection, so Microsoft withholds the level. Rendering it as "none",
 * or as a blank cell, tells an MSP their customer is clean when we simply cannot
 * see - and hides the one moment where the licence is worth naming.
 *
 * The level is also a confidence scale, not a severity scale: "high" means
 * Microsoft is confident, not that the impact is large. It is labelled as
 * confidence and never sorted or coloured as severity.
 */
export function microsoftRiskLevelLabel(
  level: MicrosoftEntraRiskyUser['riskLevel']
) {
  switch (level) {
    case 'hidden':
      return 'Detected \u2014 level requires Entra ID P2'
    case 'unknownFutureValue':
      return 'Not recognised'
    case 'none':
      return 'None reported'
    default:
      return `${level[0].toUpperCase()}${level.slice(1)} confidence`
  }
}

/** True when Microsoft is withholding levels for want of a P2 licence. */
export function microsoftLevelsHidden(view: MicrosoftEntraRiskyUsersView) {
  return Boolean(view.users?.some((user) => user.riskLevel === 'hidden'))
}

/**
 * Microsoft's records split by what Microsoft actually concluded, so a caller
 * cannot render a clearance among the detections by accident.
 */
export function microsoftRecordsByPolarity(view: MicrosoftEntraRiskyUsersView) {
  const groups: Record<MicrosoftVerdictPolarity, MicrosoftEntraRiskyUser[]> = {
    ACTIVE_RISK: [],
    CLEARED: [],
    CLOSED: [],
    UNRECOGNISED: [],
  }
  for (const user of view.users ?? []) {
    groups[microsoftVerdictPolarity(user)].push(user)
  }
  return groups
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
  /**
   * Why Microsoft has nothing to say about this user, when it has nothing to
   * say. A capability statement an MSP can act on beats a shrug, so this is
   * carried rather than flattened into one label.
   */
  because: string | null
}

/**
 * Two refs match only when they are the same shape and the same value.
 *
 * Never across shapes: a directory object GUID and a user principal name are
 * different namespaces, and a tenant supplies one or the other depending on
 * whether its evidence comes from Graph or from the audit log. Comparing them
 * would either match nothing or, worse, match by coincidence.
 *
 * The ref may also be wrapped rather than raw. Equality still works for a
 * wrapped pair, and a wrapped ref never equals an unwrapped one, so a mismatched
 * wrapping fails closed to "cannot compare" rather than to a false match.
 */
function refsMatch(left: CorrelationRef | null, right: CorrelationRef | null) {
  return Boolean(
    left?.available &&
    right?.available &&
    left.shape === right.shape &&
    left.ref === right.ref
  )
}

function detectionFor(
  user: RiskAssessmentUser,
  channel: MicrosoftChannel,
  microsoftUsers: MicrosoftEntraRiskyUser[] | null
): RiskyUserDetection {
  // Microsoft cannot report on this tenant at all.
  if (channel.state !== 'REPORTING') {
    return {
      hawkView: true,
      microsoft: 'UNAVAILABLE',
      microsoftRecord: null,
      because: channel.headline,
    }
  }

  // Microsoft is reporting, but its records were not supplied to compare
  // against. That is a different statement from Microsoft being unavailable,
  // and flattening the two would misdescribe the channel.
  if (!microsoftUsers) {
    return {
      hawkView: true,
      microsoft: 'NOT_COMPARABLE',
      microsoftRecord: null,
      because:
        'Microsoft is reporting on this tenant, but its records were not available to compare against this user.',
    }
  }

  const correlation = user.correlation
  // No key at all, from a server that does not yet send one. Saying Microsoft
  // did not report this user would be a claim about Microsoft with nothing
  // behind it.
  if (!correlation) {
    return {
      hawkView: true,
      microsoft: 'NOT_COMPARABLE',
      microsoftRecord: null,
      because:
        'HawkView and Microsoft cannot be matched for this user, so neither agreement nor disagreement can be shown.',
    }
  }

  // A key that is unavailable for a stated reason. This is a fact about what
  // this tenant can support, and it is more useful to an MSP than a shrug.
  if (!correlation.available) {
    return {
      hawkView: true,
      microsoft: 'NOT_COMPARABLE',
      microsoftRecord: null,
      because: correlation.because,
    }
  }

  const record =
    microsoftUsers.find((candidate) =>
      refsMatch(correlation, candidate.correlation)
    ) ?? null

  // Every Microsoft record would have to be comparable before an absence of a
  // match could mean Microsoft did not report this person. If some records
  // carry no usable key, a miss is unproven rather than negative.
  const allComparable = microsoftUsers.every(
    (candidate) => candidate.correlation?.available
  )
  if (!record && !allComparable) {
    return {
      hawkView: true,
      microsoft: 'NOT_COMPARABLE',
      microsoftRecord: null,
      because:
        'Some Microsoft records could not be matched to a HawkView identity, so an absence here is not evidence that Microsoft cleared this user.',
    }
  }

  return {
    hawkView: true,
    microsoft: record ? 'REPORTED' : 'NOT_REPORTED',
    microsoftRecord: record,
    because: null,
  }
}

export function detectedByLabel(detection: RiskyUserDetection) {
  switch (detection.microsoft) {
    case 'REPORTED':
      // The strongest signal this product can produce: two systems reporting
      // the same person.
      //
      // Agreement is not always independent corroboration. Microsoft's
      // sign-in-derived verdicts read the same log lines HawkView reads, so the
      // two can agree because they interpreted one piece of evidence the same
      // way; its Identity Protection detections do draw on telemetry we cannot
      // see. The row says both reported, which is true either way, and claims
      // nothing about independence.
      return 'HawkView and Microsoft'
    case 'NOT_REPORTED':
      // Only sayable once the join was actually possible.
      return 'HawkView only — Microsoft did not report this user'
    case 'NOT_COMPARABLE':
      return 'HawkView — Microsoft cannot be compared for this user'
    default:
      return 'HawkView — Microsoft unavailable on this tenant'
  }
}

/** The short form for the cell; the reason goes underneath it. */
export function microsoftDetectionSummary(detection: RiskyUserDetection) {
  switch (detection.microsoft) {
    case 'REPORTED':
      return 'Microsoft'
    case 'NOT_REPORTED':
      return 'Microsoft did not report this user'
    case 'NOT_COMPARABLE':
      return 'Not comparable'
    default:
      return 'Microsoft unavailable'
  }
}

/* -------------------------------------------------------------------------- */
/* List                                                                       */
/* -------------------------------------------------------------------------- */

export type RiskyUserPriority = 'LOW' | 'MEDIUM' | 'HIGH'

export type RiskyUserReason = {
  title: string
  /**
   * Carried so the surface can say what this rule's count counts and what its
   * date marks. Those differ per rule and are not derivable from the numbers.
   */
  ruleId: string
  /** Distinct pieces of evidence behind this reason, as the server counted. */
  evidenceCount: number
  /** True when the count is a ceiling rather than a total. */
  evidenceCountCapped: boolean
  firstSeen: string
  lastSeen: string
}

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
  /**
   * The reason that produced lastSeen.
   *
   * The column is a maximum over reasons whose timestamps do not all mean the
   * same thing: a repeated-failure reason contributes the time something last
   * happened, and the mailbox reason contributes the time HawkView read a
   * setting. A read time is always recent, so without saying which kind won,
   * every forwarding row sorts and reads as the freshest thing on the page.
   *
   * Naming the source lets the cell say what kind of time it is showing. It is
   * the same fix as the per-reason line, applied to the aggregate that sits
   * beside it — the aggregate was the half still implying "this happened".
   */
  lastSeenFrom: RiskyUserReason | null
  /**
   * Each reason with its own count and its own recency, never a list of titles
   * beside one shared date.
   *
   * A row reading "Repeated invalid credentials, External mailbox forwarding —
   * last seen Tuesday" states two true things and implies a third that is
   * false: the reader cannot tell which reason was Tuesday, and the natural
   * assumption is both. On real data one account carried 467 lockouts that
   * stopped six days before the last password rejection, so the shared date
   * described the quieter signal and made the louder one look current.
   *
   * The count and the date travel in the same object because separating them
   * is what allows a surface to put one beside the other's date.
   */
  reasons: RiskyUserReason[]
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
  microsoftUsers: MicrosoftEntraRiskyUser[] | null,
  currentOnly: boolean
): RiskyUserRow {
  const findings = currentOnly
    ? user.findings.filter((finding) => finding.activityState === 'CURRENT')
    : user.findings
  const reasons: RiskyUserReason[] = findings.map((finding) => ({
    title: finding.title,
    ruleId: finding.ruleId,
    evidenceCount: finding.evidenceCount,
    evidenceCountCapped: finding.evidenceCountCapped,
    firstSeen: finding.firstSeen,
    lastSeen: finding.lastSeen,
  }))
  const lastSeenFrom =
    [...reasons].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen)).at(-1) ??
    null
  const lastSeen = lastSeenFrom?.lastSeen ?? null
  return {
    id: user.id,
    name: user.displayName ?? user.label,
    email: user.userPrincipalName,
    reference: user.id,
    subjectType: user.subjectType,
    priority: user.priority,
    priorityLabel: riskyUserPriorityLabel(user.priority),
    lastSeen,
    lastSeenFrom,
    reasons,
    detection: detectionFor(user, channel, microsoftUsers),
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
  microsoftUsers: MicrosoftEntraRiskyUser[] | null = null
): RiskyUserList {
  if (!assessment) return { rows: [], context: [] }
  const current = currentRiskAssessmentUsers(assessment)
  const currentIds = new Set(current.map((user) => user.id))
  const corroborated = (row: RiskyUserRow) =>
    row.detection.microsoft === 'REPORTED' ? 1 : 0
  const byPriorityThenCorroboration = (a: RiskyUserRow, b: RiskyUserRow) => {
    // HawkView's own priority orders HawkView's own list, and corroboration
    // only breaks ties inside a band.
    //
    // Corroboration cannot be the primary key even though it is a structural
    // fact rather than a blend of severities. Microsoft's channel is populated
    // on Entra ID P2 tenants and empty everywhere else, so ranking on it would
    // make the order depend on what each customer pays Microsoft: the same two
    // HawkView findings sort one way on a P2 tenant and the other way on an
    // identical tenant without it. An MSP working across a fleet would have no
    // way to see that the rule had changed, because on most tenants the key is
    // a no-op and the inconsistency is invisible from any single screen.
    //
    // As a tiebreaker it cannot flip a High below a Low, and it still puts a
    // corroborated row at the top of its band. What actually resolves the case
    // it was built for is on the row itself — the column names whose rating it
    // is, and Microsoft's verdict travels beside it.
    const rank =
      (b.priority ? priorityRank[b.priority] : 0) -
      (a.priority ? priorityRank[a.priority] : 0)
    if (rank !== 0) return rank
    const corroboration = corroborated(b) - corroborated(a)
    if (corroboration !== 0) return corroboration
    return (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '')
  }
  return {
    rows: current
      .map((user) => rowFor(user, channel, microsoftUsers, true))
      .sort(byPriorityThenCorroboration),
    context: assessment.users
      .filter((user) => !currentIds.has(user.id))
      .map((user) => rowFor(user, channel, microsoftUsers, false))
      .sort(byPriorityThenCorroboration),
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
  /**
   * What the tile prints. Never a dash and never a blank when there is no
   * number: a dash reads as zero to anyone who has used a dashboard, which is
   * exactly the reading these states exist to prevent. `value === null` is the
   * signal that this is words rather than a numeral, so it can be set smaller.
   */
  display: string
  /** What a screen reader says instead of the glyph. */
  accessibleValue: string
  headline: string
  /** What this number is, and what it does not cover. Never omitted. */
  caption: string
  /**
   * Every reason an exact total was withheld, in full. Empty unless the count
   * is withheld for more than one reason, in which case the headline is
   * deliberately neutral and these carry the detail.
   */
  reasons: string[]
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
  // Grouped on a structured key rather than a concatenated string: a finding
  // title is server-supplied text and could contain any separator character.
  const byTitle = new Map<
    string,
    Map<RiskAssessmentUser['subjectType'], Set<string>>
  >()
  for (const user of assessment.users) {
    for (const finding of user.findings) {
      if (finding.activityState !== 'CURRENT') continue
      const bySubjectType = byTitle.get(finding.title) ?? new Map()
      const subjects = bySubjectType.get(user.subjectType) ?? new Set<string>()
      subjects.add(user.id)
      bySubjectType.set(user.subjectType, subjects)
      byTitle.set(finding.title, bySubjectType)
    }
  }
  const lines: string[] = []
  for (const [title, bySubjectType] of Array.from(byTitle)) {
    for (const [subjectType, subjects] of Array.from(bySubjectType)) {
      const noun =
        subjectType === 'MAILBOX'
          ? subjects.size === 1
            ? 'mailbox'
            : 'mailboxes'
          : subjects.size === 1
            ? 'account'
            : 'accounts'
      lines.push(`${title}: ${subjects.size} ${noun}`)
    }
  }
  return lines.sort()
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
      display: 'Not available',
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
      reasons: [],
      known,
      gaps,
      asOf: assessment?.summary?.asOf ?? null,
    }
  }

  const reported = hawkViewRiskyUserCountPresentation(assessment)
  const summary = assessment.summary?.currentUsers

  if (!summary || summary.accuracy === 'UNKNOWN' || summary.value === null) {
    // Withheld on purpose. Nothing is broken and no retry helps, so this reads
    // as a statement about what the evidence supports, with every reason
    // HawkView gave and the findings that are true regardless.
    //
    // More than one reason can hold at once, and showing the first would read
    // as "this is the reason" — the same defect as any other true sentence
    // standing in for the ones beside it. One reason keeps its own headline,
    // because that is more useful than a generic one; several share a neutral
    // headline and are listed in full underneath.
    const reasons = summary?.reasons ?? []
    const copies = reasons.map((reason) => withheldReasonCopy[reason])
    const single = copies.length === 1 ? copies[0] : null
    return {
      accuracy: 'WITHHELD',
      value: null,
      display: 'Not counted',
      accessibleValue: 'Not counted',
      headline:
        single?.headline ??
        (copies.length > 1
          ? `Not counted — ${copies.length} reasons`
          : unreportedWithheldReason.headline),
      caption:
        single?.caption ??
        (copies.length > 1
          ? 'HawkView will not state a number of users for this tenant. Every reason it gave is listed below; each one on its own is enough to withhold the total.'
          : unreportedWithheldReason.caption),
      reasons: copies.map((copy) => copy.caption),
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
      reasons: [],
      known,
      gaps,
      asOf: reported.asOf,
    }
  }

  if (summary.value === 0) {
    // The one place a confident zero is printed. It carries the scope of the
    // claim and every disclosed gap, because a zero on its own is the defect
    // this rebuild was called to remove.
    //
    // This count is distinct people, and evidence that could not be tied to a
    // person is deliberately excluded from it. So a zero can sit beside real
    // findings — three mailboxes forwarding externally with no proven owner is
    // exactly that state — and a zero presented as the whole answer would show
    // an exfiltrating tenant as a clean one.
    const empty = riskAssessmentEmptyPresentation(assessment)
    const baseCaption =
      empty?.detail ??
      'HawkView reported no users with a current finding. This covers only the checks below and their reported windows; it does not establish that any user is safe.'
    const findingsWithoutPeople = known.length > 0
    // A zero invites exactly one question: out of how many? The contract
    // carries no identity population, so the honest answer is that this
    // qualifies the checks that ran rather than the people they covered.
    // Said plainly here rather than left to be inferred from the per-check
    // figures further down, which have no denominator either.
    const zeroGaps = [
      ...gaps,
      'HawkView has not reported how many identities in this tenant were in scope, so this is a statement about the checks that ran, not a proportion of your people',
    ]
    return {
      accuracy: 'EXACT',
      value: 0,
      display: '0',
      accessibleValue: '0',
      headline: findingsWithoutPeople
        ? 'No risky users identified — but there are findings'
        : (empty?.label ?? 'No risky users reported'),
      caption: findingsWithoutPeople
        ? `This counts people, and none of the evidence below could be tied to one. It is not a finding count and it is not an all-clear: HawkView did report evidence on this tenant, listed beside this number and below. ${baseCaption}`
        : baseCaption,
      reasons: [],
      known,
      gaps: zeroGaps,
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
    reasons: [],
    known,
    gaps,
    asOf: reported.asOf,
  }
}
