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
} from './risky-users-view'
import { signalTitle } from './presentation'
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

export function detectorTitle(detectorId: string): string {
  return (
    detectorTitles[detectorId] ??
    'A check this build of HawkView does not recognise'
  )
}

function subjectLabel(subject: {
  kind: string
  ref: string
  displayName: string | null
}): string {
  // A row showing a priority, a count and a date against an unresolvable
  // reference is worse than an empty row, because it looks complete: a
  // technician scans it, assumes the name is truncated or off-screen, and
  // moves on. The absence is stated in the row, in words.
  return subject.displayName ?? 'Identity not resolved'
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
        : 'Distinct users with at least one current HawkView finding. A user with several findings is counted once. These are investigation leads, not confirmed compromise.',
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
      name: subjectLabel(finding.subject),
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

  rows.sort((a, b) => {
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
