import Link from 'next/link'
import { Clock3 } from 'lucide-react'
import { tenantDataFreshnessPath } from '@/lib/tenants/navigation'

export function DataFreshnessLink({ tenantId }: { tenantId: string }) {
  if (!tenantId) return null
  return <Link href={tenantDataFreshnessPath(tenantId)} className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />Data freshness</Link>
}
