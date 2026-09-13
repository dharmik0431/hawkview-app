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
  emptinessCopy,
  type AlertDisposition,
  type AlertDispositionRow,
} from '@/lib/alerts/dispositions'
import {
  DispositionRow,
  type SaveState,
} from '@/components/alerts/disposition-row'
import {
  emptinessOf,
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
type PageState = { phase: 'LOADING' } | { phase: 'READ'; read: DispositionsRead }


export default function AlertSettingsPage() {
  const [state, setState] = useState<PageState>({ phase: 'LOADING' })
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
        await apiClient.put('/api/alerts/dispositions/' + row.alertTypeId, {
          disposition,
        })
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

  const emptiness =
    state.phase === 'READ'
      ? emptinessOf(
          state.read.outcome === 'LOADED' ? { ...state.read, rows } : state.read
        )
      : null
  const empty = emptiness ? emptinessCopy(emptiness) : null
  const discarded =
    state.phase === 'READ' && state.read.outcome === 'LOADED'
      ? state.read.discarded
      : 0
  const because =
    state.phase === 'READ' && state.read.outcome !== 'LOADED'
      ? state.read.because
      : null

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

      {state.phase === 'LOADING' && (
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

      {rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((row) => (
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
