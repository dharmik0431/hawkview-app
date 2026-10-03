import type { ActivityTab } from '../data/types'

export function LoadedRecordScope({
  tab,
  displayedRecordLimit,
  loadedCount,
  matchingCount,
}: {
  tab: ActivityTab
  displayedRecordLimit: unknown
  loadedCount: number | null
  matchingCount: number | null
}) {
  const limit = typeof displayedRecordLimit === 'number' &&
    Number.isSafeInteger(displayedRecordLimit) && displayedRecordLimit > 0
      ? displayedRecordLimit
      : null
  const format = (value: number) => value.toLocaleString('en-US')

  return (
    <div role="note" aria-label="Loaded activity scope" className="mt-3 border-t pt-3 text-sm text-muted-foreground space-y-1">
      <p>
        <span className="font-medium text-foreground">{tab === 'signins' ? 'Sign-in logs' : 'Audit logs'}: </span>
        {loadedCount === null || matchingCount === null
          ? 'Loaded and matching counts are unavailable.'
          : `${format(loadedCount)} loaded; ${format(matchingCount)} match current filters.`}
        {' '}{limit === null
          ? 'Load limit: Not reported.'
          : `Reported load limit: up to ${format(limit)} most recent records per log type for this tenant.`}
        {limit !== null && loadedCount !== null && loadedCount === limit && ' The reported load limit is reached; older records may be excluded.'}
        {limit !== null && loadedCount !== null && loadedCount > limit && ' The loaded count exceeds the reported limit; the effective limit is unknown.'}
      </p>
      <p>Date ranges and other filters only narrow the loaded records. CSV exports only matching loaded records. Total available records and completeness are unknown.</p>
    </div>
  )
}
