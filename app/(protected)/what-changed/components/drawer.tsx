'use client'

import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ChangeEvent } from '../data/change-types'

function pretty(obj: any) {
  return JSON.stringify(obj ?? {}, null, 2)
}

function fmt(ts: string) {
  const d = new Date(ts)
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function fmtLocation(event: ChangeEvent) {
  const parts = [
    event.location?.city,
    event.location?.region,
    event.location?.country,
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : '—'
}

function fmtClient(event: ChangeEvent) {
  const app = event.client?.app
  const device = event.client?.device
  if (!app && !device) return '—'
  if (app && device) return `${app} · ${device}`
  return app ?? device ?? '—'
}

export function WhatChangedDrawer({
  open,
  event,
  onClose,
}: {
  open: boolean
  event: ChangeEvent | null
  onClose: () => void
}) {
  // Allow animation out without crashing
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])
  if (!mounted) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className={[
          'fixed inset-0 z-40 bg-black/40 transition-opacity',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        ].join(' ')}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over panel */}
      <div
        className={[
          'fixed inset-y-0 right-0 z-50 w-full sm:w-[520px] bg-background border-l shadow-xl',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label="Change details"
      >
        <div className="h-full flex flex-col">
          {/* Header */}
          <div className="p-4 border-b flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-lg font-semibold">
                {event?.title ?? 'Change details'}
              </div>
              {event?.summary ? (
                <div className="text-sm text-muted-foreground mt-1">
                  {event.summary}
                </div>
              ) : null}

              <div className="mt-2 flex flex-wrap gap-2">
                {event?.category ? (
                  <Badge variant="secondary">{event.category}</Badge>
                ) : null}
                {event?.source ? (
                  <Badge variant="secondary">{event.source}</Badge>
                ) : null}
                {event?.severity ? (
                  <Badge variant="secondary">{event.severity}</Badge>
                ) : null}
              </div>
            </div>

            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-auto p-4 space-y-5">
            {!event ? (
              <div className="text-sm text-muted-foreground">
                Select an event to see details.
              </div>
            ) : (
              <>
                {/* High-signal context */}
                <div className="grid grid-cols-1 gap-3 text-sm">
                  <div>
                    <div className="text-muted-foreground">Time</div>
                    <div className="font-medium">{fmt(event.ts)}</div>
                  </div>

                  <div>
                    <div className="text-muted-foreground">Location</div>
                    <div className="font-medium">{fmtLocation(event)}</div>
                  </div>

                  <div>
                    <div className="text-muted-foreground">IP address</div>
                    <div className="font-medium">{event.ip ?? '—'}</div>
                  </div>

                  <div>
                    <div className="text-muted-foreground">Client</div>
                    <div className="font-medium">{fmtClient(event)}</div>
                  </div>
                </div>

                <div className="border-t pt-4 grid grid-cols-1 gap-3 text-sm">
                  <div>
                    <div className="text-muted-foreground">Tenant</div>
                    <div className="font-medium">
                      {event.tenantName} ({event.provider})
                    </div>
                  </div>

                  <div>
                    <div className="text-muted-foreground">Actor</div>
                    <div className="font-medium">{event.actor ?? '—'}</div>
                  </div>

                  <div>
                    <div className="text-muted-foreground">Affected</div>
                    <div className="font-medium">{event.target ?? '—'}</div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold">Before</div>
                  <pre className="text-xs rounded-md border p-3 overflow-auto bg-muted/30">
                    {pretty(event.before)}
                  </pre>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold">After</div>
                  <pre className="text-xs rounded-md border p-3 overflow-auto bg-muted/30">
                    {pretty(event.after)}
                  </pre>
                </div>

                <div className="flex gap-2">
                  <Button variant="secondary" disabled>
                    View in Entra
                  </Button>
                  <Button variant="secondary" disabled>
                    Open Audit Log
                  </Button>
                </div>
                {event.recoveryGuidance?.length ? (
                  <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/20">
                    <div className="font-semibold">Recommended recovery review</div>
                    <ol className="list-decimal space-y-1 pl-5">
                      {event.recoveryGuidance.map((step) => <li key={step}>{step}</li>)}
                    </ol>
                    <div className="text-xs text-muted-foreground">HawkView does not automatically reverse security changes. Review the evidence and approve each recovery action.</div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
