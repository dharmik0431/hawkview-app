'use client'

import { Clock3, AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePimScheduleSummary } from '@/lib/api/pim-schedule-summary-hooks'
import type { PimSchedulePlane, PimPlaneSummaryView } from '@/lib/tenants/pim-schedule-summary-view'
import { cn } from '@/lib/utils'

const PLANES: ReadonlyArray<{ plane: PimSchedulePlane; label: string }> = [
  { plane: 'ACTIVE', label: 'Active assignments' },
  { plane: 'ELIGIBLE', label: 'Eligible assignments' },
]

function storedTime(at: Date) {
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Age is taken from the stored observation's own age, never recomputed from the render clock, so a
 * failed newer attempt cannot make older data look freshly refreshed. */
function ageLabel(ageMs: number) {
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 1) return 'less than a minute old'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} old`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} old`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} old`
}

function Observation({ summary }: { summary: PimPlaneSummaryView }) {
  const observation = summary.lastObservation
  if (!observation) return null
  const count = observation.observedRecordCount
  return (
    <div className="space-y-1">
      <p className="text-sm text-slate-700 dark:text-slate-200">
        {/* "Observed schedule records" - never people, administrators, or a tenant total. */}
        {count === 0
          ? 'No schedule records were observed in this collection.'
          : `${count.toLocaleString()} schedule record${count === 1 ? '' : 's'} observed.`}
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Collected {storedTime(observation.collectedAt)} · {ageLabel(observation.ageMs)}
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Coverage not yet verified. This is what HawkView observed, not a confirmed complete list.
      </p>
    </div>
  )
}

function PlanePanel({ customerTenantId, plane, label }: {
  customerTenantId: string
  plane: PimSchedulePlane
  label: string
}) {
  // Each plane holds its own query, so one failing never blanks the other.
  const { data, isPending, isError, isFetching, refetch } = usePimScheduleSummary(customerTenantId, plane)

  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </p>

      {isPending && (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading observations…</p>
      )}

      {isError && (
        <div className="space-y-2">
          <p className="flex items-start gap-1.5 text-sm text-slate-700 dark:text-slate-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
            {/* No raw error text, status code or exception detail reaches product copy. */}
            <span>These observations are unavailable right now.</span>
          </p>
          <Button variant="ghost" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', isFetching && 'animate-spin')} aria-hidden />
            Try again
          </Button>
        </div>
      )}

      {/* A failed read takes precedence over data the cache retained from an earlier success: a
          refetch error leaves `data` in place, and showing those counts would present a stale
          observation as the current one. */}
      {!isError && data?.status === 'never-collected' && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No PIM observations collected yet.
        </p>
      )}

      {!isError && data?.status === 'observed' && <Observation summary={data} />}

      {!isError && data?.status === 'last-attempt-failed' && (
        <div className="space-y-2">
          <p className="flex items-start gap-1.5 text-sm text-slate-700 dark:text-slate-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
            <span>The most recent collection attempt did not finish.</span>
          </p>
          {data.showingOlderObservation ? (
            <div className="space-y-1">
              <p className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                <Clock3 className="h-3.5 w-3.5" aria-hidden />
                Showing the previous successful collection
              </p>
              <Observation summary={data} />
            </div>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No earlier successful collection is available to show.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** Read-only summary of persisted PIM schedule observations.
 *
 * This panel consumes the existing authenticated summary API and triggers no collection: there is
 * deliberately no setup or collect action here, and the only action offered re-reads the summary. */
export function PimScheduleObservationsPanel({ customerTenantId, className }: {
  customerTenantId: string
  className?: string
}) {
  if (!customerTenantId) return null
  return (
    <section className={cn('rounded-xl border border-slate-200 p-4 dark:border-slate-700', className)}>
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        PIM schedule observations
      </h3>
      <p className="mb-3 mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        What HawkView has observed about Privileged Identity Management schedules. Counts are
        observed schedule records, not people or confirmed administrator access.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {PLANES.map(({ plane, label }) => (
          <PlanePanel key={plane} customerTenantId={customerTenantId} plane={plane} label={label} />
        ))}
      </div>
    </section>
  )
}
