'use client'

import React from 'react'
import { Activity, Building2, KeyRound, Settings, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { type TenantWorkspaceDisplay } from '@/lib/tenant-workspace-state'
import { getServiceTheme } from './service-theme'
import type { ServiceSyncFreshness } from '@/types/tenant-data'
import { productIcons, PRODUCT_ICON_STROKE_WIDTH } from '@/lib/ui/product-icons'

const moduleMeta: Record<string, { label: string; purpose: string; icon: LucideIcon }> = {
  overview: {
    label: 'Tenant Command Center',
    purpose: 'Findings and actions across Microsoft 365.',
    icon: Activity,
  },
  home: {
    label: 'Office 365',
    purpose: 'Licenses, subscriptions, domains, and tenant-level protection.',
    icon: productIcons.microsoft365,
  },
  entra: {
    label: 'Entra ID',
    purpose: 'Identities, access, applications, authentication, and sign-ins.',
    icon: productIcons.entra,
  },
  exchange: {
    label: 'Exchange',
    purpose: 'Mailboxes, domains, groups, forwarding, and mail-flow risks.',
    icon: productIcons.exchange,
  },
  sharepoint: {
    label: 'SharePoint / OneDrive',
    purpose: 'Sites, storage, ownership, activity, and external sharing.',
    icon: productIcons.sharepointOneDrive,
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
}: {
  section: string
  display: TenantWorkspaceDisplay
  freshness?: ServiceSyncFreshness | null
}) {
  const meta = moduleMeta[section] ?? moduleMeta.overview
  const Icon = meta.icon
  const theme = getServiceTheme(section)

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
          <Icon className={cn('h-4.5 w-4.5', theme.headerIconText)} strokeWidth={PRODUCT_ICON_STROKE_WIDTH} aria-hidden="true" />
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

    </div>
  )
}

