'use client'

import Link from 'next/link'
import { ShieldAlert, ChevronRight } from 'lucide-react'
import { useRiskyUsers } from '@/lib/api/risky-users-hooks'
import { tenantRiskyUsersPath } from '@/lib/tenants/navigation'
import { cn } from '@/lib/utils'

/** Compact navigation summary; detailed evidence remains on the Risky Users page. */
export function RiskyUsersOverviewRow({ tenantId }: { tenantId: string }) {
  const { count, assessmentLoading, microsoftLoading, requestFailed, contractFailed, microsoftView, channel } = useRiskyUsers(tenantId)
  const status = requestFailed ? 'Not available — assessment request failed'
    : contractFailed ? 'Not available — assessment response unreadable'
    : assessmentLoading ? 'Loading assessment…'
    : count.value === null ? count.accuracy === 'WITHHELD' ? count.headline : 'Not available — no current assessment'
    : `${count.accessibleValue} identified`
  const warnings: string[] = []
  if (!assessmentLoading) {
    if (count.known.length > 0 && (count.value === null || count.value === 0)) warnings.push('Findings present')
    if (count.gaps.length > 0 || count.accuracy === 'AT_LEAST') warnings.push('Coverage incomplete')
    if (count.listCoverage === 'PARTIAL') warnings.push('Partial findings list')
    if (count.listCoverage === 'NONE_DELIVERED') warnings.push('Findings list unavailable')
  }
  if (!microsoftLoading) {
    if (microsoftView.meta.status === 'STALE' || microsoftView.meta.freshness === 'STALE') warnings.push('Microsoft evidence stale')
    else if (channel.state === 'INTERRUPTED') warnings.push('Microsoft evidence read failed')
    else if (channel.state === 'CONTRADICTORY') warnings.push('Microsoft evidence needs review')
    else if (channel.state !== 'REPORTING') warnings.push('Microsoft evidence unavailable')
    if ((microsoftView.users?.length ?? 0) > 0) warnings.push('Microsoft risk records available')
  }
  const needsReview = requestFailed || contractFailed || (!assessmentLoading && (count.value ?? 0) > 0) || warnings.length > 0
  const asOf = count.asOf && Number.isFinite(Date.parse(count.asOf)) ? count.asOf : null

  return (
    <section
      aria-labelledby="risky-users-overview-heading"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <ShieldAlert className={cn('h-4 w-4 shrink-0', needsReview ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500')} aria-hidden="true" />
        <h2 id="risky-users-overview-heading" className="text-sm font-semibold text-slate-900 dark:text-white">Risky users</h2>
        <span role="status" className="font-medium text-slate-800 dark:text-slate-200">{status}</span>
        {!assessmentLoading && count.value !== null && <span className="text-xs text-slate-500 dark:text-slate-400">HawkView checks only</span>}
        {microsoftLoading && <span role="status" className="text-xs text-slate-500 dark:text-slate-400">Loading Microsoft evidence…</span>}
        {warnings.length > 0 && <span className="text-xs font-medium text-amber-800 dark:text-amber-300">{warnings.join(' · ')}</span>}
        {!assessmentLoading && asOf && <time dateTime={asOf} title={asOf} className="text-xs text-slate-500 dark:text-slate-400">As of {new Date(asOf).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>}
      </div>
      <Link href={tenantRiskyUsersPath(tenantId)} className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-blue-700 hover:underline dark:text-blue-300">
        Review risky users<ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </section>
  )
}
