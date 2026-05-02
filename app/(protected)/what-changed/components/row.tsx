'use client'

import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import type { ChangeEvent } from '../data/change-types'

function fmtTimeUTC(ts: string) {
  const d = new Date(ts)
  // HH:MM (UTC) – stable across SSR/client
  return d.toISOString().slice(11, 16)
}

function severityPillClass(sev: ChangeEvent['severity']) {
  if (sev === 'High') return 'bg-red-600 text-white'
  if (sev === 'Medium') return 'bg-amber-500 text-black'
  return 'bg-slate-600 text-white'
}

function severityDotClass(sev: ChangeEvent['severity']) {
  if (sev === 'High') return 'bg-red-600'
  if (sev === 'Medium') return 'bg-amber-500'
  return 'bg-slate-500'
}

function safeText(v?: string) {
  return v && v.trim().length ? v : '—'
}

export function WhatChangedRow({
  e,
  isActive,
  onClick,
}: {
  e: ChangeEvent
  isActive: boolean
  onClick: () => void
}) {
  const time = fmtTimeUTC(e.ts)

  return (
    <div className="grid grid-cols-[64px_16px_1fr] gap-3">
      {/* Time rail */}
      <div className="pt-5 text-right text-sm text-muted-foreground tabular-nums">
        {time}
      </div>

      {/* Dot + rail line */}
      <div className="relative flex justify-center">
        <div className="absolute top-0 bottom-0 w-px bg-border" />
        <div
          className={[
            'relative mt-6 h-3 w-3 rounded-full ring-4 ring-background',
            severityDotClass(e.severity),
          ].join(' ')}
        />
      </div>

      {/* Card */}
      <button
        onClick={onClick}
        className={[
          'w-full text-left rounded-xl border bg-background transition-all',
          'hover:bg-muted/30 hover:border-muted-foreground/20',
          isActive ? 'border-blue-500/40 bg-muted/20 shadow-sm' : '',
        ].join(' ')}
      >
        <div className="p-4">
          {/* Title row */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold truncate">{e.title}</div>
              <div className="text-sm text-muted-foreground mt-1">
                {e.summary}
              </div>

              {/* Affected (Target) — required */}
              <div className="text-sm mt-2">
                <span className="text-muted-foreground">Affected: </span>
                <span className="font-medium">{safeText(e.target)}</span>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Badge variant="secondary" className="whitespace-nowrap">
                {e.tenantName}
              </Badge>
              <span
                className={[
                  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                  severityPillClass(e.severity),
                ].join(' ')}
              >
                {e.severity === 'High' ? 'CRITICAL' : e.severity.toUpperCase()}
              </span>
            </div>
          </div>

          {/* Meta row (no “GAS icons”) */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <span>
              <span className="font-medium text-foreground/80">Actor:</span>{' '}
              {safeText(e.actor)}
            </span>

            <span>
              <span className="font-medium text-foreground/80">Category:</span>{' '}
              {e.category}
            </span>

            <span>
              <span className="font-medium text-foreground/80">Source:</span>{' '}
              {e.source}
            </span>

            {/* Optional: location + IP if present */}
            {(e.location?.city || e.location?.region || e.location?.country) && (
              <span>
                <span className="font-medium text-foreground/80">Location:</span>{' '}
                {[e.location?.city, e.location?.region, e.location?.country]
                  .filter(Boolean)
                  .join(', ')}
              </span>
            )}

            {e.ip && (
              <span>
                <span className="font-medium text-foreground/80">IP:</span>{' '}
                {e.ip}
              </span>
            )}
          </div>
        </div>
      </button>
    </div>
  )
}
