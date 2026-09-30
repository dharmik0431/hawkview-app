'use client'

import { useEffect, useState } from 'react'
import { Clock3 } from 'lucide-react'
import { AGE_REFRESH_MS, datasetAge, datasetReportDate, formatDatasetTime, type DatasetAgeEvidence } from '@/lib/tenants/dataset-age'
import { cn } from '@/lib/utils'

/** Compact dataset age. This never interprets worker status as live activity. */
export function SectionFreshness({ evidence, isEmpty = false, className }: {
  evidence: DatasetAgeEvidence
  isEmpty?: boolean
  className?: string
}) {
  // A stable initial render avoids server/client clock and hydration differences.
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), AGE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])
  const shown = datasetAge(evidence, now ?? NaN)
  const dueAt = shown.timestamp && evidence.dueAfterMs !== undefined ? Date.parse(shown.timestamp) + evidence.dueAfterMs : null
  const dueLabel = dueAt === now ? 'Due now' : dueAt !== null && now !== null && dueAt < now ? 'Due since' : 'Next due'
  const reportDate = datasetReportDate(evidence, now ?? NaN)
  const description = `${reportDate ? reportDate + '. ' : ''}${shown.label}${shown.outdated ? ', outdated' : ''}. ${evidence.source}: ${shown.timestamp ?? 'update time unavailable'}`
  return (
    <div className={cn('mb-4 text-xs text-slate-500 dark:text-slate-400', className)}>
      <p className="flex flex-wrap items-center gap-1.5" title={description} aria-label={description}>
        <Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {reportDate && <span>{reportDate} ·</span>}
        {shown.timestamp ? <time dateTime={shown.timestamp}>{shown.label}</time> : <span>{shown.label}</span>}
        {!shown.outdated && shown.timestamp && evidence.dueAfterMs !== undefined && (now ?? 0) - Date.parse(shown.timestamp) >= evidence.dueAfterMs && <span>· Collection due</span>}
        {shown.outdated && <span className="font-medium text-amber-700 dark:text-amber-400">· Outdated</span>}
      </p>
      {dueAt !== null && <p className="mt-1">{dueLabel}: <time dateTime={new Date(dueAt).toISOString()} title={new Date(dueAt).toISOString()}>{formatDatasetTime(new Date(dueAt).toISOString())}</time></p>}
      {isEmpty && <p className="mt-1">
        {evidence.emptyVerified && shown.timestamp
          ? 'The recorded snapshot contains no records.'
          : 'No records are shown. An empty result has not been verified.'}
      </p>}
    </div>
  )
}

/** Empty-table interpretation stays beside the table, independently of age UI. */
export function DatasetEmptyState({ evidence, isEmpty = false }: { evidence: DatasetAgeEvidence; isEmpty?: boolean }) {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => { setNow(Date.now()) }, [evidence.observedAt])
  if (!isEmpty) return null
  return <p role="status" className="mb-4 text-xs text-slate-500 dark:text-slate-400">{evidence.emptyVerified && datasetAge(evidence, now ?? NaN).timestamp
    ? 'The recorded snapshot contains no records.' : 'No records are shown. An empty result has not been verified.'}</p>
}
