'use client'

import { Shield, KeyRound, Mail, Share2 } from 'lucide-react'
import { serviceAttribution, type ServiceKey } from '@/lib/attention/service-attribution'
import type { Tenant } from '@/types/api'
import { cn } from '@/lib/utils'

interface AffectedServicesProps { tenant: Tenant; compact?: boolean }
const SERVICES: Array<{ key: ServiceKey; name: string; shortName: string; icon: typeof Shield }> = [
  { key: 'o365', name: 'Office 365', shortName: 'M365', icon: KeyRound },
  { key: 'entra', name: 'Entra ID', shortName: 'Entra', icon: Shield },
  { key: 'exchange', name: 'Exchange', shortName: 'EXO', icon: Mail },
  { key: 'sharepoint', name: 'SharePoint', shortName: 'SPO', icon: Share2 },
]

export function AffectedServices({ tenant, compact = true }: AffectedServicesProps) {
  const { services, unattributed } = serviceAttribution(tenant)
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        {SERVICES.map(({ key, name, shortName, icon: Icon }) => {
          const { finding, evidenceGap } = services[key]
          const label = finding ? evidenceGap ? 'Finding · evidence gap' : 'Finding reported'
            : evidenceGap ? 'Evidence gap' : 'Unknown'
          const detail = `${name}: ${finding ? 'Tenant finding reported. ' : ''}${evidenceGap
            ? 'Collection evidence is incomplete; this does not establish a security finding or customer repair action.'
            : 'Service assessment coverage is not established by this summary.'}`
          return (
            <span key={key} data-service={key} title={detail} aria-label={`${name}: ${label}. ${detail}`}
              className={cn('inline-flex items-center gap-1 rounded border font-medium',
                compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs',
                finding ? 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900'
                  : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700')}>
              <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>{compact ? shortName : name}: {label}</span>
            </span>
          )
        })}
      </div>
      {unattributed > 0 && <p className="text-[11px] text-slate-600 dark:text-slate-400">
        Service not established for {unattributed} reported item{unattributed === 1 ? '' : 's'}.
      </p>}
    </div>
  )
}
