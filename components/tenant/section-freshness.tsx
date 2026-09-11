'use client'

/**
 * The freshness banner a tenant section shows above its data.
 *
 * One component rather than a label composed in each section. Eleven hand-built
 * variants would be eleven places for "collected and empty" and "could not
 * collect" to end up reading the same, and that pair is the distinction the
 * product exists for.
 *
 * Nothing here is a bare date. A timestamp with no judgement attached asks the
 * reader to work out whether seventeen days is a problem while they are
 * scanning, and they will not -- which is how a screen built on a collector
 * that stopped seventeen days ago came to look exactly like a screen built on
 * live data.
 */
import { AlertTriangle, CheckCircle2, Clock3 } from 'lucide-react'
import {
  emptySectionMeaning,
  freshnessPresentation,
  serviceFreshness,
  type ServiceFreshnessKey,
} from '@/lib/tenants/service-freshness'
import type { ServiceSyncFreshness } from '@/types/tenant-data'
import { cn } from '@/lib/utils'

type Source = Parameters<typeof serviceFreshness>[0]

const TONE = {
  ok: {
    wrap: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
    Icon: CheckCircle2,
  },
  attention: {
    wrap: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
    Icon: AlertTriangle,
  },
  unknown: {
    wrap: 'border-slate-300 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200',
    Icon: Clock3,
  },
} as const

/**
 * @param service which service's collectors feed this section
 * @param isEmpty whether the section has nothing to show, so the banner can say
 *   what that emptiness means rather than leaving the reader to assume
 */
export function SectionFreshness({
  source,
  service,
  isEmpty = false,
  className,
}: {
  source: Source
  service: ServiceFreshnessKey
  isEmpty?: boolean
  className?: string
}) {
  const freshness: ServiceSyncFreshness | null = serviceFreshness(
    source,
    service
  )
  const shown = freshnessPresentation(freshness)
  const emptiness = emptySectionMeaning(freshness, isEmpty)
  const tone = TONE[shown.tone]

  return (
    <div
      className={cn(
        'mb-4 rounded-lg border px-3 py-2 text-xs leading-relaxed',
        tone.wrap,
        className
      )}
    >
      <p className="flex items-center gap-1.5 font-semibold">
        <tone.Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {shown.label}
      </p>
      <p className="mt-0.5">{shown.detail}</p>
      {/* The emptiness is qualified where the emptiness is, not in a tooltip
          somewhere else. A reader who sees no rows has already drawn their
          conclusion by the time they would hover. */}
      {emptiness && <p className="mt-1 font-medium">{emptiness}</p>}
    </div>
  )
}
