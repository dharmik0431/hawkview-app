'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  Bell,
  CheckCircle2,
  Info,
  AlertTriangle,
  XCircle,
  CheckCheck,
  Trash2,
  ExternalLink,
  Sparkles,
  Clock3,
  X,
} from 'lucide-react'
import {
  useNotifications,
  NotificationCategory,
  type NotificationItem,
  type NotificationFeedState,
} from '@/components/providers/notification-provider'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'


/**
 * What an empty inbox means, which depends on whether anyone managed to look.
 *
 * One sentence used to cover every case: "You're all caught up" appeared
 * whether the tenant was quiet or the request had never succeeded. The provider
 * keeps its previous list when a read fails, and on a first load that list is
 * empty -- so a broken endpoint reassured the reader.
 *
 * Four states, four sentences, and only one of them is reassuring. The bell is
 * where an MSP checks whether anything needs them, so a false "nothing" here
 * costs more than a false "something".
 */

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

/**
 * The severity of a row, and whether it has already cleared.
 *
 * Without this every alert reads like every other notification: a critical
 * incident and a routine info message render identically, so the urgency the
 * whole alerting design is built around is unsayable in the place alerts land.
 *
 * A row with NO severity gets no badge rather than a default one. Absent means
 * the row did not say, which is not the same as `info` -- defaulting to the
 * mildest value would be the reassuring direction of the error.
 *
 * `resolved` was parsed by the normaliser and rendered nowhere, so a cleared
 * incident sat in the inbox looking exactly like one still waiting.
 */
function AlertBadges({
  severity,
  resolved,
}: {
  severity?: NotificationItem['severity']
  resolved?: boolean
}) {
  if (!severity && !resolved) return null
  const copy = severity ? SEVERITY_COPY[severity] : null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {copy && (
        <span
          className={cn(
            'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold',
            copy.className
          )}
          title={copy.note ?? copy.label}
        >
          {copy.label}
        </span>
      )}
      {resolved && (
        <span className="inline-flex items-center rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          Resolved
        </span>
      )}
      {copy?.note && (
        <span className="text-[10px] text-muted-foreground">{copy.note}</span>
      )}
    </div>
  )
}

function EmptyInbox({
  state,
  filter,
}: {
  state: NotificationFeedState
  filter: 'all' | 'unread'
}) {
  const unreadOnly = filter === 'unread'

  if (state === 'LOADING') {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
        <div className="w-10 h-10 rounded-full bg-muted/50 flex items-center justify-center mb-2">
          <Clock3 className="h-5 w-5 text-muted-foreground/70" aria-hidden="true" />
        </div>
        <p className="text-sm font-medium text-foreground">Checking</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Nothing has been read yet, so this is not an answer either way.
        </p>
      </div>
    )
  }

  if (state === 'UNAVAILABLE') {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-950 flex items-center justify-center mb-2">
          <AlertTriangle
            className="h-5 w-5 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
        </div>
        <p className="text-sm font-medium text-foreground">
          Notifications could not be loaded
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 max-w-[15rem]">
          No request has succeeded, so HawkView cannot say whether anything
          needs you. This is not an empty inbox.
        </p>
      </div>
    )
  }

  if (state === 'STALE') {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-950 flex items-center justify-center mb-2">
          <AlertTriangle
            className="h-5 w-5 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
        </div>
        <p className="text-sm font-medium text-foreground">
          Nothing {unreadOnly ? 'unread ' : ''}as of the last successful check
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 max-w-[15rem]">
          The most recent refresh failed, so anything raised since then is not
          shown here.
        </p>
      </div>
    )
  }

  // LOADED. The only state in which an empty inbox is a statement about the
  // tenant rather than about us.
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
      <div className="w-10 h-10 rounded-full bg-muted/50 flex items-center justify-center mb-2">
        <Sparkles className="h-5 w-5 text-muted-foreground/70" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium text-foreground">
        You&rsquo;re all caught up
      </p>
      <p className="text-xs text-muted-foreground mt-0.5">
        No {unreadOnly ? 'unread ' : ''}notifications at this time.
      </p>
    </div>
  )
}

export function NotificationPanel() {
  const {
    notifications,
    feedState,
    unreadCount,
    markAsRead,
    dismiss,
    markAllAsRead,
    clearRead,
  } = useNotifications()

  const [isOpen, setIsOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const togglePanel = () => setIsOpen((prev) => !prev)

  const closePanel = useCallback(() => {
    setIsOpen(false)
  }, [])

  // Close on Click Outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node)
      ) {
        closePanel()
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, closePanel])

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        closePanel()
        buttonRef.current?.focus()
      }
    }
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, closePanel])

  const filteredNotifications = notifications.filter((n) => {
    if (filter === 'unread') return !n.read
    return true
  })

  const hasReadNotifications = notifications.some((n) => n.read)

  const formatTimestamp = (value: string) => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
    if (elapsedSeconds < 60) return 'Just now'
    if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m ago`
    if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)}h ago`
    if (elapsedSeconds < 604800) return `${Math.floor(elapsedSeconds / 86400)}d ago`
    return date.toLocaleDateString()
  }

  const renderStatusIcon = (category: NotificationCategory) => {
    switch (category) {
      case 'success':
        return (
          <CheckCircle2
            className="h-4 w-4 text-emerald-500 shrink-0"
            aria-hidden="true"
          />
        )
      case 'info':
        return (
          <Info className="h-4 w-4 text-blue-500 shrink-0" aria-hidden="true" />
        )
      case 'warning':
        return (
          <AlertTriangle
            className="h-4 w-4 text-amber-500 shrink-0"
            aria-hidden="true"
          />
        )
      case 'error':
        return (
          <XCircle
            className="h-4 w-4 text-rose-500 shrink-0"
            aria-hidden="true"
          />
        )
    }
  }

  const getBorderColor = (category: NotificationCategory) => {
    switch (category) {
      case 'success':
        return 'border-l-emerald-500'
      case 'info':
        return 'border-l-blue-500'
      case 'warning':
        return 'border-l-amber-500'
      case 'error':
        return 'border-l-rose-500'
    }
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="relative inline-block text-left" ref={panelRef}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={buttonRef}
              type="button"
              onClick={togglePanel}
              aria-expanded={isOpen}
              aria-haspopup="true"
              aria-label={`Notifications (${unreadCount} unread)`}
              className="relative p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Bell className="h-5 w-5" aria-hidden="true" />
              {unreadCount > 0 && (
                <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-bold text-white ring-2 ring-background animate-in zoom-in-50">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Notifications</TooltipContent>
        </Tooltip>

        {isOpen && (
          <div
            role="dialog"
            aria-label="Notification center"
            className="absolute right-0 top-full mt-2 w-80 sm:w-96 rounded-xl border border-border bg-popover text-popover-foreground shadow-xl z-50 flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-100 max-h-[500px]"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/20">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-foreground">
                  Notifications
                </h2>
                {unreadCount > 0 ? (
                  <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-semibold text-blue-600 dark:text-blue-400">
                    {unreadCount} unread
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    All read
                  </span>
                )}
              </div>

              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllAsRead}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded px-1.5 py-0.5"
                >
                  <CheckCheck
                    className="h-3.5 w-3.5 text-blue-500"
                    aria-hidden="true"
                  />
                  <span>Mark all as read</span>
                </button>
              )}
            </div>

            {/* Filter Toggle Bar */}
            <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border/60 bg-muted/10 text-xs">
              <button
                type="button"
                onClick={() => setFilter('all')}
                className={cn(
                  'px-2 py-0.5 rounded-md font-medium transition-colors',
                  filter === 'all'
                    ? 'bg-background text-foreground shadow-sm border border-border/60'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                All ({notifications.length})
              </button>
              <button
                type="button"
                onClick={() => setFilter('unread')}
                className={cn(
                  'px-2 py-0.5 rounded-md font-medium transition-colors',
                  filter === 'unread'
                    ? 'bg-background text-foreground shadow-sm border border-border/60'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Unread ({unreadCount})
              </button>
            </div>

            {/* Notification List (Internal Scrolling) */}
            <div className="flex-1 overflow-y-auto divide-y divide-border/50 max-h-[340px]">
              {filteredNotifications.length === 0 ? (
                <EmptyInbox state={feedState} filter={filter} />
              ) : (
                filteredNotifications.map((notif) => (
                  <div
                    key={notif.id}
                    onClick={() => {
                      if (!notif.read) markAsRead(notif.id)
                    }}
                    className={cn(
                      'group relative flex items-start gap-3 p-3.5 transition-colors cursor-pointer border-l-2',
                      getBorderColor(notif.category),
                      notif.read
                        ? 'bg-transparent hover:bg-accent/40'
                        : 'bg-muted/30 hover:bg-muted/60'
                    )}
                  >
                    <div className="mt-0.5 shrink-0">
                      {renderStatusIcon(notif.category)}
                    </div>

                    <div className="flex-1 min-w-0 pr-2">
                      <div className="flex items-center justify-between gap-2">
                        <p
                          className={cn(
                            'text-xs font-semibold truncate',
                            notif.read
                              ? 'text-foreground/80'
                              : 'text-foreground'
                          )}
                        >
                          {notif.title}
                        </p>
                        <span className="text-[10px] text-muted-foreground shrink-0 whitespace-nowrap">
                          {formatTimestamp(notif.timestamp)}
                        </span>
                      </div>

                      <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5 leading-relaxed">
                        {notif.description}
                      </p>

                      <AlertBadges
                        severity={notif.severity}
                        resolved={notif.resolved}
                      />

                      {(notif.occurrenceCount ?? 1) > 1 && (
                        <p className="mt-1 text-[10px] font-medium text-muted-foreground">
                          Occurred {notif.occurrenceCount} times
                        </p>
                      )}

                      {notif.actionUrl && (
                        <div className="mt-1.5">
                          <Link
                            href={notif.actionUrl}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (!notif.read) markAsRead(notif.id)
                              closePanel()
                            }}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            <span>
                              {notif.actionLabel || 'View destination'}
                            </span>
                            <ExternalLink
                              className="h-3 w-3"
                              aria-hidden="true"
                            />
                          </Link>
                        </div>
                      )}
                    </div>

                    {/* Unread indicator dot */}
                    {!notif.read && (
                      <span
                        aria-label="Unread notification"
                        className="h-2 w-2 rounded-full bg-blue-600 shrink-0 mt-1.5"
                      />
                    )}
                    <button
                      type="button"
                      aria-label={`Dismiss ${notif.title}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        dismiss(notif.id)
                      }}
                      className="absolute right-2 bottom-2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            {hasReadNotifications && (
              <div className="p-2 border-t border-border bg-muted/20 flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={clearRead}
                  className="flex items-center gap-1 text-muted-foreground hover:text-foreground font-medium px-2 py-1 rounded transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Clear read notifications</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
