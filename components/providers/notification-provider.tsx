'use client'

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from 'react'
import { CheckCircle2, Info, AlertTriangle, XCircle, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/components/providers/auth-provider'
import { apiClient } from '@/lib/api/client'

export type NotificationCategory = 'success' | 'info' | 'warning' | 'error'

export interface NotificationItem {
  id: string
  category: NotificationCategory
  title: string
  description: string
  timestamp: string
  read: boolean
  actionUrl?: string
  actionLabel?: string
}

export interface ToastItem {
  id: string
  category: NotificationCategory
  title: string
  description?: string
  duration?: number
}

interface NotificationContextValue {
  notifications: NotificationItem[]
  unreadCount: number
  toasts: ToastItem[]
  notify: (payload: {
    title: string
    description: string
    category: NotificationCategory
    actionUrl?: string
    actionLabel?: string
    showToast?: boolean
  }) => void
  markAsRead: (id: string) => void
  markAllAsRead: () => void
  clearRead: () => void
  removeToast: (id: string) => void
}

const NotificationContext = createContext<NotificationContextValue | null>(null)

export function NotificationProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const { session } = useAuth()
  const userId = session?.user.id
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [toasts, setToasts] = useState<ToastItem[]>([])

  // Notifications belong to the signed-in HawkView user and are loaded from
  // the API. Nothing here is seeded or persisted in the browser.
  useEffect(() => {
    let cancelled = false

    if (!userId) {
      setNotifications([])
      return
    }

    apiClient
      .get<NotificationItem[]>('/api/notifications')
      .then((items) => {
        if (!cancelled) setNotifications(items)
      })
      .catch((error) => {
        console.error('Failed to load notifications', error)
      })

    return () => {
      cancelled = true
    }
  }, [userId])

  const unreadCount = notifications.filter((n) => !n.read).length

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const notify = useCallback(
    ({
      title,
      description,
      category,
      actionUrl,
      actionLabel,
      showToast = true,
    }: {
      title: string
      description: string
      category: NotificationCategory
      actionUrl?: string
      actionLabel?: string
      showToast?: boolean
    }) => {
      const temporaryNotification: NotificationItem = {
        id: `notif-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        category,
        title,
        description,
        timestamp: 'Just now',
        read: false,
        actionUrl,
        actionLabel,
      }

      setNotifications((prev) => [temporaryNotification, ...prev])

      void apiClient
        .post<NotificationItem>('/api/notifications', {
          title,
          description,
          category,
          actionUrl,
          actionLabel,
        })
        .then((saved) => {
          setNotifications((prev) =>
            prev.map((item) =>
              item.id === temporaryNotification.id ? saved : item
            )
          )
        })
        .catch((error) => {
          setNotifications((prev) =>
            prev.filter((item) => item.id !== temporaryNotification.id)
          )
          console.error('Failed to save notification', error)
        })

      if (showToast) {
        const toastId = `toast-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
        const duration =
          category === 'error' || category === 'warning' ? 8000 : 4000
        const newToast: ToastItem = {
          id: toastId,
          category,
          title,
          description,
          duration,
        }

        setToasts((prev) => [...prev, newToast])

        setTimeout(() => {
          removeToast(toastId)
        }, duration)
      }
    },
    [removeToast]
  )

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    )
    void apiClient
      .patch(`/api/notifications/${encodeURIComponent(id)}/read`)
      .catch((error) => console.error('Failed to mark notification read', error))
  }, [])

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
    void apiClient
      .post('/api/notifications/read-all')
      .catch((error) => console.error('Failed to mark notifications read', error))
  }, [])

  const clearRead = useCallback(() => {
    setNotifications((prev) => prev.filter((n) => !n.read))
    void apiClient
      .delete('/api/notifications/read')
      .catch((error) => console.error('Failed to clear notifications', error))
  }, [])

  // Listen to window custom events for decoupled notifications
  useEffect(() => {
    const handleCustomNotify = (e: Event) => {
      const customEvent = e as CustomEvent
      if (customEvent.detail) {
        notify(customEvent.detail)
      }
    }

    window.addEventListener('hawkview-notify', handleCustomNotify)
    return () => {
      window.removeEventListener('hawkview-notify', handleCustomNotify)
    }
  }, [notify])

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        toasts,
        notify,
        markAsRead,
        markAllAsRead,
        clearRead,
        removeToast,
      }}
    >
      {children}
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </NotificationContext.Provider>
  )
}

export function useNotifications() {
  const context = useContext(NotificationContext)
  if (!context) {
    throw new Error('useNotifications must be used within NotificationProvider')
  }
  return context
}

// Global helper function to trigger a notification from anywhere
export function triggerNotification(payload: {
  title: string
  description: string
  category: NotificationCategory
  actionUrl?: string
  actionLabel?: string
  showToast?: boolean
}) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('hawkview-notify', {
        detail: payload,
      })
    )
  }
}

function ToastContainer({
  toasts,
  removeToast,
}: {
  toasts: ToastItem[]
  removeToast: (id: string) => void
}) {
  if (toasts.length === 0) return null

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="fixed top-16 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full pointer-events-none p-2"
    >
      {toasts.map((toast) => {
        const isError = toast.category === 'error'
        const isWarning = toast.category === 'warning'
        const isSuccess = toast.category === 'success'

        return (
          <div
            key={toast.id}
            role={isError ? 'alert' : 'status'}
            aria-live={isError ? 'assertive' : 'polite'}
            className={cn(
              'pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg transition-all duration-200 border-l-4 animate-in fade-in slide-in-from-top-2',
              isSuccess && 'border-l-emerald-500',
              toast.category === 'info' && 'border-l-blue-500',
              isWarning && 'border-l-amber-500',
              isError && 'border-l-rose-500'
            )}
          >
            <div className="mt-0.5 shrink-0">
              {isSuccess && (
                <CheckCircle2
                  className="h-5 w-5 text-emerald-500"
                  aria-hidden="true"
                />
              )}
              {toast.category === 'info' && (
                <Info className="h-5 w-5 text-blue-500" aria-hidden="true" />
              )}
              {isWarning && (
                <AlertTriangle
                  className="h-5 w-5 text-amber-500"
                  aria-hidden="true"
                />
              )}
              {isError && (
                <XCircle className="h-5 w-5 text-rose-500" aria-hidden="true" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground">
                {toast.title}
              </p>
              {toast.description && (
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  {toast.description}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Close toast notification"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
