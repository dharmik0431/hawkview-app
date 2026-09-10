'use client'

import { useCallback, useState } from 'react'
import {
  ChevronRight,
  Info,
  RefreshCw,
  ShieldAlert,
  ShieldOff,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useRiskyUsers } from '@/lib/api/risky-users-hooks'
import {
  findingEvidenceShape,
  findingEvidenceSummary,
  microsoftRiskyUserCountPresentation,
  riskReadinessLabel,
  riskSourceLabel,
} from '@/lib/identity-risk/presentation'
import {
  detectedByLabel,
  microsoftDetectionSummary,
  microsoftLevelsHidden,
  microsoftRecordsByPolarity,
  microsoftRiskLevelLabel,
  microsoftVerdictDetail,
  microsoftVerdictPolarity,
} from '@/lib/identity-risk/risky-users-view'
import type {
  MicrosoftChannel,
  MicrosoftVerdictPolarity,
  RiskyUserCount,
  RiskyUserReason,
  RiskyUserRow,
} from '@/lib/identity-risk/risky-users-view'
import type {
  MicrosoftEntraRiskyUser,
  MicrosoftEntraRiskyUsersView,
  RiskAssessment,
} from '@/lib/identity-risk/types'
import { cn } from '@/lib/utils'
import { RiskAssessmentDrawer } from './risk-assessment-drawer'

function time(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Not reported'
}

/**
 * One reason, with its own count and its own recency, in the unit that reason
 * actually counts.
 *
 * Two reasons on one row never share a date, and neither shares a noun. A
 * repeated-failure reason counts events and its date is when the last one
 * happened; the mailbox reason counts destinations a mailbox is configured to
 * forward to and its date is when the setting was read. Both readings are
 * supplied by findingEvidenceSummary, which is also the only place that decides
 * a rule it does not recognise gets no reading at all.
 */
function ReasonLine({ reason }: { reason: RiskyUserReason }) {
  const evidence = findingEvidenceSummary(reason, time)
  return (
    <li className="text-xs text-slate-600 dark:text-slate-300">
      {reason.title}
      <span className="block text-slate-500 dark:text-slate-400">
        {evidence.note ?? [evidence.count, evidence.timing].join(', ')}
      </span>
    </li>
  )
}

/**
 * HawkView identifies a subject by a 64-character tenant-keyed pseudonym. Shown
 * in full it takes three lines and crowds out the name and the reasons, which
 * are what a technician actually reads. Shown short it still distinguishes two
 * users with the same display name, and the full value stays available to copy.
 */
function shortReference(reference: string) {
  const match = reference.match(/^(hvr1_[a-z]+_)([0-9a-f]{64})$/)
  return match ? `${match[1]}${match[2].slice(0, 10)}…` : reference
}

/* -------------------------------------------------------------------------- */

/**
 * The Microsoft channel is shown whether or not it is reporting. On a tenant
 * without Entra ID P2 this panel is the whole answer to "why does every row
 * say HawkView?", and it tells the MSP what licensing the tenant would add.
 */
function MicrosoftChannelPanel({
  channel,
  view,
}: {
  channel: MicrosoftChannel
  view: MicrosoftEntraRiskyUsersView
}) {
  const reporting = channel.state === 'REPORTING'
  return (
    <section
      aria-labelledby="microsoft-channel-heading"
      className={cn(
        'rounded-xl border p-5 shadow-2xs',
        reporting
          ? 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
          : 'border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/60'
      )}
    >
      <div className="flex gap-3">
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            reporting
              ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
              : 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
          )}
        >
          {reporting ? (
            <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          ) : (
            <ShieldOff className="h-5 w-5" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              id="microsoft-channel-heading"
              className="text-sm font-semibold text-slate-900 dark:text-slate-50"
            >
              Microsoft Entra Identity Protection
            </h3>
            {channel.addressable && (
              <Badge
                variant="outline"
                className="border-blue-200 text-blue-700 dark:border-blue-800 dark:text-blue-300"
              >
                Available with a change you control
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm font-medium text-slate-800 dark:text-slate-200">
            {channel.headline}
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
            {channel.detail}
          </p>
          {channel.observedAt && (
            <p className="mt-2 text-xs text-slate-500">
              Microsoft last observed {time(channel.observedAt)}
            </p>
          )}
        </div>
      </div>
      <MicrosoftRecords view={view} />
    </section>
  )
}

const microsoftRiskStateLabel: Readonly<
  Record<MicrosoftEntraRiskyUser['riskState'], string>
> = {
  none: 'None',
  atRisk: 'At risk',
  remediated: 'Remediated',
  dismissed: 'Dismissed',
  confirmedSafe: 'Confirmed safe',
  confirmedCompromised: 'Confirmed compromised',
  unknownFutureValue: 'Reported by Microsoft, state not recognised',
}

/**
 * Microsoft's own records, in Microsoft's own vocabulary, under Microsoft's own
 * heading. They are deliberately not folded into the list above: HawkView
 * identifies a subject by tenant-keyed pseudonym and Microsoft by directory
 * object, and without a key both sides agree on, merging the two lists would
 * either invent a correspondence or silently drop records. Keeping them apart
 * is what preserves which system said what.
 */
const polarityGroups: ReadonlyArray<{
  polarity: MicrosoftVerdictPolarity
  heading: string
  note: string
}> = [
  {
    polarity: 'ACTIVE_RISK',
    heading: 'Users Microsoft currently considers at risk',
    note: 'Microsoft’s present assessment of the person, drawn from all of its own telemetry.',
  },
  {
    polarity: 'CLOSED',
    heading: 'Users Microsoft has closed',
    note: 'Microsoft has remediated or dismissed these. Its automatic remediation lands in the dismissed state, so a dismissal here is not necessarily someone waving it away — the detail names who or what closed it.',
  },
  {
    polarity: 'CLEARED',
    heading: 'Users Microsoft currently considers safe',
    note: 'These are Microsoft clearing a person or a sign-in, not Microsoft flagging one. They are listed for completeness and are not findings.',
  },
  {
    polarity: 'UNRECOGNISED',
    heading: 'Users whose Microsoft state this client does not recognise',
    note: 'Microsoft reported something HawkView has not learned to read. It is shown as unrecognised rather than assumed to be a risk.',
  },
]

function MicrosoftRecordTable({
  users,
  caption,
}: {
  users: MicrosoftEntraRiskyUser[]
  caption: string
}) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <th scope="col" className="px-3 py-2 font-semibold">
              Identity
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Microsoft confidence
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              What Microsoft concluded
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Observed
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => {
            const detail = microsoftVerdictDetail(user)
            const polarity = microsoftVerdictPolarity(user)
            // Microsoft can report a risk state and a superseding safe
            // conclusion on the same record. Printing the state alone under a
            // "concluded safe" heading would contradict the heading, so the row
            // says which of the two governs.
            const superseded =
              polarity === 'CLEARED' &&
              (user.riskState === 'atRisk' ||
                user.riskState === 'confirmedCompromised')
            return (
              <tr
                key={user.id}
                className="border-b border-slate-100 align-top last:border-0 dark:border-slate-800/70"
              >
                <td className="px-3 py-2.5 text-sm font-medium text-slate-900 dark:text-slate-50">
                  {user.identityLabel}
                </td>
                <td className="px-3 py-2.5 text-sm text-slate-700 dark:text-slate-300">
                  {microsoftRiskLevelLabel(user.riskLevel)}
                </td>
                <td className="px-3 py-2.5 text-sm text-slate-700 dark:text-slate-300">
                  {microsoftRiskStateLabel[user.riskState]}
                  {superseded && (
                    <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                      superseded by the conclusion below
                    </span>
                  )}
                  {detail && (
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {detail}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-sm text-slate-700 dark:text-slate-300">
                  {time(user.observedAt)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function MicrosoftRecords({ view }: { view: MicrosoftEntraRiskyUsersView }) {
  const reporting =
    view.meta.status === 'AVAILABLE' || view.meta.status === 'STALE'

  // A reporting channel with no records is a result, not an absence. Returning
  // null here rendered "Microsoft is reporting on this tenant" followed by
  // nothing, which reads the same as having failed to fetch its records — and
  // hid the one statement that distinguishes them. microsoftRiskyUserCount
  // Presentation already separates an authoritative empty snapshot from an
  // unconfirmed one; this surface simply never reached it.
  if (!view.users || view.users.length === 0) {
    if (!reporting) return null
    const empty = microsoftRiskyUserCountPresentation(view)
    return (
      <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
          {empty.label}
        </h4>
        <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
          {empty.detail}
        </p>
      </div>
    )
  }
  const count = microsoftRiskyUserCountPresentation(view)
  const groups = microsoftRecordsByPolarity(view)
  return (
    <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
          {count.label}
        </h4>
        <p className="text-sm font-semibold text-slate-900 dark:text-white">
          <span aria-hidden="true">{count.value}</span>
          <span className="sr-only">{count.accessibleValue}</span>
        </p>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
        {count.detail} These answer one question — which people Microsoft
        considers at risk <em>now</em>, from telemetry HawkView cannot see. They
        are Microsoft&rsquo;s determinations and are never added to, or
        subtracted from, the HawkView count above. Microsoft&rsquo;s level is a
        confidence scale rather than a severity one: <em>high</em> means
        Microsoft is confident, not that the impact is large.
      </p>
      {microsoftLevelsHidden(view) && (
        <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
          Microsoft is withholding the risk level on some of these records
          because this tenant is not licensed for Entra ID P2. That is Microsoft
          declining to show the level of a risk it detected — not an absence of
          risk.
        </p>
      )}
      {polarityGroups.map(({ polarity, heading, note }) => {
        const users = groups[polarity]
        if (users.length === 0) return null
        return (
          <section key={polarity} className="mt-4">
            <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {heading} ({users.length})
            </h5>
            <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {note}
            </p>
            <MicrosoftRecordTable users={users} caption={heading} />
          </section>
        )
      })}
      {view.pageInfo?.hasMore && (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
          More Microsoft records exist than were read into this page, so this is
          an incomplete result set rather than Microsoft&rsquo;s full total.
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Two systems reporting the same person is the strongest signal this product
 * produces, so it gets both badges. It does not assert that they reached it
 * independently: Microsoft's sign-in-derived verdicts read the same log lines
 * HawkView does, so agreement can be two readings of one piece of evidence. Everything else says which of
 * three different things is true — Microsoft looked and did not report them,
 * Microsoft could not be compared to them, or Microsoft cannot report on this
 * tenant at all — because they lead a technician to different places.
 */
function DetectedBy({ row }: { row: RiskyUserRow }) {
  const microsoft = row.detection.microsoft
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge
        variant="outline"
        className="border-blue-200 text-blue-700 dark:border-blue-800 dark:text-blue-300"
      >
        HawkView
      </Badge>
      {microsoft === 'REPORTED' ? (
        <Badge
          variant="outline"
          className="border-violet-200 text-violet-700 dark:border-violet-800 dark:text-violet-300"
        >
          Microsoft
        </Badge>
      ) : (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {microsoftDetectionSummary(row.detection)}
        </span>
      )}
      {row.detection.microsoftRecord && (
        <span className="block w-full text-xs text-slate-600 dark:text-slate-300">
          Microsoft says:{' '}
          {microsoftRiskStateLabel[row.detection.microsoftRecord.riskState]} ·{' '}
          {microsoftRiskLevelLabel(row.detection.microsoftRecord.riskLevel)}
        </span>
      )}
      <span className="sr-only">{detectedByLabel(row.detection)}</span>
    </div>
  )
}

function PriorityBadge({ row }: { row: RiskyUserRow }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        row.priority === 'HIGH' &&
          'border-red-200 text-red-700 dark:border-red-900 dark:text-red-300',
        row.priority === 'MEDIUM' &&
          'border-amber-200 text-amber-800 dark:border-amber-900 dark:text-amber-300',
        row.priority === 'LOW' &&
          'border-slate-200 text-slate-700 dark:border-slate-700 dark:text-slate-300'
      )}
    >
      {row.priorityLabel}
    </Badge>
  )
}

function UserRows({
  rows,
  onOpen,
  caption,
}: {
  rows: RiskyUserRow[]
  onOpen: (row: RiskyUserRow) => void
  caption: string
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <th scope="col" className="px-3 py-2 font-semibold">
              User
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Detected by
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              HawkView priority
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Latest of any reason
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              <span className="sr-only">Open detail</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-slate-100 align-top last:border-0 dark:border-slate-800/70"
            >
              <td className="px-3 py-3">
                <p className="break-words text-sm font-semibold text-slate-900 dark:text-slate-50">
                  {row.name}
                </p>
                <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
                  {row.subjectType === 'MAILBOX' ? 'Mailbox' : 'User account'}
                </p>
                <p
                  className="mt-0.5 break-all font-mono text-xs text-slate-500 dark:text-slate-400"
                  title={row.email ?? row.reference}
                >
                  {row.email ?? shortReference(row.reference)}
                </p>
                <ul className="mt-1.5 space-y-1">
                  {row.reasons.map((reason) => (
                    <ReasonLine key={reason.title} reason={reason} />
                  ))}
                </ul>
              </td>
              <td className="px-3 py-3">
                <DetectedBy row={row} />
              </td>
              <td className="px-3 py-3">
                <PriorityBadge row={row} />
                {row.detection.microsoftRecord && (
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    HawkView&rsquo;s rating of its own finding. Microsoft rates
                    this person separately, in the cell to the left.
                  </p>
                )}
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {row.protection.label}
                </p>
              </td>
              <td className="px-3 py-3 text-sm text-slate-700 dark:text-slate-300">
                {time(row.lastSeen)}
                {row.lastSeenFrom &&
                  findingEvidenceShape(row.lastSeenFrom.ruleId).kind !==
                    'OCCURRENCES' && (
                    <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                      when HawkView read a setting, not when anything happened
                    </span>
                  )}
              </td>
              <td className="px-3 py-3 text-right">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onOpen(row)}
                  aria-haspopup="dialog"
                >
                  Investigate
                  <span className="sr-only"> {row.name}</span>
                  <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * What the count is standing on. Kept beside the list rather than hidden, so a
 * zero and a full list are read against the same disclosed coverage.
 */
function Coverage({ assessment }: { assessment: RiskAssessment }) {
  return (
    <details className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-slate-800 dark:bg-slate-900">
      <summary className="cursor-pointer text-sm font-semibold text-slate-900 dark:text-slate-50">
        What HawkView checked, and how current the evidence is
      </summary>
      <div className="mt-3 space-y-4">
        <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
          These are counts of what each check evaluated. HawkView does not
          report how many identities exist in this tenant, so they are not a
          proportion of your people and two checks may have evaluated different
          populations.
        </p>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Checks
          </h4>
          <ul className="mt-1.5 space-y-1.5">
            {assessment.rules.map((rule) => (
              <li key={rule.ruleId} className="text-sm">
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  {rule.title}
                </span>{' '}
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  · {riskReadinessLabel(rule.status)} ·{' '}
                  {riskSourceLabel(rule.selectedSource)} ·{' '}
                  {rule.assessedIdentities === null
                    ? 'identities evaluated not reported'
                    : `${rule.assessedIdentities.toLocaleString()} identities evaluated by this check${
                        rule.countsCapped ? ' (capped)' : ''
                      }`}
                </span>
                <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
                  {rule.explanation}
                </p>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Evidence sources
          </h4>
          <ul className="mt-1.5 space-y-1.5">
            {assessment.sources.map((source) => (
              <li key={source.source} className="text-sm">
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  {riskSourceLabel(source.source)}
                </span>{' '}
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  · {riskReadinessLabel(source.status)} · window{' '}
                  {time(source.window.start)} – {time(source.window.end)}
                </span>
                <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
                  {source.explanation}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * An empty user list means different things depending on why the count is what
 * it is. "No user is listed as needing attention" is only true when HawkView
 * actually counted; when the count was withheld because findings could not be
 * attributed to people, the same sentence would quietly answer the question the
 * count just refused to answer.
 */
function EmptyUserList({ count }: { count: RiskyUserCount }) {
  // "No user needs attention" is only true when HawkView both counted and
  // found nothing. Beside a withheld count, or beside a zero that counts people
  // while mailbox evidence sits below, the same sentence quietly answers a
  // question the number did not.
  const copy =
    count.accuracy === 'WITHHELD'
      ? count.known.length > 0
        ? 'No finding could be attributed to a specific user, so no user is listed here. That is not the same as no user needing attention — what HawkView did find is listed above and below.'
        : 'HawkView is not stating a number of users for this tenant, and no finding has been attributed to a specific user. Read this as an open question rather than an all-clear.'
      : count.accuracy === 'UNAVAILABLE'
        ? 'No current list can be shown. This is not an empty result, and nothing here has been checked and cleared.'
        : count.known.length > 0
          ? 'No finding was tied to a specific user, so no user is listed here. HawkView did find evidence on this tenant — it is listed above and below, and it is not an all-clear.'
          : 'No user is listed as needing attention right now. The summary above states what that is based on and what it does not cover.'
  return (
    <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
      {copy}
    </p>
  )
}

/**
 * When more than one thing stopped HawkView counting, all of them are listed.
 * The headline goes neutral in that case rather than picking one, because a
 * single reason shown where several hold reads as the reason.
 */
function CountReasons({ reasons }: { reasons: RiskyUserCount['reasons'] }) {
  if (reasons.length < 2) return null
  return (
    <ul className="mt-3 space-y-2">
      {reasons.map((reason) => (
        <li
          key={reason}
          className="rounded-lg border border-slate-200 bg-white p-3 text-sm leading-relaxed text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
        >
          {reason}
        </li>
      ))}
    </ul>
  )
}

function CountSummary({ count }: { count: RiskyUserCount }) {
  return (
    <section
      aria-labelledby="risky-users-total-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2
          id="risky-users-total-heading"
          className="text-sm font-semibold text-slate-900 dark:text-slate-50"
        >
          {count.headline}
        </h2>
        {count.value === null ? (
          <p
            className="text-base font-semibold leading-none text-slate-600 dark:text-slate-300"
            aria-hidden="true"
          >
            {count.display}
          </p>
        ) : (
          <p
            className="text-[28px] font-semibold leading-none text-slate-900 dark:text-white"
            aria-hidden="true"
          >
            {count.display}
          </p>
        )}
        <p className="sr-only">{count.accessibleValue}</p>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        {count.caption}
      </p>
      <CountReasons reasons={count.reasons} />
      {count.known.length > 0 &&
        (count.value === 0 || count.value === null) && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              What HawkView did find
            </p>
            <ul className="mt-1.5 space-y-1">
              {count.known.map((item) => (
                <li
                  key={item}
                  className="text-sm leading-relaxed text-slate-700 dark:text-slate-300"
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      {count.gaps.length > 0 && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/40">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Not covered by this number
          </p>
          <ul className="mt-1.5 space-y-1">
            {count.gaps.map((gap) => (
              <li
                key={gap}
                className="text-sm leading-relaxed text-slate-700 dark:text-slate-300"
              >
                {gap}
              </li>
            ))}
          </ul>
        </div>
      )}
      {count.asOf && (
        <p className="mt-3 text-xs text-slate-500">
          Assessed {time(count.asOf)}
        </p>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */

export default function RiskyUsersSection({ tenantId }: { tenantId: string }) {
  const {
    assessment,
    channel,
    count,
    list,
    microsoftView,
    loading,
    requestFailed,
    contractFailed,
    cacheScope,
    retry,
  } = useRiskyUsers(tenantId)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const closeDrawer = useCallback(() => setSelectedId(null), [])
  const selectedUser =
    [...list.rows, ...list.context].find((row) => row.id === selectedId)
      ?.user ?? null

  return (
    <div className="space-y-4" key={`${cacheScope}:${tenantId}`}>
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
        <div className="flex min-w-0 gap-3">
          <Info
            className="mt-0.5 h-5 w-5 shrink-0 text-slate-500 dark:text-slate-400"
            aria-hidden="true"
          />
          <div>
            <h1 className="text-base font-semibold text-slate-950 dark:text-slate-50">
              Risky users
            </h1>
            <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              HawkView&rsquo;s own analysis of this tenant&rsquo;s identity
              evidence, kept separate from Microsoft Entra Identity Protection
              and never combined with it into a single score. Everything here is
              an investigation lead: it does not establish that a user is
              compromised, and it does not establish that a user is safe.
              HawkView makes no changes to Microsoft.
            </p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Refresh
        </Button>
      </header>

      {loading ? (
        <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-2xs dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          Loading the current assessment…
        </p>
      ) : (
        <>
          {(requestFailed || contractFailed) && (
            <div
              role="alert"
              className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
            >
              <p className="font-semibold">
                {requestFailed
                  ? 'The latest assessment could not be loaded'
                  : 'The latest response could not be read'}
              </p>
              <p className="mt-1 text-xs leading-relaxed">
                {assessment
                  ? 'Users below are from an earlier read and remain open. This failure has not resolved or dismissed any of them, and current coverage cannot be confirmed.'
                  : 'No current result can be confirmed. Missing evidence is not a no-findings result.'}
              </p>
              <p className="mt-2 font-mono text-xs">
                Support code:{' '}
                {requestFailed
                  ? 'RISK_ASSESSMENT_REQUEST_FAILED'
                  : 'RISK_ASSESSMENT_CONTRACT_INVALID'}
              </p>
            </div>
          )}

          <CountSummary count={count} />
          <MicrosoftChannelPanel channel={channel} view={microsoftView} />

          <section
            aria-labelledby="risky-users-list-heading"
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-slate-800 dark:bg-slate-900"
          >
            <h2
              id="risky-users-list-heading"
              className="text-sm font-semibold text-slate-900 dark:text-slate-50"
            >
              Users needing attention
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Ordered by HawkView&rsquo;s own investigation priority, so the
              same findings sit in the same order on every tenant whatever its
              Microsoft licensing. Within a priority, users Microsoft also
              reported come first. The two systems&rsquo; ratings are never
              combined into one score.
            </p>
            {list.rows.length > 0 ? (
              <div className="mt-3">
                <UserRows
                  rows={list.rows}
                  onOpen={(row) => setSelectedId(row.id)}
                  caption="Users with a current HawkView finding"
                />
              </div>
            ) : (
              <EmptyUserList count={count} />
            )}
          </section>

          {list.context.length > 0 && (
            <section
              aria-labelledby="risky-users-context-heading"
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-slate-800 dark:bg-slate-900"
            >
              <h2
                id="risky-users-context-heading"
                className="text-sm font-semibold text-slate-900 dark:text-slate-50"
              >
                Supporting evidence
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                Mailbox-scoped and historical evidence. It is deliberately not
                counted above, because counting it would overstate how many
                people need attention today. It is still worth reading when
                investigating.
              </p>
              <div className="mt-3">
                <UserRows
                  rows={list.context}
                  onOpen={(row) => setSelectedId(row.id)}
                  caption="Mailbox-scoped and historical evidence"
                />
              </div>
            </section>
          )}

          {assessment && <Coverage assessment={assessment} />}
        </>
      )}

      <RiskAssessmentDrawer user={selectedUser} onClose={closeDrawer} />
    </div>
  )
}
