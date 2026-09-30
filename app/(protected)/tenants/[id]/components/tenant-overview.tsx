'use client'

import { ArrowRight } from 'lucide-react'
import type { TenantBundle } from '@/types/tenant-data'
import type { TenantIssue, TenantWorkspaceDisplay } from '@/lib/tenant-workspace-state'
import { customerAttention, customerStatus } from '@/lib/attention/customer-attention'

export function TenantOverview({ bundle, display, onOpenModule, onOpenIssue, riskyUsers = null }: {
  bundle: TenantBundle
  display: TenantWorkspaceDisplay
  onOpenModule: (module: string) => void
  onOpenIssue?: (issue: TenantIssue) => void
  onSync?: () => void
  isSyncing?: boolean
  riskyUsers?: React.ReactNode
}) {
  const view = display.customer ?? customerAttention(bundle)
  const open = (id: string) => {
    const issue = display.issues.find(item => item.id === id)
    if (issue && onOpenIssue) onOpenIssue(issue)
    else onOpenModule(issue?.targetModule ?? 'overview')
  }
  return <div className="space-y-4" data-testid="customer-overview">
    <section aria-labelledby="overview-context" className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 id="overview-context" className="text-lg font-semibold">{bundle.tenant?.name ?? 'Tenant overview'}</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{customerStatus(view)}</p></div>
      </div>

    </section>
    {riskyUsers}
    <section aria-labelledby="tenant-findings" className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 id="tenant-findings" className="text-base font-semibold">Tenant findings</h2>
      <p className="mt-1 text-xs text-slate-500">Reported risk, registration gaps, and administrative changes for review.</p>
      <div className="mt-4 space-y-3">{view.findings.map((item, index) => <article key={`${item.key}-${index}`} className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
        <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="font-medium">{item.label}</h3><span className="text-xs font-medium capitalize text-amber-800 dark:text-amber-300">{item.severity}</span></div>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{item.why}</p>
        <button type="button" onClick={() => open(item.key)} className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-blue-700 hover:underline dark:text-blue-300">{item.actionLabel ?? 'Review finding'}<ArrowRight className="h-4 w-4" /></button>
      </article>)}{!view.findings.length && <p className="py-3 text-sm text-slate-500">{view.incomplete ? 'Finding total unavailable.' : 'No tenant findings reported in this summary.'}</p>}</div>
    </section>
    {view.accessActions.length > 0 && <section aria-labelledby="access-setup" className="rounded-xl border border-amber-200 bg-amber-50/40 p-4 dark:border-amber-900 dark:bg-amber-950/20">
      <h2 id="access-setup" className="text-base font-semibold">Customer access setup</h2>
      <p className="mt-1 text-xs text-slate-500">Explicit permission or consent actions for your Microsoft administrator.</p>
      {view.accessActions.map((item, index) => <article key={`${item.key}-${index}`} className="mt-4"><h3 className="font-medium">{item.label}</h3><p className="mt-1 text-sm">{item.why}</p><button type="button" onClick={() => open(item.key)} className="mt-2 text-sm font-semibold text-blue-700 hover:underline dark:text-blue-300">{item.actionLabel ?? 'Review access setup'}</button></article>)}
    </section>}
  </div>
}
