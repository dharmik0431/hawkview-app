'use client'

import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import type { HawkViewPortfolioRisk } from '@/lib/dashboard/hawkview-risk-summary'

export function NativeRiskSummaryCard({ risk, requestState, onRetry }: {
  risk: HawkViewPortfolioRisk
  requestState: 'LOADING' | 'ERROR' | 'SUCCESS'
  onRetry: () => void
}) {
  const subtitle = requestState === 'LOADING' ? 'Checking assessment'
    : requestState === 'ERROR' ? 'Counts unavailable'
    : risk.totalTenants !== null ? `${risk.assessedTenants} of ${risk.totalTenants} tenants assessed`
    : 'Assessment unavailable'

  return <div className="flex min-w-0 flex-col gap-2">
    <Link href="/risky-users" className="block flex-1 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
      aria-label={`Open Risky Users. ${risk.accessibleValue} HawkView risky users.`} aria-busy={requestState === 'LOADING'}>
      <Card className="h-full rounded-2xl transition-colors hover:border-blue-300 dark:hover:border-blue-700">
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">HawkView Risky Users</div>
              <div className={`mt-1 break-words font-bold ${risk.count === null ? 'text-2xl' : 'text-3xl'}`} aria-live="polite">{risk.display}</div>
              <div className="mt-1 text-xs text-slate-500">{subtitle}</div>
            </div>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-100 bg-red-50"><ShieldAlert className="h-5 w-5 text-red-600" aria-hidden="true" /></div>
          </div>
        </CardContent>
      </Card>
    </Link>
    {requestState === 'ERROR' ? <div role="alert">
      <Button type="button" variant="outline" className="h-auto max-w-full whitespace-normal py-1 text-xs" onClick={onRetry}>Retry risk summary</Button>
    </div> : null}
  </div>
}
