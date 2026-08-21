'use client'

import { Shield, KeyRound, Mail, Share2, MessageSquare } from 'lucide-react'
import { computeTenantAttention } from '@/lib/attention/computeTenantAttention'
import type { Tenant } from '@/types/api'
import { cn } from '@/lib/utils'

interface AffectedServicesProps {
  tenant: Tenant
  compact?: boolean
}

type ServiceKey = 'o365' | 'entra' | 'exchange' | 'sharepoint' | 'teams'

interface ServiceInfo {
  key: ServiceKey
  name: string
  shortName: string
  icon: typeof Shield
}

const SERVICES: ServiceInfo[] = [
  { key: 'o365', name: 'Office 365', shortName: 'M365', icon: KeyRound },
  { key: 'entra', name: 'Entra ID', shortName: 'Entra', icon: Shield },
  { key: 'exchange', name: 'Exchange', shortName: 'EXO', icon: Mail },
  { key: 'sharepoint', name: 'SharePoint', shortName: 'SPO', icon: Share2 },
]

export function AffectedServices({ tenant, compact = true }: AffectedServicesProps) {
  const items = computeTenantAttention(tenant)

  // Map attention items to services
  const affectedMap: Record<ServiceKey, boolean> = {
    o365: false,
    entra: false,
    exchange: false,
    sharepoint: false,
    teams: false,
  }

  for (const item of items) {
    if (
      item.key.includes('mfa') ||
      item.key.includes('microsoft_') ||
      item.key.includes('permission') ||
      item.key.includes('auth') ||
      item.key.includes('sign_in') ||
      item.key.includes('conditional_access') ||
      item.key.includes('directory')
    ) {
      affectedMap.entra = true
    }
    if (item.key.includes('sharing') || item.key.includes('sharepoint')) {
      affectedMap.sharepoint = true
    }
    if (item.key.includes('license') || item.key.includes('m365_audit') || item.key.includes('audit_log')) {
      affectedMap.o365 = true
    }
    if (item.key.includes('exchange') || item.key.includes('mail')) {
      affectedMap.exchange = true
    }
  }

  const hasAnyAffected = Object.values(affectedMap).some(Boolean)

  if (compact) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        {SERVICES.map((srv) => {
          const isAffected = affectedMap[srv.key]
          const Icon = srv.icon

          return (
            <div
              key={srv.key}
              title={`${srv.name}: ${isAffected ? 'Needs attention' : 'No issue reported in this tenant summary'}`}
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors',
                isAffected
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 font-semibold border border-amber-200/80 dark:border-amber-900/50'
                  : 'bg-slate-100/70 text-slate-500 dark:bg-slate-800/50 dark:text-slate-400'
              )}
            >
              <Icon
                className={cn(
                  'h-3 w-3 shrink-0',
                  isAffected
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-slate-400 dark:text-slate-500'
                )}
              />
              <span className="hidden sm:inline">{srv.shortName}</span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {SERVICES.map((srv) => {
        const isAffected = affectedMap[srv.key]
        const Icon = srv.icon

        return (
          <span
            key={srv.key}
            className={cn(
              'px-2 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border',
              isAffected
                ? 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900'
                : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {srv.name}
          </span>
        )
      })}
    </div>
  )
}
