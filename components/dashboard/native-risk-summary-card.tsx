'use client'

import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatNativeRiskClock, type HawkViewPortfolioRisk } from '@/lib/dashboard/hawkview-risk-summary'

export function NativeRiskSummaryCard({ risk, requestState, generatedAt, microsoftLabel, onRetry }: {
  risk: HawkViewPortfolioRisk
  requestState: 'LOADING' | 'ERROR' | 'SUCCESS'
  generatedAt?: string
  microsoftLabel: string
  onRetry: () => void
}) {
  return <div className="min-w-0 space-y-2">
    <Link href="/risky-users" className="block rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
      aria-label={`Open Risky Users. ${risk.accessibleValue} HawkView risky users.`} aria-busy={requestState === 'LOADING'}>
      <Card className="h-full rounded-2xl transition-colors hover:border-blue-300 dark:hover:border-blue-700">
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">HawkView Risky Users</div>
              <div className="mt-1 text-3xl font-bold" aria-live="polite">{risk.display}</div>
              {risk.totalTenants !== null ? <div className="mt-1 text-xs text-slate-500">{risk.assessedTenants} of {risk.totalTenants} tenants assessed</div> : null}
              <div className="mt-1 text-[11px] text-slate-500">{risk.detail}</div>
              {requestState === 'SUCCESS' && generatedAt ? <div className="mt-1 text-[11px] text-slate-500">Summary checked <time dateTime={generatedAt}>{formatNativeRiskClock(generatedAt)}</time></div> : null}
              <div className="mt-2 text-[11px] text-slate-500">Microsoft Entra risk: {microsoftLabel}</div>
            </div>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-100 bg-red-50"><ShieldAlert className="h-5 w-5 text-red-600" aria-hidden="true" /></div>
          </div>
        </CardContent>
      </Card>
    </Link>
    {requestState === 'ERROR' ? <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
      <p>HawkView counts are withheld because the summary could not be loaded.</p>
      <Button type="button" variant="outline" className="mt-2" onClick={onRetry}>Retry risk summary</Button>
    </div> : null}
  </div>
}
