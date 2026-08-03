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

const STORAGE_KEY = 'hawkview_notifications_v1'

const DEFAULT_NOTIFICATIONS: NotificationItem[] = [
  {
    id: 'notif-1',
    category: 'info',
    title: 'Initial tenant synchronization started',
    description: 'Sync initiated for AlphaTech Solutions and Delta Health.',
    timestamp: '10m ago',
    read: false,
    actionUrl: '/tenants',
  },
  {
    id: 'notif-2',
    category: 'warning',
    title: 'Connector credentials approaching expiration',
    description:
      'Microsoft Graph connector secret for Startup Labs expires in 7 days.',
    timestamp: '1h ago',
    read: false,
    actionUrl: '/tenants',
  },
  {
    id: 'notif-3',
    category: 'warning',
    title: 'Microsoft permissions are missing',
    description:
      'Gamma MS tenant requires consent for Directory.ReadWrite.All.',
    timestamp: '3h ago',
    read: false,
    actionUrl: '/tenants',
  },
  {
    id: 'notif-4',
    category: 'success',
    title: 'Settings saved successfully',
    description: 'Global security policy thresholds were updated.',
    timestamp: '1d ago',
    read: true,
  },
  {
    id: 'notif-5',
    category: 'error',
    title: 'Tenant synchronization failed',
    description: 'Authentication timeout while syncing Contoso Corp.',
    timestamp: '2d ago',
    read: true,
  },
]

const NotificationContext = createContext<NotificationContextValue | null>(null)

export function NotificationProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [isInitialized, setIsInitialized] = useState(false)

  // Initialize from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setNotifications(parsed)
          setIsInitialized(true)
          return
        }
      }
    } catch (e) {
      console.error('Failed to load notifications from localStorage', e)
    }
    setNotifications(DEFAULT_NOTIFICATIONS)
    setIsInitialized(true)
  }, [])

  // Persist to localStorage
  useEffect(() => {
    if (!isInitialized) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications))
    } catch (e) {
      console.error('Failed to save notifications to localStorage', e)
    }
  }, [notifications, isInitialized])

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
      const newNotif: NotificationItem = {
        id: `notif-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        category,
        title,
        description,
        timestamp: 'Just now',
        read: false,
        actionUrl,
        actionLabel,
      }

      setNotifications((prev) => [newNotif, ...prev])

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
  }, [])

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
  }, [])

  const clearRead = useCallback(() => {
    setNotifications((prev) => prev.filter((n) => !n.read))
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
