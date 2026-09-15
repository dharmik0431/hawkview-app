'use client'

/**
 * The urgency badges on a notification row.
 *
 * Split out of the panel so the assembled badges can be rendered on their own.
 * The two copy tables come with them: which vocabulary a row speaks is decided
 * here, and a table living elsewhere could drift from the decision that picks
 * between them.
 */

import { type NotificationItem } from '@/lib/notifications/normalize-response'
import {
  NOTIFICATION_TIERS,
  showsSeverityInstead,
  shownDespiteMuting,
  type ReadTier,
} from '@/lib/notifications/tier'
import { cn } from '@/lib/utils'

/** The severity a row arrives with, in the vocabulary the API sends.
 *
 * NOT THE CATALOGUE'S TIERS, AND NOT A DELIVERY PROMISE. An earlier version of
 * this table was keyed on ACT_NOW / ACT_TODAY / RECORD_ONLY and carried a
 * sentence per tier about how the alert would reach somebody. Both were wrong
 * about the same thing: the tier never arrives. `finding-pipeline.ts` collapses
 * it to `critical` / `high` / `info` on the way into the row, and
 * `notifications.service.ts` sends that through untouched with no alert type id
 * beside it -- so the table matched nothing and every alert rendered bare.
 *
 * The delivery sentence is gone rather than re-keyed, because `critical` is not
 * evidence of a tier: `tenant-sync.service.ts` publishes a lost Microsoft
 * connection at `critical` too. Saying "email and in-app, marked urgent" on
 * this badge would be a routing claim about rows that never went through the
 * routing table. What each tier delivers is stated on the alert settings page,
 * where the tier is genuinely known.
 */
const SEVERITY_COPY: Record<
  NonNullable<NotificationItem['severity']>,
  { label: string; note?: string; className: string }
> = {
  critical: {
    label: 'Critical',
    // The one delivery-shaped fact that IS true of the severity rather than the
    // tier: visibilityFilter admits `critical` rows whatever the in-app switch
    // says. Read out of the filter, not assumed.
    note: 'Shown even when in-app notifications are switched off.',
    className:
      'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-900',
  },
  high: {
    label: 'High',
    className:
      'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900',
  },
  medium: {
    label: 'Medium',
    className:
      'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-900',
  },
  low: {
    label: 'Low',
    className:
      'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  },
  info: {
    label: 'Info',
    className:
      'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  },
}


/** How each tier reads in the inbox.
 *
 * THE SAME THREE WORDS THE ALERT SETTINGS PAGE OFFERS. An MSP who set an alert
 * type to "Act now" must see "Act now" here; showing them "Critical" for the
 * same row is the two-vocabularies problem rendered, and a reader comparing the
 * two screens cannot tell whether they are looking at one alert or two things.
 *
 * Keyed off the tier union, so a tier added to the catalogue is a compile error
 * here rather than an alert that quietly renders with no badge. */
const TIER_COPY: Record<
  (typeof NOTIFICATION_TIERS)[number],
  { label: string; className: string }
> = {
  ACT_NOW: {
    label: 'Act now',
    className:
      'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-900',
  },
  ACT_TODAY: {
    label: 'Act today',
    className:
      'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900',
  },
  RECORD_ONLY: {
    label: 'Recorded',
    className:
      'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  },
}

/**
 * How urgent this row is, and whether it has already cleared.
 *
 * Without this every alert reads like every other notification: an ACT_NOW
 * incident and a routine info message render identically, so the urgency the
 * whole alerting design is built around is unsayable in the place alerts land.
 *
 * ONE VOCABULARY PER ROW, CHOSEN BY WHETHER THE ROW HAS A TIER. An alert row
 * gets the tier, because that is the word the settings page uses for the same
 * thing. A row with no tier -- a failing collector, a lost connection -- keeps
 * its severity, because for those rows the severity IS the urgency and there is
 * nothing else to say. Showing both would put "Critical" and "Act now" side by
 * side on one row: the same fact under two names.
 *
 * A row that says NEITHER gets no badge rather than a default one. Absent means
 * the row did not say, which is not the same as `info` or RECORD_ONLY --
 * defaulting to the mildest value would be the reassuring direction of the
 * error, and RECORD_ONLY in particular is a decision somebody made to stop being
 * told, not a shrug.
 *
 * `resolved` was parsed by the normaliser and rendered nowhere, so a cleared
 * incident sat in the inbox looking exactly like one still waiting.
 */
export function AlertBadges({
  tier,
  severity,
  resolved,
}: {
  tier: ReadTier
  severity?: NotificationItem['severity']
  resolved?: boolean
}) {
  // UNKNOWN_ALERT_TYPE is deliberately NOT rendered as a badge. The API reports
  // it because it is a fact about the data somebody should look at, and the
  // person reading the bell is not that somebody -- they cannot act on a
  // catalogue id this build does not have, and a badge reading "unknown" beside
  // a real security finding would be noise on the screen where noise costs
  // most. It falls through to the row's severity, which is still true.
  const tierCopy = tier.kind === 'TIER' ? TIER_COPY[tier.tier] : null
  const severityCopy =
    showsSeverityInstead(tier) && severity ? SEVERITY_COPY[severity] : null
  const copy = tierCopy ?? severityCopy

  // THE NOTE FOLLOWS `severity`, NOT WHICHEVER TABLE SUPPLIED THE BADGE.
  // `visibilityFilter` admits `critical` rows whatever the in-app switch says,
  // and it matches on `severity` -- so the rule applies to an ACT_NOW alert
  // (written `critical` by the pipeline) exactly as it does to a lost
  // connection. Reading it off the severity table meant the note vanished the
  // moment a row started showing its tier instead, which is the row where
  // somebody is most likely to ask why they are seeing this after muting.
  // Found by rendering the two side by side; nothing here could have failed.
  const mutingNote = shownDespiteMuting(severity)
    ? SEVERITY_COPY.critical.note
    : undefined
  if (!copy && !resolved) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {copy && (
        <span
          className={cn(
            'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold',
            copy.className
          )}
          title={mutingNote ?? copy.label}
        >
          {copy.label}
        </span>
      )}
      {resolved && (
        <span className="inline-flex items-center rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          Resolved
        </span>
      )}
      {mutingNote && (
        <span className="text-[10px] text-muted-foreground">
          {mutingNote}
        </span>
      )}
    </div>
  )
}
