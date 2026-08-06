import { AlertTriangle, Clock3, Database, LockKeyhole, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'

export type TenantDataStateKind =
  | 'loading'
  | 'initial-sync'
  | 'partial'
  | 'failed'
  | 'stale'
  | 'permission-required'
  | 'license-required'
  | 'unsupported'
  | 'empty'

const copy: Record<TenantDataStateKind, { title: string; detail: string }> = {
  loading: { title: 'Loading tenant data', detail: 'Retrieving the latest stored data from HawkView.' },
  'initial-sync': { title: 'Initial synchronization in progress', detail: 'This module will populate progressively as Microsoft data is collected.' },
  partial: { title: 'Partially synchronized', detail: 'Available records are shown. One or more datasets did not complete.' },
  failed: { title: 'Synchronization failed', detail: 'Last known data remains available where HawkView has retained it.' },
  stale: { title: 'Showing last known data', detail: 'The latest synchronization did not complete successfully.' },
  'permission-required': { title: 'Microsoft permission required', detail: 'Review tenant settings to authorize this dataset.' },
  'license-required': { title: 'Tenant license required', detail: 'Microsoft does not provide this dataset for the tenant’s current licensing.' },
  unsupported: { title: 'Not available through the current Microsoft API', detail: 'HawkView cannot collect this dataset from the configured source.' },
  empty: { title: 'No records found', detail: 'Synchronization completed successfully and Microsoft returned no records.' },
}

export function TenantDataState({ kind, detail, className }: { kind: TenantDataStateKind; detail?: string | null; className?: string }) {
  const Icon = kind === 'permission-required' ? LockKeyhole : kind === 'failed' ? WifiOff : kind === 'initial-sync' || kind === 'loading' ? Clock3 : kind === 'empty' || kind === 'unsupported' ? Database : AlertTriangle
  const warning = ['partial', 'failed', 'stale', 'permission-required', 'license-required'].includes(kind)
  return <div role="status" className={cn('flex items-start gap-3 rounded-lg border px-4 py-3 text-sm', warning ? 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100' : 'border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200', className)}><Icon className="mt-0.5 h-4 w-4 shrink-0" /><div><div className="font-semibold">{copy[kind].title}</div><div className="mt-0.5 text-xs opacity-80">{detail || copy[kind].detail}</div></div></div>
}
