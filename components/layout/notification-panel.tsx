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
} from 'lucide-react'
import {
  useNotifications,
  NotificationCategory,
} from '@/components/providers/notification-provider'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function NotificationPanel() {
  const { notifications, unreadCount, markAsRead, markAllAsRead, clearRead } =
    useNotifications()

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
                <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
                  <div className="w-10 h-10 rounded-full bg-muted/50 flex items-center justify-center mb-2">
                    <Sparkles
                      className="h-5 w-5 text-muted-foreground/70"
                      aria-hidden="true"
                    />
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    You’re all caught up
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    No {filter === 'unread' ? 'unread ' : ''}notifications at
                    this time.
                  </p>
                </div>
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
