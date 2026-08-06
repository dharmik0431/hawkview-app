'use client'

import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, Cloud, RefreshCw, Settings } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatTenantTimestamp, statusTone, type TenantWorkspaceDisplay } from '@/lib/tenant-workspace-state'

export function TenantHeader({ tenant, display, tenantId, syncing, onRefresh, tenants, onTenantChange }: {
  tenant: any
  display: TenantWorkspaceDisplay
  tenantId: string
  syncing: boolean
  onRefresh: () => void
  tenants: any[]
  onTenantChange: (tenantId: string) => void
}) {
  return (
    <header className="relative overflow-hidden bg-[var(--hv-navy-950)] px-4 py-4 text-white sm:px-5">
      <div className="pointer-events-none absolute inset-y-0 right-0 w-2/5 bg-[radial-gradient(circle_at_top_right,var(--hv-service-color),transparent_68%)] opacity-20" />
      <div className="relative">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="relative hidden sm:block">
            <select aria-label="Switch managed tenant" value={tenantId} onChange={(event) => onTenantChange(event.target.value)} className="h-10 max-w-[240px] appearance-none rounded-lg border border-slate-200 bg-white py-0 pl-3 pr-9 text-sm font-medium shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-slate-700 dark:bg-slate-900">
              {tenants.map((item) => <option key={item.id} value={item.id}>{item.name || item.domain || item.id}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
          <div className="min-w-0 border-l border-white/20 pl-3">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">{tenant?.name || 'Microsoft 365 tenant'}</h1>
              <span className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold', statusTone(display.state))}>
                {display.state === 'healthy' ? <CheckCircle2 className="h-3.5 w-3.5" /> : display.state === 'syncing' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                {display.stateLabel}
              </span>
            </div>
            <p className="mt-0.5 truncate text-sm text-slate-300">{tenant?.domain || 'Primary domain unavailable'}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onRefresh} disabled={syncing} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800" aria-label={syncing ? 'Tenant synchronization in progress' : 'Synchronize tenant now'}>
            <RefreshCw className={cn('h-4 w-4', syncing && 'animate-spin')} /><span>{syncing ? 'Syncing' : 'Sync now'}</span>
          </button>
          <Link href={`/tenants/${tenantId}/settings`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"><Settings className="h-4 w-4" /><span>Settings</span></Link>
        </div>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 border-t border-white/15 pt-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="flex items-center gap-2 text-sm"><Cloud className="h-4 w-4 text-slate-400" /><div><dt className="sr-only">Connection</dt><dd className="font-medium">{display.connectionLabel}</dd></div></div>
        <div className="flex items-center gap-2 text-sm"><Clock3 className="h-4 w-4 text-slate-400" /><div><dt className="sr-only">Last successful synchronization</dt><dd><span className="text-slate-500 dark:text-slate-400">Last success: </span>{formatTenantTimestamp(display.lastSuccessfulSync)}</dd></div></div>
        <div className="text-sm"><dt className="sr-only">Data completeness</dt><dd><span className="text-slate-500 dark:text-slate-400">Data: </span>{display.state === 'partially-synchronized' ? 'Partial' : display.isInitialSync ? 'Populating progressively' : display.isStale ? 'Last known values' : 'Current'}</dd></div>
        <div className="text-sm"><dt className="sr-only">Actionable issues</dt><dd><span className="text-slate-500 dark:text-slate-400">Actionable issues: </span><span className={display.issueCount ? 'font-semibold text-amber-700 dark:text-amber-300' : 'font-semibold'}>{display.issueCount}</span></dd></div>
      </dl>
      {display.isInitialSync && <div className="mt-3 border-l-4 border-blue-500 bg-blue-50 px-4 py-2 text-sm text-blue-900 dark:bg-blue-950/40 dark:text-blue-200"><strong>Tenant connected.</strong> Initial synchronization is running; modules will populate progressively.</div>}
      {display.issues.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-l-4 border-amber-400 bg-amber-400/10 px-4 py-2 text-sm text-amber-100"><strong>{display.issueCount} item{display.issueCount === 1 ? '' : 's'} require attention</strong><span>{display.issues.slice(0, 2).map((issue) => `${issue.service}: ${issue.title}`).join(' • ')}</span></div>}
      </div>
    </header>
  )
}
