'use client'

import { Activity, Building2, Cloud, HardDrive, Mail, Shield, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatTenantTimestamp, type TenantWorkspaceDisplay } from '@/lib/tenant-workspace-state'

const moduleMeta: Record<string, { label: string; purpose: string; icon: typeof Cloud; service: string }> = {
  overview: { label: 'Tenant command center', purpose: 'Health, freshness, issues, and recent evidence across Microsoft 365.', icon: Activity, service: 'overview' },
  home: { label: 'Office 365', purpose: 'Licenses, subscriptions, domains, and tenant-level protection.', icon: Cloud, service: 'office' },
  entra: { label: 'Entra ID', purpose: 'Identities, access, applications, authentication, and sign-ins.', icon: Users, service: 'entra' },
  exchange: { label: 'Exchange', purpose: 'Mailboxes, domains, groups, forwarding, and mail-flow risks.', icon: Mail, service: 'exchange' },
  sharepoint: { label: 'SharePoint / OneDrive', purpose: 'Sites, storage, ownership, activity, and external sharing.', icon: HardDrive, service: 'sharepoint' },
  teams: { label: 'Teams', purpose: 'Collaboration, meetings, calling, and external access.', icon: Building2, service: 'teams' },
  settings: { label: 'Tenant settings', purpose: 'Connection, permissions, synchronization, and lifecycle controls.', icon: Shield, service: 'settings' },
}

export function ModuleHeader({ section, display }: { section: string; display: TenantWorkspaceDisplay }) {
  const meta = moduleMeta[section] ?? moduleMeta.overview
  const Icon = meta.icon
  const completeness = display.isInitialSync
    ? 'Populating progressively'
    : display.state === 'partially-synchronized'
      ? 'Partial dataset'
      : display.isStale
        ? 'Last known data'
        : 'Current dataset'

  return (
    <section className="mb-4 border-b border-slate-200 pb-3 dark:border-slate-800" aria-labelledby="tenant-module-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="hv-service-bg hv-service-accent grid h-10 w-10 shrink-0 place-items-center border-l-2 hv-service-border">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Microsoft service</p>
            <h2 id="tenant-module-title" className="truncate text-lg font-semibold tracking-tight">{meta.label}</h2>
            <p className="truncate text-sm text-slate-500 dark:text-slate-400">{meta.purpose}</p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-5 gap-y-1 text-xs sm:text-right">
          <div><dt className="text-slate-500">Data coverage</dt><dd className="font-semibold">{completeness}</dd></div>
          <div><dt className="text-slate-500">Last success</dt><dd className={cn('font-semibold', !display.lastSuccessfulSync && 'text-slate-500')}>{formatTenantTimestamp(display.lastSuccessfulSync)}</dd></div>
        </dl>
      </div>
    </section>
  )
}
