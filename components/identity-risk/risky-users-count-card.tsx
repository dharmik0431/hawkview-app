'use client'

import { ChevronRight, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useRiskyUsers } from '@/lib/api/risky-users-hooks'
import type { RiskyUserCount } from '@/lib/identity-risk/risky-users-view'
import { cn } from '@/lib/utils'

function asOfLabel(value: string | null) {
  return value ? `As of ${new Date(value).toLocaleString()}` : null
}

/**
 * The count is the only Risky Users surface most technicians will see on a
 * normal day, so it has to carry its own qualifications. It never prints a
 * number without saying what the number covers, and it never prints a zero
 * without the gaps that zero does not account for.
 */
export function RiskyUsersCountCard({
  tenantId,
  onOpen,
}: {
  tenantId: string
  onOpen: () => void
}) {
  const { count, loading, channel } = useRiskyUsers(tenantId)

  if (loading) {
    return (
      <section
        aria-labelledby="risky-users-count-heading"
        className="rounded-md border border-slate-200 bg-white p-5 shadow-2xs dark:border-slate-800 dark:bg-slate-900"
      >
        <h2
          id="risky-users-count-heading"
          className="text-[20px] font-semibold text-slate-900 dark:text-white"
        >
          Risky users
        </h2>
        <p className="mt-2 text-[14px] text-slate-600 dark:text-slate-300">
          Loading the current assessment…
        </p>
      </section>
    )
  }

  return (
    <section
      aria-labelledby="risky-users-count-heading"
      className="rounded-md border border-slate-200 bg-white p-5 shadow-2xs dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 gap-4">
          <span
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg',
              count.accuracy === 'UNAVAILABLE' || count.accuracy === 'WITHHELD'
                ? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                : count.value === 0
                  ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                  : 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'
            )}
          >
            <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2
              id="risky-users-count-heading"
              className="text-[20px] font-semibold text-slate-900 dark:text-white"
            >
              Risky users
            </h2>
            <p className="mt-0.5 text-[13px] text-slate-500 dark:text-slate-400">
              HawkView&rsquo;s own analysis of this tenant&rsquo;s identity
              evidence
            </p>
          </div>
        </div>

        <div className="max-w-[16rem] text-right">
          <CountValue count={count} />
          <p className="sr-only">
            {count.accessibleValue} {count.headline}
          </p>
          <p className="mt-1.5 text-[13px] font-medium text-slate-700 dark:text-slate-200">
            {count.headline}
          </p>
        </div>
      </div>

      <p className="mt-4 text-[14px] leading-relaxed text-slate-600 dark:text-slate-300">
        {count.caption}
      </p>

      <CountKnown known={count.known} accuracy={count.accuracy} />
      <CountGaps gaps={count.gaps} />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-slate-500 dark:text-slate-400">
          {asOfLabel(count.asOf) ?? 'No assessment time reported'}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onOpen}>
          {count.value === 0 ? 'See what was checked' : 'Review risky users'}
          <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <p className="sr-only">
        {channel.headline}. Findings are investigation leads and do not
        establish that a user is compromised or safe.
      </p>
    </section>
  )
}

/**
 * A withheld count is a decision, not an absence, so the slot where the number
 * belongs says "Not counted" rather than showing a glyph that reads as an empty
 * state. A failed read keeps the neutral dash, because there a value really is
 * missing and a retry may produce one.
 */
function CountValue({ count }: { count: RiskyUserCount }) {
  if (count.accuracy === 'WITHHELD') {
    return (
      <p
        className="text-[19px] font-semibold leading-tight text-slate-600 dark:text-slate-300"
        aria-hidden="true"
      >
        Not counted
      </p>
    )
  }
  return (
    <p
      className="text-[34px] font-semibold leading-none text-slate-900 dark:text-white"
      aria-hidden="true"
    >
      {count.display}
    </p>
  )
}

/**
 * What is still true when there is no number. "3 mailboxes forwarding
 * externally" is far more useful than a blank, and the findings behind it exist
 * whether or not they can be attributed to people.
 */
function CountKnown({
  known,
  accuracy,
}: {
  known: RiskyUserCount['known']
  accuracy: RiskyUserCount['accuracy']
}) {
  if (known.length === 0) return null
  if (accuracy !== 'WITHHELD' && accuracy !== 'UNAVAILABLE') return null
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        What HawkView did find
      </p>
      <ul className="mt-1.5 space-y-1">
        {known.map((item) => (
          <li
            key={item}
            className="text-[13px] leading-relaxed text-slate-700 dark:text-slate-300"
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Rendered whenever there is anything the number does not account for —
 * including, and especially, next to a zero.
 */
function CountGaps({ gaps }: { gaps: RiskyUserCount['gaps'] }) {
  if (gaps.length === 0) return null
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/40">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Not covered by this number
      </p>
      <ul className="mt-1.5 space-y-1">
        {gaps.map((gap) => (
          <li
            key={gap}
            className="text-[13px] leading-relaxed text-slate-700 dark:text-slate-300"
          >
            {gap}
          </li>
        ))}
      </ul>
    </div>
  )
}
