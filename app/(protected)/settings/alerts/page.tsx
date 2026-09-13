'use client'

/**
 * What this organisation treats as urgent.
 *
 * ORG-LEVEL, NOT PER-PERSON, and the distinction is the reason this page exists
 * separately from notification preferences. Two people in one MSP must not
 * disagree about whether a privileged role grant is worth waking somebody for,
 * so the tier belongs to the organisation; the channel and the quiet hours
 * belong to the person. Nothing here writes a user preference.
 *
 * Everything honesty-shaped on this page lives in lib/alerts, tested there:
 * which empty state a read earns, what a tier actually delivers today, and when
 * a saved change starts to matter. This file renders those answers and does not
 * recompute any of them.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, BellRing, Loader2 } from 'lucide-react'
import { apiClient } from '@/lib/api/client'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  type AlertDisposition,
  type AlertDispositionRow,
} from '@/lib/alerts/dispositions'
import { settingsView, type SettingsPhase } from '@/lib/alerts/settings-view'
import {
  DispositionRow,
  type SaveState,
} from '@/components/alerts/disposition-row'
import {
  readDispositions,
  type DispositionsRead,
} from '@/lib/alerts/read-dispositions'

/**
 * Whether a read has completed at all.
 *
 * Kept beside the read rather than inferred from `rows.length`, for the reason
 * the notification bell had to learn twice: before the first response, an empty
 * list is not a result. LOADING here means "no answer yet" and must never
 * render as "nothing is configured".
 */
// The state union lives with settingsView, which is declared against it. Two
// copies of it here and there could drift, and the page would then be holding a
// shape the decision function does not accept.


export default function AlertSettingsPage() {
  const [state, setState] = useState<SettingsPhase>({ phase: 'LOADING' })
  const [rows, setRows] = useState<AlertDispositionRow[]>([])
  const [saves, setSaves] = useState<Record<string, SaveState>>({})

  useEffect(() => {
    let cancelled = false
    apiClient
      .get<unknown>('/api/alerts/dispositions')
      .then((body) => {
        if (cancelled) return
        const read = readDispositions(body)
        setState({ phase: 'READ', read })
        if (read.outcome === 'LOADED') setRows(read.rows)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // A THROWN REQUEST IS NOT AN EMPTY ORGANISATION. It reaches FAILED, and
        // emptinessOf sends FAILED to NEVER_OBSERVED -- so the screen says
        // HawkView could not look, rather than that nothing is configured.
        setState({
          phase: 'READ',
          read: {
            outcome: 'FAILED',
            because:
              error instanceof Error
                ? error.message
                : 'The alert settings request did not complete.',
          },
        })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const choose = useCallback(
    async (row: AlertDispositionRow, disposition: AlertDisposition) => {
      if (disposition === row.disposition) return
      const previous = row.disposition
      setSaves((current) => ({
        ...current,
        [row.alertTypeId]: { kind: 'SAVING' },
      }))
      setRows((current) =>
        current.map((each) =>
          each.alertTypeId === row.alertTypeId ? { ...each, disposition } : each
        )
      )
      try {
        // PATCH, NOT PUT. This was `put` -- a guess made before the endpoint
        // existed, and the controller declares @Patch, so every save would have
        // failed on a method the route does not have.
        //
        // The endpoint returns the whole refreshed list, so the row is replaced
        // with what the server now holds rather than kept as what this page
        // optimistically set. The rollback below is still needed for a failed
        // write, but a successful one no longer has to be trusted.
        const after = await apiClient.patch<unknown>(
          '/api/alerts/dispositions/' + row.alertTypeId,
          { disposition }
        )
        const confirmed = readDispositions(after)
        if (confirmed.outcome === 'LOADED' && confirmed.rows.length > 0) {
          setRows(confirmed.rows)
        }
        setSaves((current) => ({
          ...current,
          [row.alertTypeId]: { kind: 'SAVED' },
        }))
      } catch (error: unknown) {
        // THE CONTROL GOES BACK. An optimistic update left in place after a
        // failed write is a screen showing a setting the server does not have,
        // which is the worst version of this page: an MSP believes they have
        // silenced something and has not.
        setRows((current) =>
          current.map((each) =>
            each.alertTypeId === row.alertTypeId
              ? { ...each, disposition: previous }
              : each
          )
        )
        setSaves((current) => ({
          ...current,
          [row.alertTypeId]: {
            kind: 'FAILED',
            because:
              error instanceof Error
                ? error.message
                : 'The change could not be saved.',
          },
        }))
      }
    },
    []
  )

  // ONE DECISION, NOT FOUR. These were four inline ternaries, and the property
  // that matters is not a property of any one of them: the empty-state card and
  // the list must never both be on screen. Spread across four expressions that
  // held only because emptinessCopy happens to return null for HAS_ITEMS --
  // emergent, unstated, and nothing could fail if an edit broke it.
  const {
    loading,
    empty,
    because,
    discarded,
    unrecognisedKeys,
    rows: visibleRows,
  } = settingsView(
    state,
    rows
  )

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <BellRing className="h-5 w-5 text-muted-foreground" />
          Alert settings
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          What this organisation treats as urgent. Everyone in the organisation
          sees the same answer &mdash; how and when you personally hear about it
          is set on your notification preferences.
        </p>
      </div>

      {loading && (
        <Card>
          <CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading alert settings&hellip;
          </CardContent>
        </Card>
      )}

      {empty && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{empty.title}</CardTitle>
            <CardDescription>{empty.detail}</CardDescription>
          </CardHeader>
          {because && (
            <CardContent className="pt-0">
              <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {because}
              </p>
            </CardContent>
          )}
        </Card>
      )}

      {unrecognisedKeys.length > 0 && (
        <p className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {/* THESE HAVE NO ROW TO APPEAR ON. The list walks the catalogue, so a
              saved setting keyed to an alert type this build does not declare is
              invisible in it -- the rows come back and none mentions it. The
              endpoint lists them separately for exactly that reason, and showing
              nothing here would leave somebody believing a choice took effect
              when the catalogue default is what applies. */}
          <span>
            {unrecognisedKeys.length} saved{' '}
            {unrecognisedKeys.length === 1 ? 'setting refers' : 'settings refer'} to
            alert {unrecognisedKeys.length === 1 ? 'a type' : 'types'} this version
            of HawkView does not have, so{' '}
            {unrecognisedKeys.length === 1 ? 'it does' : 'they do'} nothing:{' '}
            <span className="font-mono">{unrecognisedKeys.join(', ')}</span>. The
            catalogue default applies to anything they were meant to cover.
          </span>
        </p>
      )}

      {discarded > 0 && (
        <p className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {/* Stated rather than swallowed: a list quietly short by one is a list
              somebody will trust completely. */}
          <span>
            {discarded} alert {discarded === 1 ? 'type' : 'types'} could not be
            read by this version of HawkView and{' '}
            {discarded === 1 ? 'is' : 'are'} not shown. The list below is
            incomplete.
          </span>
        </p>
      )}

      {visibleRows.length > 0 && (
        <div className="space-y-3">
          {visibleRows.map((row) => (
            <DispositionRow
              key={row.alertTypeId}
              row={row}
              save={saves[row.alertTypeId] ?? { kind: 'IDLE' }}
              onChoose={choose}
            />
          ))}
        </div>
      )}
    </div>
  )
}
