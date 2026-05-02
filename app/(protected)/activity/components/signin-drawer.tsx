'use client'

import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { SignInEvent } from '../data/types'

function fmtUTC(iso: string) {
  const s = iso.includes('T') ? iso : new Date(iso).toISOString()
  return s.replace('T', ' ').replace('Z', '').slice(0, 19) + ' UTC'
}

function safe(v?: string) {
  return v && v.trim().length ? v : '—'
}

function statusStyles(status?: SignInEvent['status']) {
  const ok = status === 'Success'
  return {
    topBar: ok ? 'bg-emerald-500' : 'bg-rose-500',
    tint: ok ? 'bg-emerald-50/60' : 'bg-rose-50/60',
    pill: ok
      ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
      : 'bg-rose-100 text-rose-800 border-rose-200',
    label: ok
      ? 'text-emerald-700 bg-emerald-100/70'
      : 'text-rose-700 bg-rose-100/70',
  }
}

function Chip({
  label,
  value,
  tone = 'slate',
}: {
  label: string
  value?: string
  tone?: 'slate' | 'blue' | 'purple' | 'emerald' | 'rose'
}) {
  const toneClass =
    tone === 'blue'
      ? 'bg-blue-50 text-blue-800 border-blue-200'
      : tone === 'purple'
        ? 'bg-purple-50 text-purple-800 border-purple-200'
        : tone === 'emerald'
          ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
          : tone === 'rose'
            ? 'bg-rose-50 text-rose-800 border-rose-200'
            : 'bg-slate-50 text-slate-800 border-slate-200'

  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={[
          'mt-1 inline-flex rounded-md border px-2 py-1 text-xs font-medium',
          toneClass,
        ].join(' ')}
      >
        {safe(value)}
      </div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border bg-white/70 p-3">
      <div className="text-sm font-semibold mb-3">{title}</div>
      {children}
    </div>
  )
}

export function SignInDrawer({
  open,
  event,
  onClose,
}: {
  open: boolean
  event: SignInEvent | null
  onClose: () => void
}) {
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])
  if (!mounted) return null

  const s = statusStyles(event?.status)

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

      {/* Panel */}
      <div
        className={[
          'fixed inset-y-0 right-0 z-50 w-full sm:w-[480px] bg-background border-l shadow-xl',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label="Sign-in details"
      >
        <div className="h-full flex flex-col">
          {/* Colored top bar */}
          <div className={['h-1 w-full', s.topBar].join(' ')} />

          {/* Header */}
          <div className={['p-4 border-b', s.tint].join(' ')}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-lg font-semibold">Sign-in Details</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {safe(event?.id)}
                </div>
              </div>

              <Button variant="ghost" onClick={onClose}>
                ✕
              </Button>
            </div>

            {/* Status row */}
            <div className="mt-3 flex items-center gap-2">
              <span
                className={[
                  'inline-flex items-center rounded-md border px-2 py-1 text-xs font-semibold',
                  s.pill,
                ].join(' ')}
              >
                {event?.status ?? '—'}
              </span>

              {event?.conditionalAccess ? (
                <Badge variant="secondary">{event.conditionalAccess}</Badge>
              ) : null}
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-auto p-4 space-y-4 bg-muted/10">
            {!event ? (
              <div className="text-sm text-muted-foreground">
                Select a row to view details.
              </div>
            ) : (
              <>
                {/* Summary chips */}
                <div className="grid grid-cols-2 gap-3">
                  <Chip label="Date (UTC)" value={fmtUTC(event.createdAt)} />
                  <Chip label="Tenant" value={event.tenantName} tone="blue" />
                  <Chip
                    label="User"
                    value={event.userDisplayName}
                    tone="purple"
                  />
                  <Chip
                    label="Principal name"
                    value={event.userPrincipalName}
                  />
                </div>

                <Section title="User & Application">
                  <div className="grid grid-cols-2 gap-3">
                    <Chip
                      label="Application"
                      value={event.appDisplayName}
                      tone="blue"
                    />
                    <Chip label="Client app" value={event.clientAppUsed} />
                  </div>
                </Section>

                <Section title="Device & Location">
                  <div className="grid grid-cols-2 gap-3">
                    <Chip label="IP address" value={event.ipAddress} />
                    <Chip
                      label="Location"
                      value={event.location}
                      tone="emerald"
                    />
                    <Chip label="Device" value={event.device} />
                    <Chip label="Operating system" value={event.os} />
                  </div>

                  <div className="mt-3 rounded-md border bg-white/60 p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      User agent
                    </div>
                    <div className="mt-1 text-xs break-words">
                      {safe(event.userAgent)}
                    </div>
                  </div>
                </Section>

                {/* Footer actions */}
                <div className="flex items-center justify-between gap-2 pt-1">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const payload = JSON.stringify(event, null, 2)
                      navigator.clipboard?.writeText(payload)
                    }}
                  >
                    Copy JSON
                  </Button>

                  <Button onClick={onClose}>Close</Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
