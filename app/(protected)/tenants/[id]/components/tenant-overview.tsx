'use client'

import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, Database } from 'lucide-react'
import type { TenantBundle } from '@/types/tenant-data'
import { formatTenantTimestamp, statusTone, type TenantWorkspaceDisplay } from '@/lib/tenant-workspace-state'
import { cn } from '@/lib/utils'

function datasetLabel(status: any) {
  if (!status) return 'Unavailable'
  const value = String(status.status || '').toLowerCase()
  if (['running', 'queued', 'pending', 'syncing'].includes(value)) return 'Syncing'
  if (['failed', 'error'].includes(value) || status.lastError) return 'Failed'
  if (value === 'partial') return 'Partial'
  if (status.lastSuccessfulAt) return 'Current'
  return 'Awaiting first sync'
}

export function TenantOverview({ bundle, display, onOpenModule }: {
  bundle: TenantBundle
  display: TenantWorkspaceDisplay
  onOpenModule: (module: string) => void
}) {
  const users = Array.isArray(bundle.users) ? bundle.users : []
  const products = bundle.licenses?.rows ?? []
  const sites = Array.isArray(bundle.sharepoint?.sites) ? bundle.sharepoint.sites : []
  const mailboxes = Array.isArray(bundle.exchange?.mailboxes) ? bundle.exchange.mailboxes : []
  const syncRows = Object.entries(bundle.sync ?? {})
  const exchangeMailboxSync = bundle.exchange?.sync?.mailboxes
  const sharePointSiteSync = bundle.sharepoint?.sync?.sites
  const recentEvents = Array.isArray((bundle as any).auditLogs)
    ? (bundle as any).auditLogs.slice(0, 5)
    : Array.isArray(bundle.signIns)
      ? bundle.signIns.slice(0, 5)
      : []

  const metrics = [
    ['Directory users', bundle.sync?.users?.lastSuccessfulAt ? users.length.toLocaleString() : 'Unavailable'],
    ['Subscribed products', bundle.sync?.licenses?.lastSuccessfulAt ? products.length.toLocaleString() : 'Unavailable'],
    ['Exchange mailboxes', exchangeMailboxSync?.lastSuccessfulAt ? mailboxes.length.toLocaleString() : 'Unavailable'],
    ['SharePoint sites', sharePointSiteSync?.lastSuccessfulAt ? sites.length.toLocaleString() : 'Unavailable'],
  ]

  return (
    <div className="space-y-5">
      <section aria-labelledby="tenant-summary-heading" className="border-b border-slate-200 pb-5 dark:border-slate-800">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><h2 id="tenant-summary-heading" className="text-base font-semibold">Tenant summary</h2><p className="text-sm text-slate-500 dark:text-slate-400">Operational inventory from the latest completed datasets.</p></div>
          <span className={cn('rounded-md border px-2 py-1 text-xs font-semibold', statusTone(display.state))}>{display.stateLabel}</span>
        </div>
        <dl className="grid divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4 dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {metrics.map(([label, value]) => <div key={label} className="px-4 py-3"><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 text-xl font-semibold">{value}</dd></div>)}
        </dl>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(380px,.9fr)]">
        <section aria-labelledby="attention-heading" className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800"><h2 id="attention-heading" className="font-semibold">Requires attention</h2><span className="text-sm text-slate-500">{display.issueCount} actionable</span></div>
          {display.issues.length ? <ul className="divide-y divide-slate-100 dark:divide-slate-800">{display.issues.map((issue) => <li key={issue.id} className="flex items-start gap-3 px-4 py-3"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /><div className="min-w-0 flex-1"><p className="font-medium">{issue.title}</p><p className="mt-0.5 text-sm text-slate-500">{issue.service} · {issue.detail}</p></div></li>)}</ul> : <div className="flex items-center gap-3 px-4 py-6 text-sm text-slate-600 dark:text-slate-300"><CheckCircle2 className="h-5 w-5 text-emerald-600" />No actionable connection or synchronization issues.</div>}
        </section>

        <section aria-labelledby="freshness-heading" className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800"><h2 id="freshness-heading" className="font-semibold">Service freshness</h2></div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">{syncRows.length ? syncRows.map(([service, status]) => <div key={service} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 text-sm"><div><p className="font-medium capitalize">{service.replace(/([A-Z])/g, ' $1')}</p><p className="text-xs text-slate-500">{formatTenantTimestamp(status?.lastSuccessfulAt)}</p></div><span className="text-xs font-semibold">{datasetLabel(status)}</span></div>) : <div className="px-4 py-6 text-sm text-slate-500">Service synchronization details are unavailable.</div>}</div>
        </section>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <section aria-labelledby="modules-heading" className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800"><h2 id="modules-heading" className="font-semibold">Investigate by service</h2></div>
          <div className="grid sm:grid-cols-2">{[['Office 365','home'],['Entra ID','entra'],['Exchange','exchange'],['SharePoint / OneDrive','sharepoint']].map(([label,key]) => <button key={key} type="button" onClick={() => onOpenModule(key)} className="flex items-center justify-between border-b border-slate-100 px-4 py-3 text-left text-sm font-medium hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:border-slate-800 dark:hover:bg-slate-800"><span>{label}</span><ArrowRight className="h-4 w-4 text-slate-400" /></button>)}</div>
        </section>
        <section aria-labelledby="activity-heading" className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800"><h2 id="activity-heading" className="font-semibold">Recent tenant activity</h2><Clock3 className="h-4 w-4 text-slate-400" /></div>
          {recentEvents.length ? <ul className="divide-y divide-slate-100 dark:divide-slate-800">{recentEvents.map((event: any, index: number) => <li key={event.id || index} className="px-4 py-2.5"><p className="truncate text-sm font-medium">{event.activityDisplayName || event.app || event.action || 'Tenant event'}</p><p className="truncate text-xs text-slate-500">{event.userDisplayName || event.user || event.actor || 'Actor not provided by Microsoft'} · {formatTenantTimestamp(event.createdDateTime || event.date || event.time)}</p></li>)}</ul> : <div className="flex items-center gap-3 px-4 py-6 text-sm text-slate-500"><Database className="h-5 w-5" />No retained activity is available for this tenant.</div>}
        </section>
      </div>
    </div>
  )
}
