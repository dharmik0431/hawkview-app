import { computeTenantAttention } from '@/lib/attention/computeTenantAttention'
import { topAttention } from '@/lib/attention/topAttention'
import { cn } from '@/lib/utils'
import type { AttentionSeverity } from '@/types/attention'

const severityStyles: Record<AttentionSeverity, string> = {
  critical: 'bg-red-100 text-red-800 border border-red-200',
  high: 'bg-amber-100 text-amber-800 border border-amber-200',
  medium: 'bg-yellow-100 text-yellow-800 border border-yellow-200',
}

export function NeedsAttentionCell({ tenant }: { tenant: any }) {
  const attention = topAttention(
    computeTenantAttention(tenant)
  )

  if (!attention.length) {
    return <span className="text-muted-foreground">—</span>
  }

  return (
    <div className="flex flex-wrap gap-1">
      {attention.map((a) => (
        <span
          key={a.key}
          title={a.why}
          className={cn(
            'rounded-md px-2 py-0.5 text-xs font-semibold',
            severityStyles[a.severity]
          )}
        >
          {a.label}
        </span>
      ))}
    </div>
  )
}
