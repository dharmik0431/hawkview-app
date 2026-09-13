'use client'

/**
 * One alert type's row on the organisation's alert settings page.
 *
 * Split out of the page so it can be rendered on its own -- the recurring defect
 * in this codebase is a true sentence in the wrong company, which no unit test
 * can see and only looking at the assembled row can catch.
 */

import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  DISPOSITION_LABELS,
  SAVED_APPLIES_FROM,
  deliveryDescription,
  type AlertDisposition,
  type AlertDispositionRow,
} from '@/lib/alerts/dispositions'

const TIERS: AlertDisposition[] = ['ACT_NOW', 'ACT_TODAY', 'RECORD_ONLY']

/** The outcome of one row's save, held per row so one failure cannot claim the
 * others succeeded -- and so a success cannot be shown for a row that reverted. */
export type SaveState =
  | { kind: 'IDLE' }
  | { kind: 'SAVING' }
  | { kind: 'SAVED' }
  | { kind: 'FAILED'; because: string }

export function DispositionRow({
  row,
  save,
  onChoose,
}: {
  row: AlertDispositionRow
  save: SaveState
  onChoose: (row: AlertDispositionRow, next: AlertDisposition) => void
}) {
  const delivery = deliveryDescription(row.disposition, row.mapped)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">{row.title}</CardTitle>
            <CardDescription className="font-mono text-[11px]">
              {row.category} &middot; {row.alertTypeId}
            </CardDescription>
          </div>
          {!row.mapped && (
            // SHOWN, NOT HIDDEN. Several catalogue types have no detector
            // feeding them, and an MSP who sets a disposition on one of those
            // has configured something that cannot fire. Finding that out by
            // never being alerted is the expensive way.
            <Badge variant="warning" className="shrink-0 text-[10px]">
              Nothing feeds this yet
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {TIERS.map((tier) => {
            const selected = tier === row.disposition
            return (
              <Button
                key={tier}
                type="button"
                size="sm"
                variant={selected ? 'default' : 'outline'}
                disabled={save.kind === 'SAVING'}
                aria-pressed={selected}
                onClick={() => onChoose(row, tier)}
              >
                {DISPOSITION_LABELS[tier]}
                {tier === row.catalogueSeverity && (
                  // The catalogue's own judgement, beside the override rather
                  // than replaced by it -- so a departure from HawkView's
                  // recommendation is visible as a departure.
                  <span
                    className={cn(
                      'ml-1.5 text-[10px] font-normal',
                      selected ? 'opacity-75' : 'text-muted-foreground'
                    )}
                  >
                    recommended
                  </span>
                )}
              </Button>
            )
          })}
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          <p>{delivery.today}</p>
          {delivery.deferred.map((sentence) => (
            // What is deferred is stated where the claim was made, not on a
            // help page nobody opens.
            <p key={sentence} className="text-amber-700 dark:text-amber-400">
              {sentence}
            </p>
          ))}
          {/* The departure is already legible: the "recommended" chip sits on
              the catalogue's tier and a different one is selected. A sentence
              repeating it two inches below was the same fact twice, and on the
              rendered card it read as an argument with the control above it. */}
        </div>

        {save.kind === 'SAVING' && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving&hellip;
          </p>
        )}
        {save.kind === 'SAVED' && (
          <p className="flex items-start gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
            <Check className="mt-0.5 h-3 w-3 shrink-0" />
            {/* Not "Saved". Intake reads dispositions once per run, so a change
                made mid-run does not touch that run -- and somebody who silences
                an alert and then receives it concludes the setting is broken. */}
            <span>{SAVED_APPLIES_FROM}</span>
          </p>
        )}
        {save.kind === 'FAILED' && (
          <p className="flex items-start gap-1.5 text-xs text-rose-700 dark:text-rose-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              Not saved, and the setting above has been put back to what the
              server has. {save.because}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  )
}
