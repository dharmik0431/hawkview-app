'use client'

import React from 'react'
import { Activity, Building2, Cloud, HardDrive, KeyRound, Mail, Settings, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatTenantTimestamp, type TenantWorkspaceDisplay } from '@/lib/tenant-workspace-state'
import { getServiceTheme } from './service-theme'
import type { ServiceSyncFreshness } from '@/types/tenant-data'

const moduleMeta: Record<string, { label: string; purpose: string; icon: typeof Cloud }> = {
  overview: {
    label: 'Tenant Command Center',
    purpose: 'Health, freshness, issues, and recent evidence across Microsoft 365.',
    icon: Activity,
  },
  home: {
    label: 'Office 365',
    purpose: 'Licenses, subscriptions, domains, and tenant-level protection.',
    icon: Cloud,
  },
  entra: {
    label: 'Entra ID',
    purpose: 'Identities, access, applications, authentication, and sign-ins.',
    icon: Users,
  },
  exchange: {
    label: 'Exchange',
    purpose: 'Mailboxes, domains, groups, forwarding, and mail-flow risks.',
    icon: Mail,
  },
  sharepoint: {
    label: 'SharePoint / OneDrive',
    purpose: 'Sites, storage, ownership, activity, and external sharing.',
    icon: HardDrive,
  },
  teams: {
    label: 'Teams',
    purpose: 'Collaboration, meetings, calling, and external access.',
    icon: Building2,
  },
  'license-activity': {
    label: 'License Activity',
    purpose: 'Monitor active license usage, assignment changes, and historic user audit events.',
    icon: KeyRound,
  },
  settings: {
    label: 'Tenant Settings',
    purpose: 'Connection, permissions, synchronization, and lifecycle controls.',
    icon: Settings,
  },
}

export function ModuleHeader({
  section,
  display,
  freshness,
}: {
  section: string
  display: TenantWorkspaceDisplay
  freshness?: ServiceSyncFreshness | null
}) {
  const meta = moduleMeta[section] ?? moduleMeta.overview
  const Icon = meta.icon
  const theme = getServiceTheme(section)

  const dataCoverage = display.isInitialSync
    ? 'Populating progressively'
    : display.state === 'partially-synchronized'
      ? 'Partial dataset'
      : display.isStale
        ? 'Last known data'
        : 'Current dataset'

  const freshnessText = (() => {
    if (!freshness) return 'Freshness unavailable'
    if (freshness.status === 'RUNNING') return 'Syncing'
    if (freshness.status === 'NOT_COLLECTED' || freshness.freshnessStatus === 'NEVER_SYNCED') return 'Never synchronized'
    if (freshness.status === 'PARTIAL') return `Partial — ${freshness.partialFailures.length} collector${freshness.partialFailures.length === 1 ? '' : 's'} need attention`
    if (freshness.status === 'FAILED') return 'Collection failed'
    if (freshness.status === 'STALE' || freshness.freshnessStatus === 'STALE') return 'Stale data'
    return freshness.lastSuccessfulCollectionAt ? `Updated ${formatTenantTimestamp(freshness.lastSuccessfulCollectionAt)}` : 'Freshness unavailable'
  })()
  const freshnessTitle = freshness?.lastSuccessfulCollectionAt ?? undefined

  return (
    <div
      className={cn(
        'mb-5 flex flex-col gap-3.5 pb-3.5 border-b border-slate-200 dark:border-slate-800 sm:flex-row sm:items-center sm:justify-between',
        theme.headerBorderAccent
      )}
      aria-labelledby="tenant-module-title"
    >
      <div className="flex items-center gap-3 min-w-0 pl-1">
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border shadow-2xs', theme.headerIconBg)}>
          <Icon className={cn('h-4.5 w-4.5', theme.headerIconText)} aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 id="tenant-module-title" className="truncate text-base font-bold text-slate-900 dark:text-white">
            {meta.label}
          </h2>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">
            {meta.purpose}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 sm:shrink-0 pr-1">
        <div>
          <span>Coverage: </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">{dataCoverage}</span>
        </div>
        <div className="h-3.5 w-px bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
        <div title={freshnessTitle}>
          <span>Freshness: </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">{freshnessText}</span>
        </div>
      </div>
    </div>
  )
}

