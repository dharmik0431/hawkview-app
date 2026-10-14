'use client'

import Link from 'next/link'
import { AlertTriangle, CheckCircle2, ShieldQuestion } from 'lucide-react'
import type { Tenant } from '@/types/api'
import { tenantPermissionStatus } from '@/lib/tenants/tenant-permission-status'
import { tenantSectionPath } from '@/lib/tenants/navigation'
import { cn } from '@/lib/utils'

const TONE = {
  ok: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  attention: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  neutral: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
} as const

export function TenantPermissionSummary({ tenant }: { tenant: Tenant }) {
  const result = tenantPermissionStatus(tenant)
  const Icon = result.tone === 'ok' ? CheckCircle2 : result.tone === 'attention' ? AlertTriangle : ShieldQuestion
  const shownNames = result.missing.length ? result.missing : result.optional

  return (
    <Link
      href={`${tenantSectionPath(tenant.id, 'settings')}?tab=permissions`}
      title={result.detail}
      aria-label={`Microsoft permissions: ${result.label}. ${result.detail} Open tenant permissions.`}
      className="inline-flex flex-col items-start gap-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      <span className={cn('inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium', TONE[result.tone])}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {result.label}
      </span>
      {shownNames.length > 0 && (
        <span className="max-w-56 truncate text-[11px] text-slate-600 dark:text-slate-400">
          {shownNames.slice(0, 2).join(', ')}{shownNames.length > 2 ? ` +${shownNames.length - 2}` : ''}
        </span>
      )}
    </Link>
  )
}
