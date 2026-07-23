'use client'

import { Card, CardContent } from '@/components/ui/card'

export default function LicensesSection({
  isMicrosoft,
  licenseRows,
  UtilBar,
}: {
  isMicrosoft: boolean
  licenseRows: any[]
  UtilBar: (props: { value: number }) => JSX.Element
}) {
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div className="font-semibold">
            {isMicrosoft ? 'License Overview' : 'Workspace Licensing'}
          </div>
          <button className="text-sm font-medium text-blue-600 hover:underline">
            {isMicrosoft ? 'Manage Licenses' : 'Manage Subscriptions'}
          </button>
        </div>

        <div className="mt-1 text-xs text-muted-foreground">
          {isMicrosoft
            ? 'Utilization and assignment status'
            : 'Seats and assignment status'}
        </div>

        <div className="mt-6 space-y-6">
          {licenseRows.map((row) => {
            const rawPct = row.total > 0 ? (row.used / row.total) * 100 : 0
            const pct = Math.round(rawPct)
            const displayPctText =
              row.used > 0 && rawPct < 1 ? '<1% UTILIZED' : `${pct}% UTILIZED`
            return (
              <div key={row.skuPartNumber || row.name}>
                <div className="flex items-center justify-between gap-4">
                  <div className="text-sm font-semibold">{row.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.used} / {row.total}
                  </div>
                </div>
                <UtilBar value={pct} />
                <div className="mt-2 text-right text-xs font-semibold text-muted-foreground">
                  {displayPctText}
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
