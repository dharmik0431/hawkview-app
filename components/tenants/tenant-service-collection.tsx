'use client'

import { Shield, KeyRound, Mail, Share2, ScrollText, UserRoundCheck } from 'lucide-react'
import type { Tenant } from '@/types/api'
import { serviceCollectionBadge, tenantConnectionBadge, type CollectionServiceKey } from '@/lib/tenants/service-collection-status'
import { cn } from '@/lib/utils'

const SERVICES: Array<{ key: CollectionServiceKey; name: string; shortName: string; icon: typeof Shield }> = [
  { key: 'office365', name: 'Microsoft 365', shortName: 'M365', icon: KeyRound },
  { key: 'entraId', name: 'Entra ID', shortName: 'Entra', icon: Shield },
  { key: 'exchange', name: 'Exchange', shortName: 'EXO', icon: Mail },
  { key: 'sharePointOneDrive', name: 'SharePoint / OneDrive', shortName: 'SPO', icon: Share2 },
  { key: 'signInLogs', name: 'Sign-ins', shortName: 'Sign-ins', icon: UserRoundCheck },
  { key: 'auditLogs', name: 'Audit logs', shortName: 'Audit', icon: ScrollText },
]

const TONE = {
  ok: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  attention: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  neutral: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
} as const

export function TenantServiceCollection({ tenant, compact = true }: { tenant: Tenant; compact?: boolean }) {
  const connection = tenantConnectionBadge(tenant)
  return (
    <div className="space-y-1.5">
      <span title={connection.detail} aria-label={`Tenant connection: ${connection.label}. ${connection.detail}`}
        className={cn('inline-flex items-center rounded border font-medium', compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs', TONE[connection.tone])}>
        Connection: {connection.label}
      </span>
      <div className="flex items-center gap-1.5 flex-wrap">
        {SERVICES.map(({ key, name, shortName, icon: Icon }) => {
          const badge = serviceCollectionBadge(tenant.syncFreshness, key)
          return (
            <span key={key} data-service={key} title={`${name}: ${badge.detail}`}
              aria-label={`${name} collection: ${badge.label}. ${badge.detail}`}
              className={cn('inline-flex items-center gap-1 rounded border font-medium',
                compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs', TONE[badge.tone])}>
              <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>{compact ? shortName : name}: {badge.label}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}
