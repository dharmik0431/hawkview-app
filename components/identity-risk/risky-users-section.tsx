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
  riskReadinessLabel,
  riskSourceLabel,
} from '@/lib/identity-risk/presentation'
import { detectedByLabel } from '@/lib/identity-risk/risky-users-view'
import type {
  MicrosoftChannel,
  RiskyUserCount,
  RiskyUserRow,
} from '@/lib/identity-risk/risky-users-view'
import type { RiskAssessment } from '@/lib/identity-risk/types'
import { cn } from '@/lib/utils'
import { RiskAssessmentDrawer } from './risk-assessment-drawer'

function time(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Not reported'
}

/* -------------------------------------------------------------------------- */

/**
 * The Microsoft channel is shown whether or not it is reporting. On a tenant
 * without Entra ID P2 this panel is the whole answer to "why does every row
 * say HawkView?", and it tells the MSP what licensing the tenant would add.
 */
function MicrosoftChannelPanel({ channel }: { channel: MicrosoftChannel }) {
  const reporting = channel.state === 'REPORTING'
  return (
    <section
      aria-labelledby="microsoft-channel-heading"
      className={cn(
        'rounded-xl border p-4',
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
    </section>
  )
}

/* -------------------------------------------------------------------------- */

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
      {microsoft === 'REPORTED' && (
        <Badge
          variant="outline"
          className="border-violet-200 text-violet-700 dark:border-violet-800 dark:text-violet-300"
        >
          Microsoft
        </Badge>
      )}
      {microsoft !== 'REPORTED' && (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {microsoft === 'NOT_REPORTED'
            ? 'Microsoft did not report this user'
            : microsoft === 'NOT_COMPARABLE'
              ? 'Microsoft not comparable'
              : 'Microsoft unavailable'}
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
              Priority
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Last seen
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
                <p className="mt-0.5 break-all text-xs text-slate-500 dark:text-slate-400">
                  {row.email ?? row.reference}
                </p>
                <ul className="mt-1.5 space-y-0.5">
                  {row.reasons.map((reason) => (
                    <li
                      key={reason}
                      className="text-xs text-slate-600 dark:text-slate-300"
                    >
                      {reason}
                    </li>
                  ))}
                </ul>
              </td>
              <td className="px-3 py-3">
                <DetectedBy row={row} />
              </td>
              <td className="px-3 py-3">
                <PriorityBadge row={row} />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {row.protection.label}
                </p>
              </td>
              <td className="px-3 py-3 text-sm text-slate-700 dark:text-slate-300">
                {time(row.lastSeen)}
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
    <details className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <summary className="cursor-pointer text-sm font-semibold text-slate-900 dark:text-slate-50">
        What HawkView checked, and how current the evidence is
      </summary>
      <div className="mt-3 space-y-4">
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
                    ? 'identities assessed not reported'
                    : `${rule.assessedIdentities.toLocaleString()} identities assessed${
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

function CountSummary({ count }: { count: RiskyUserCount }) {
  return (
    <section
      aria-labelledby="risky-users-total-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2
          id="risky-users-total-heading"
          className="text-sm font-semibold text-slate-900 dark:text-slate-50"
        >
          {count.headline}
        </h2>
        <p
          className="text-[28px] font-semibold leading-none text-slate-900 dark:text-white"
          aria-hidden="true"
        >
          {count.display}
        </p>
        <p className="sr-only">{count.accessibleValue}</p>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        {count.caption}
      </p>
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
        <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
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
          <MicrosoftChannelPanel channel={channel} />

          <section
            aria-labelledby="risky-users-list-heading"
            className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
          >
            <h2
              id="risky-users-list-heading"
              className="text-sm font-semibold text-slate-900 dark:text-slate-50"
            >
              Users needing attention
            </h2>
            {list.rows.length > 0 ? (
              <div className="mt-3">
                <UserRows
                  rows={list.rows}
                  onOpen={(row) => setSelectedId(row.id)}
                  caption="Users with a current HawkView finding"
                />
              </div>
            ) : (
              <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                No user is listed as needing attention right now. The summary
                above states what that is based on and what it does not cover.
              </p>
            )}
          </section>

          {list.context.length > 0 && (
            <section
              aria-labelledby="risky-users-context-heading"
              className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
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
