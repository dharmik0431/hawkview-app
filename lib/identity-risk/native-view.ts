/**
 * The native response projected into what the Risky Users screen renders.
 *
 * Deliberately NOT projected through RiskAssessment. The old envelope carries
 * twenty-two fields per finding and this engine serves three, so filling the
 * rest would mean inventing a title, a priority, a confidence and a set of
 * recommended actions for findings that have none. That is the lossy mapping
 * the separate endpoint exists to remove, arriving by the back door.
 *
 * So the screen renders less, and says so. Every element that existed only
 * because the old envelope supplied it is replaced by a stated absence rather
 * than a blank: a blank is read as nothing-to-report, which on this surface is
 * the one reading that must never be available by accident.
 */
import {
  nativeWithheldReasonCopy,
  riskyUserPriorityLabel,
  type RiskyUserCount,
  type RiskyUserList,
  type RiskyUserReason,
  type RiskyUserRow,
} from './risky-users-view.ts'
import { signalTitle } from './presentation.ts'
import type { NativeAssessment } from './native-assessment'

/**
 * What this build calls each detector on screen.
 *
 * The client holds the human copy, as it does for signal names, and for the
 * same reason: the engine holds no Microsoft vocabulary and should not learn
 * one. A detector this build does not know is named as unrecognised rather
 * than by its identifier -- an identifier is not something a technician can
 * act on, and printing it invites the reading that it is a name.
 */
const detectorTitles: Record<string, string> = {
  'credential-failure': 'Repeated credential failures',
  'external-mailbox-forwarding': 'External mailbox forwarding',
}

/**
 * What a technician does about each detector's findings.
 *
 * Static, keyed on the detector, and written here rather than served. The
 * guidance for "repeated credential failures" is the same for every instance
 * of it, so it is copy rather than per-finding data and needs no endpoint
 * change.
 *
 * A screen reading "gary@ -- 366 lockouts -- 10 Sept" delivers the half of the
 * product that says what we found and drops the half that says what to do
 * about it. Both halves are the product.
 *
 * Phrased as investigation steps rather than instructions, and attributed to
 * nobody: HawkView reads, and every one of these is carried out in Microsoft's
 * own tools. A detector this build does not know says so rather than offering
 * a neighbour's steps, because guidance for the wrong finding is worse than
 * none.
 */
const detectorGuidance: Record<string, readonly string[]> = {
  'credential-failure': [
    'Confirm with the account owner whether the sign-in attempts were theirs.',
    'Check for an application or device holding an outdated password, which produces repeated failures without anyone attacking anything.',
    'If the failures were followed by a success, review that sign-in specifically rather than the failures.',
  ],
  'external-mailbox-forwarding': [
    'Confirm with the mailbox owner whether the forwarding was set up deliberately.',
    'List hidden inbox rules as well as visible ones; a forwarding rule created by an attacker is a common thing to miss.',
    'Check when the rule was created against when the account last changed its password.',
  ],
}

export function detectorGuidanceFor(detectorId: string): readonly string[] {
  return detectorGuidance[detectorId] ?? []
}

export function detectorTitle(detectorId: string): string {
  return (
    detectorTitles[detectorId] ??
    'A check this build of HawkView does not recognise'
  )
}

/**
 * What to call the subject of a row, given that a missing name has two causes
 * and they are not interchangeable.
 *
 * "Identity not resolved" is a statement about HawkView's own capability -- we
 * looked and could not tell who this is. It is true only when this response
 * names people and this particular subject had no directory row. When the
 * response names nobody, it is a permission boundary, and printing our own
 * failure there is a false claim about ourselves on every row at once.
 *
 * The two were merged until a payload arrived carrying names and every row
 * said the identity could not be resolved. That is a worse outcome than the
 * opaque handle it replaced, because the handle at least invited the question
 * rather than answering it wrongly.
 *
 * A row is still never left as a bare reference a reader takes for a truncated
 * name: the absence is stated in words either way, and which words is the
 * whole point.
 */
function subjectLabel(
  subject: { kind: string; ref: string; displayName: string | null },
  subjectsNamed: boolean
): string {
  if (subject.displayName) return subject.displayName
  return subjectsNamed
    ? 'Identity not resolved'
    : 'Name not shown for your role'
}

function reasonsOf(finding: {
  detectorId: string
  signals: {
    signal: string
    count: number
    latest: { at: string } | null
    capped: boolean
  }[]
}): RiskyUserReason[] {
  return finding.signals.map((signal) => ({
    title: signalTitle(signal.signal),
    signal: signal.signal,
    kind: null,
    ruleId: finding.detectorId,
    evidenceCount: signal.count,
    evidenceCountCapped: signal.capped,
    firstSeen: null,
    lastSeen: signal.latest?.at ?? null,
  }))
}

/**
 * The sentence a count may never appear without.
 *
 * EXACT here means exact over the events we cited a basis for -- the scope
 * travels inside Count and there is no code path producing the figure without
 * it. That is a structural guarantee about the data, and it says nothing about
 * a card that prints "4". The guarantee is spent at the last inch, and this is
 * the last inch.
 *
 * The two set-aside kinds are never summed into one number. Fourteen consent
 * prompts we read, identified and are holding for want of our own written
 * basis is a paperwork gap: bounded, named, enumerable. A hundred and twelve
 * events we could not interpret at all is wrong by an unbounded amount in an
 * uncharacterised direction. One word for both would make a tenant with an
 * interpretation failure indistinguishable from one with a filing problem.
 */
function scopeSentence(native: Extract<NativeAssessment, { available: true }>) {
  const notYetCited = native.coverage.reduce(
    (total, entry) => total + entry.notYetCitedEvents,
    0
  )
  const uninterpreted = native.coverage.reduce(
    (total, entry) => total + entry.uninterpretedEvents,
    0
  )
  const parts: string[] = []
  if (notYetCited > 0) {
    parts.push(
      notYetCited.toLocaleString() +
        (notYetCited === 1
          ? ' event held pending a citation'
          : ' events held pending a citation')
    )
  }
  if (uninterpreted > 0) {
    parts.push(
      uninterpreted.toLocaleString() +
        (uninterpreted === 1
          ? ' event could not be interpreted'
          : ' events could not be interpreted')
    )
  }
  if (native.coverage.length === 0) {
    // Not a pass. A response that does not say what it examined cannot support
    // a reading of the figure as covering anything in particular.
    return 'This response did not report what it examined, so the figure above cannot be read as covering any particular scope.'
  }
  if (parts.length === 0) {
    return 'Every event this run examined was either assessed or accounted for.'
  }
  return (
    'Exact over the events HawkView cited a basis for. Also on this tenant: ' +
    parts.join(', ') +
    '.'
  )
}

/** The count tile, from the native count and the reasons behind it. */
export function nativeRiskyUserCount(
  native: NativeAssessment | null
): RiskyUserCount {
  if (!native || !native.available) {
    return {
      accuracy: 'UNAVAILABLE',
      value: null,
      display: 'Not available',
      accessibleValue: 'Not available',
      headline: 'No current assessment',
      caption:
        'HawkView has no assessment to show for this tenant. This is not a zero and it is not an all-clear.',
      reasons: [],
      known: [],
      gaps: [],
      asOf: null,
      listCoverage: 'COMPLETE',
      findingsUndelivered: false,
    } as RiskyUserCount
  }

  // Every reason the tenant total was withheld, and every detector that could
  // not run, each in its own words. One shown where several hold reads as the
  // reason, which is the same defect as any other true sentence standing in
  // for the ones beside it.
  const reasons = [
    ...native.withheld.map((entry) => nativeWithheldReasonCopy(entry.because)),
    ...native.count.notCovered.map((entry) =>
      nativeWithheldReasonCopy(entry.because)
    ),
  ]
  const captions = Array.from(new Set(reasons.map((copy) => copy.caption)))

  const delivered = new Set(native.findings.map((item) => item.subject.ref))
    .size
  const counted =
    native.count.accuracy !== 'NOT_AVAILABLE' &&
    native.count.value !== null &&
    native.count.value > 0
  const moreExist =
    !native.complete || (counted && (native.count.value as number) > delivered)

  const accuracy =
    native.count.accuracy === 'NOT_AVAILABLE'
      ? 'WITHHELD'
      : native.count.accuracy
  const value = native.count.value

  return {
    accuracy,
    value,
    display:
      value === null
        ? 'Not counted'
        : accuracy === 'AT_LEAST'
          ? `≥${value.toLocaleString()}`
          : value.toLocaleString(),
    accessibleValue:
      value === null
        ? 'Not counted'
        : accuracy === 'AT_LEAST'
          ? `At least ${value.toLocaleString()}`
          : value.toLocaleString(),
    headline:
      value === null
        ? captions.length === 1
          ? reasons[0].headline
          : `Not counted — ${captions.length} reasons`
        : accuracy === 'AT_LEAST'
          ? 'Risky users, at least'
          : 'Risky users',
    caption:
      value === null
        ? captions.length === 1
          ? reasons[0].caption
          : 'HawkView will not state a number of users for this tenant. Every reason it gave is listed below; each one on its own is enough to withhold the total.'
        : 'Distinct users with at least one current HawkView finding. A user with several findings is counted once. These are investigation leads, not confirmed compromise. ' +
          scopeSentence(native),
    reasons: captions,
    // The detectors that did run, so a number is never read as covering checks
    // that never executed.
    known: native.count.covered.map(detectorTitle),
    gaps: native.count.notCovered.map(
      (entry) =>
        `${detectorTitle(entry.detectorId)}: ${nativeWithheldReasonCopy(entry.because).headline}`
    ),
    asOf: native.run.completedAt,
    listCoverage:
      counted && delivered === 0
        ? 'NONE_DELIVERED'
        : moreExist && delivered > 0
          ? 'PARTIAL'
          : 'COMPLETE',
  } as RiskyUserCount
}

/**
 * The list, one row per subject, one reason per signal.
 *
 * No priority and no priority sort, because the engine does not emit one.
 * Ordering falls back to recency of any reason, which is stated in the column
 * heading rather than implied -- a list that looks ranked and is not would let
 * a technician read position as severity.
 */
export function nativeRiskyUserList(
  native: NativeAssessment | null
): RiskyUserList {
  if (!native || !native.available) return { rows: [], context: [] }

  const bySubject = new Map<string, RiskyUserRow>()
  for (const finding of native.findings) {
    const key = finding.subject.ref
    const existing = bySubject.get(key)
    const reasons = reasonsOf(finding)
    if (existing) {
      existing.reasons = [...existing.reasons, ...reasons]
      continue
    }
    bySubject.set(key, {
      id: key,
      name: subjectLabel(finding.subject, native.subjectsNamed),
      email: finding.subject.userPrincipalName,
      reference: key,
      subjectType: finding.subject.kind === 'MAILBOX' ? 'MAILBOX' : 'USER',
      // The engine does not rate its own findings, so nothing here may look
      // like a rating. Not ranked is the honest label and it is shown.
      priority: null,
      priorityLabel: riskyUserPriorityLabel(null),
      lastSeen: null,
      lastSeenFrom: null,
      lastSeenState: 'NO_REASONS',
      reasons,
      detection: {
        microsoft: 'NOT_COMPARABLE',
        label: 'HawkView',
        detail: 'HawkView — Microsoft is not compared on this response',
        microsoftRecord: null,
      },
      protection: {
        label: 'Protection not reported on this response',
        tone: 'unknown',
      },
      // Kept null deliberately: the detail view is built on fields this
      // response does not carry, so there is nothing to open. A row that
      // offered a detail view and then showed an empty one would be worse
      // than a row that says there is none.
      user: null,
    } as unknown as RiskyUserRow)
  }

  const rows = Array.from(bySubject.values())
  for (const row of rows) {
    const dated = row.reasons.filter(
      (
        reason: RiskyUserReason
      ): reason is RiskyUserReason & { lastSeen: string } =>
        reason.lastSeen !== null
    )
    const latest = [...dated]
      .sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))
      .at(-1)
    row.lastSeenFrom = latest ?? null
    row.lastSeen = latest?.lastSeen ?? null
    row.lastSeenState =
      row.lastSeen !== null
        ? 'DATED'
        : row.reasons.length > 0
          ? 'DATELESS'
          : 'NO_REASONS'
  }

  // Ordered by volume, not by a judgement.
  //
  // The engine rates nothing, and inventing a priority to sort on would be
  // re-creating the vocabulary this rebuild removed, in a different font. A
  // lockout count is a fact: it puts 366 above 27 without anyone claiming to
  // have ranked risk, and a reader who checks the order against the numbers
  // can see exactly what it is.
  //
  // Lockouts lead because an account being locked out repeatedly is a stronger
  // reason to look than a password being rejected, and rejections break the
  // tie. Recency breaks the remaining tie rather than leading, because a read
  // time is always recent and would float state-derived rows to the top.
  const volume = (row: RiskyUserRow, signal: string) =>
    row.reasons
      .filter((reason: RiskyUserReason) => reason.signal === signal)
      .reduce(
        (total: number, reason: RiskyUserReason) =>
          total + reason.evidenceCount,
        0
      )
  rows.sort((a, b) => {
    const lockouts =
      volume(b, 'LOCKED_OUT_AFTER_REPEATED_FAILURES') -
      volume(a, 'LOCKED_OUT_AFTER_REPEATED_FAILURES')
    if (lockouts !== 0) return lockouts
    const rejections =
      volume(b, 'PASSWORD_REJECTED') - volume(a, 'PASSWORD_REJECTED')
    if (rejections !== 0) return rejections
    if (a.lastSeen === b.lastSeen) return 0
    if (a.lastSeen === null) return 1
    if (b.lastSeen === null) return -1
    return b.lastSeen.localeCompare(a.lastSeen)
  })

  // Mailbox evidence is never counted as a person, so it sits apart from the
  // list the count counts, exactly as it does on the old path.
  return {
    rows: rows.filter((row) => row.subjectType === 'USER'),
    context: rows.filter((row) => row.subjectType === 'MAILBOX'),
  }
}
