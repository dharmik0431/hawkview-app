'use client'

import { AlertTriangle, CheckCircle2, Clock3, Cloud, RefreshCw, Settings } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import {
  formatTenantTimestamp,
  statusTone,
  type TenantWorkspaceDisplay,
} from '@/lib/tenant-workspace-state'

export function TenantHeader({
  tenant,
  display,
  tenantId,
  syncing,
  onRefresh,
}: {
  tenant: any
  display: TenantWorkspaceDisplay
  tenantId: string
  syncing: boolean
  onRefresh: () => void
}) {
  return (
    <header className="mb-5 border-b border-slate-200 pb-4 dark:border-slate-800">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{tenant?.name || 'Microsoft 365 tenant'}</h1>
            <span className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold', statusTone(display.state))}>
              {display.state === 'healthy' ? <CheckCircle2 className="h-3.5 w-3.5" /> : display.state === 'syncing' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              {display.stateLabel}
            </span>
          </div>
          <p className="mt-1 truncate text-sm text-slate-500 dark:text-slate-400">{tenant?.domain || 'Primary domain unavailable'}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onRefresh} disabled={syncing} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800" aria-label={syncing ? 'Tenant synchronization in progress' : 'Synchronize tenant now'}>
            <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} />
            <span className="hidden sm:inline">{syncing ? 'Syncing' : 'Sync now'}</span>
          </button>
          <Link href={`/tenants/${tenantId}/settings`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800">
            <Settings className="h-4 w-4" /><span className="hidden sm:inline">Tenant settings</span>
          </Link>
        </div>
      </div>

      <dl className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="flex items-center gap-2 text-sm"><Cloud className="h-4 w-4 text-slate-400" /><div><dt className="sr-only">Connection</dt><dd className="font-medium">{display.connectionLabel}</dd></div></div>
        <div className="flex items-center gap-2 text-sm"><Clock3 className="h-4 w-4 text-slate-400" /><div><dt className="sr-only">Last successful synchronization</dt><dd><span className="text-slate-500 dark:text-slate-400">Last success: </span>{formatTenantTimestamp(display.lastSuccessfulSync)}</dd></div></div>
        <div className="text-sm"><dt className="sr-only">Data completeness</dt><dd><span className="text-slate-500 dark:text-slate-400">Data: </span>{display.state === 'partially-synchronized' ? 'Partial' : display.isInitialSync ? 'Populating progressively' : display.isStale ? 'Last known values' : 'Current'}</dd></div>
        <div className="text-sm"><dt className="sr-only">Actionable issues</dt><dd><span className="text-slate-500 dark:text-slate-400">Actionable issues: </span><span className={display.issueCount ? 'font-semibold text-amber-700 dark:text-amber-300' : 'font-semibold'}>{display.issueCount}</span></dd></div>
      </dl>

      {display.isInitialSync && <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"><strong>Tenant connected.</strong> Initial synchronization is running; modules will populate progressively.</div>}
      {display.issues.length > 0 && <div className="mt-4 flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"><strong>{display.issueCount} item{display.issueCount === 1 ? '' : 's'} require attention</strong><span>{display.issues.slice(0, 2).map((issue) => `${issue.service}: ${issue.title}`).join(' • ')}</span></div>}
    </header>
  )
}
