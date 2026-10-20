'use client'

import Link from 'next/link'
import { AlertTriangle, CheckCircle2, ShieldQuestion, Sparkles } from 'lucide-react'
import type { Tenant } from '@/types/api'
import { tenantPermissionStatus } from '@/lib/tenants/tenant-permission-status'
import { tenantSectionPath } from '@/lib/tenants/navigation'
import { cn } from '@/lib/utils'

export function TenantPermissionSummary({
  tenant,
}: {
  tenant: Tenant
}) {
  const result = tenantPermissionStatus(tenant)
  const Icon = result.tone === 'attention' ? AlertTriangle : result.tone === 'ok' ? CheckCircle2 : ShieldQuestion
  const toneClass = result.tone === 'attention'
    ? 'text-amber-700 dark:text-amber-400'
    : result.tone === 'ok'
      ? 'text-slate-700 dark:text-slate-300'
      : 'text-slate-500 dark:text-slate-400'

  return (
    <Link
      href={`${tenantSectionPath(tenant.id, 'settings')}?tab=permissions`}
      title={result.detail}
      aria-label={`Microsoft permissions: ${result.label}. ${result.detail} Open tenant permissions.`}
      className="inline-flex flex-col items-start gap-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 group text-left"
    >
      <div className={cn('inline-flex items-center gap-1.5 text-xs font-semibold', toneClass)}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="group-hover:text-blue-600 transition-colors">{result.label}</span>
      </div>

      {result.missing.length > 0 && (
        <span className="text-[11px] text-amber-700/80 dark:text-amber-400/80 font-mono truncate max-w-[200px]">
          {result.missing.slice(0, 2).join(', ')}
          {result.missing.length > 2 ? ` +${result.missing.length - 2}` : ''}
        </span>
      )}

      {result.tone === 'neutral' && (
        <span className="text-[11px] text-slate-400 dark:text-slate-500">
          Evidence unavailable
        </span>
      )}

    </Link>
  )
}

/**
 * Secondary disclosure component for optional capabilities.
 * Shown in expandable disclosures or detail views so Exchange.ManageAsAppV2
 * never dominates the main table rows or looks like an error.
 */
export function TenantOptionalPermissionsDisclosure({ tenant }: { tenant: Tenant }) {
  const result = tenantPermissionStatus(tenant)
  const optionalGrants = result.optional

  return (
    <div className="text-xs space-y-2">
      <div className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-200">
        <Sparkles className="h-3.5 w-3.5 text-slate-400 shrink-0" />
        <span>Optional Microsoft Capabilities</span>
      </div>
      {optionalGrants.length === 0 ? (
        <p className="text-slate-500 dark:text-slate-400 text-[11px]">
          {result.tone === 'neutral'
            ? 'Optional permission status is not verified.'
            : 'No ungranted optional permissions were reported at the last verification.'}
        </p>
      ) : (
        <div className="space-y-1.5">
          {optionalGrants.map((perm) => {
            return (
              <div
                key={perm}
                className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 text-slate-600 dark:text-slate-300"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-mono text-[11px] font-semibold text-slate-800 dark:text-slate-200">
                    {perm}
                  </span>
                  <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400 bg-slate-200/60 dark:bg-slate-700/60 px-1.5 py-0.5 rounded">
                    Not granted at last check · Optional
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                  This grant may enable additional datasets. Review its exact scope and prerequisite before changing consent; its absence is not a required-permission failure.
                </p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
