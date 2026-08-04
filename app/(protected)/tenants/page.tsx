'use client'

import { NeedsAttentionCell } from '@/components/tenants/needs-attention-cell'
import { computeTenantAttention } from '@/lib/attention/computeTenantAttention'
import { topAttention } from '@/lib/attention/topAttention'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Search,
  Plus,
  Clock,
  ChevronRight,
  AlertCircle,
  RefreshCw,
  Trash2,
  LayoutGrid,
  List,
  X,
  ShieldCheck,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { useTenants } from '@/lib/api/hooks'
import { apiClient } from '@/lib/api/client'
import type {
  CreateTenantResponse,
  MicrosoftConsentResponse,
  Tenant,
} from '@/types/api'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'

type Provider = 'microsoft' | 'google'
type TenantStatus = 'pending' | 'active' | 'suspended' | 'disconnected'

type FilterType = 'all' | 'microsoft' | 'google'
type ViewMode = 'tile' | 'list'
type SortField =
  | 'name'
  | 'status'
  | 'needsAttention'
  | 'secureScore'
  | 'lastSync'
type SortOrder = 'asc' | 'desc'

const MICROSOFT_CONSENT_MESSAGE = 'hawkview:microsoft-consent-complete'
const MICROSOFT_CONSENT_CHANNEL = 'hawkview:microsoft-consent'
const MICROSOFT_CONSENT_POPUP_MARKER = 'hawkview:microsoft-consent-popup'

type MicrosoftConsentMessage = {
  type: typeof MICROSOFT_CONSENT_MESSAGE
  result: string
  error: string | null
  tenantId: string | null
}

function SortHeader({
  field,
  label,
  activeField,
  sortOrder,
  onSort,
  align = 'left',
}: {
  field: SortField
  label: string
  activeField: SortField
  sortOrder: SortOrder
  onSort: (field: SortField) => void
  align?: 'left' | 'right' | 'center'
}) {
  const isActive = activeField === field
  const ariaSort = isActive
    ? sortOrder === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none'

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={cn(
        'py-3 px-4 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider select-none',
        align === 'right'
          ? 'text-right'
          : align === 'center'
            ? 'text-center'
            : 'text-left'
      )}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn(
          'inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1 -mx-1 py-0.5 transition-colors hover:text-slate-900 dark:hover:text-white',
          isActive && 'text-blue-600 dark:text-blue-400 font-bold'
        )}
      >
        <span>{label}</span>
        {isActive ? (
          sortOrder === 'asc' ? (
            <ArrowUp
              className="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400"
              aria-hidden="true"
            />
          ) : (
            <ArrowDown
              className="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400"
              aria-hidden="true"
            />
          )
        ) : (
          <ArrowUpDown
            className="h-3.5 w-3.5 shrink-0 opacity-40 hover:opacity-75 transition-opacity"
            aria-hidden="true"
          />
        )}
      </button>
    </th>
  )
}

function statusBadge(status: TenantStatus) {
  switch (status) {
    case 'active':
      return 'bg-green-50 text-green-700 border border-green-200'
    case 'pending':
      return 'bg-orange-50 text-orange-700 border border-orange-200'
    case 'suspended':
    case 'disconnected':
      return 'bg-red-50 text-red-700 border border-red-200'
  }
}

function scoreColor(score: number) {
  if (score >= 80) return 'text-green-600'
  if (score >= 50) return 'text-orange-600'
  return 'text-red-600'
}

function formatSyncTime(timeStr: string | null) {
  if (!timeStr) return 'Not synced yet'
  if (timeStr.includes('T')) {
    try {
      const d = new Date(timeStr)
      if (isNaN(d.getTime())) return 'time unavailable'
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(d)
    } catch {
      return timeStr
    }
  }
  return timeStr
}

function ProviderIcon({
  provider,
  size = 'normal',
}: {
  provider: Provider
  size?: 'normal' | 'small'
}) {
  return provider === 'microsoft' ? (
    <MicrosoftMark size={size} />
  ) : (
    <GoogleMark size={size} />
  )
}

function MicrosoftMark({ size = 'normal' }: { size?: 'normal' | 'small' }) {
  const isSmall = size === 'small'
  return (
    <div
      className={`${
        isSmall ? 'w-10 h-10 rounded-xl' : 'w-14 h-14 rounded-2xl'
      } flex items-center justify-center border shadow-sm bg-blue-50 border-blue-100 shrink-0`}
    >
      <div className="grid grid-cols-2 gap-1">
        <span
          className={`${isSmall ? 'h-2 w-2' : 'h-3 w-3'} bg-[#F25022] rounded-[2px]`}
        />
        <span
          className={`${isSmall ? 'h-2 w-2' : 'h-3 w-3'} bg-[#7FBA00] rounded-[2px]`}
        />
        <span
          className={`${isSmall ? 'h-2 w-2' : 'h-3 w-3'} bg-[#00A4EF] rounded-[2px]`}
        />
        <span
          className={`${isSmall ? 'h-2 w-2' : 'h-3 w-3'} bg-[#FFB900] rounded-[2px]`}
        />
      </div>
    </div>
  )
}

function GoogleMark({ size = 'normal' }: { size?: 'normal' | 'small' }) {
  const isSmall = size === 'small'
  return (
    <div
      className={`${
        isSmall ? 'w-10 h-10 rounded-xl' : 'w-14 h-14 rounded-2xl'
      } flex items-center justify-center border shadow-sm bg-red-50 border-red-100 shrink-0`}
    >
      <svg
        width={isSmall ? '20' : '28'}
        height={isSmall ? '20' : '28'}
        viewBox="0 0 48 48"
        aria-hidden="true"
      >
        <path
          fill="#FFC107"
          d="M43.611 20.083H42V20H24v8h11.303C33.708 32.91 29.22 36 24 36c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.971 3.029l5.657-5.657C34.046 6.053 29.272 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.651-.389-3.917z"
        />
        <path
          fill="#FF3D00"
          d="M6.306 14.691l6.571 4.819C14.655 16.108 19.009 12 24 12c3.059 0 5.842 1.154 7.971 3.029l5.657-5.657C34.046 6.053 29.272 4 24 4c-7.682 0-14.409 4.328-17.694 10.691z"
        />
        <path
          fill="#4CAF50"
          d="M24 44c5.118 0 9.786-1.969 13.314-5.186l-6.143-5.197C29.136 35.091 26.7 36 24 36c-5.199 0-9.677-3.067-11.29-7.463l-6.52 5.02C9.44 39.556 16.227 44 24 44z"
        />
        <path
          fill="#1976D2"
          d="M43.611 20.083H42V20H24v8h11.303c-.792 2.26-2.231 4.191-4.132 5.617l.002-.001 6.143 5.197C36.91 39.186 44 34 44 24c0-1.341-.138-2.651-.389-3.917z"
        />
      </svg>
    </div>
  )
}

export default function TenantsPage() {
  const queryClient = useQueryClient()
  const { data, isLoading, isFetching, error, refetch } = useTenants()

  const onboardButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const consentPopupRef = useRef<Window | null>(null)
  const consentPopupMonitorRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  )

  const [searchQuery, setSearchQuery] = useState('')
  const [filter, setFilter] = useState<FilterType>('all')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingStep, setOnboardingStep] = useState<
    'select' | 'hawkview' | 'manual'
  >('select')
  const [hawkviewPreviewMessage, setHawkviewPreviewMessage] = useState<
    string | null
  >(null)

  const [microsoftTenantId, setMicrosoftTenantId] = useState('')
  const [connectionMode, setConnectionMode] = useState<
    'HAWKVIEW_MANAGED' | 'CUSTOMER_MANAGED'
  >('HAWKVIEW_MANAGED')
  const [customerClientId, setCustomerClientId] = useState('')
  const [customerClientSecret, setCustomerClientSecret] = useState('')
  const [onboardingError, setOnboardingError] = useState<string | null>(null)
  const [consentMessage, setConsentMessage] = useState<{
    text: string
    tone: 'success' | 'warning'
  } | null>(null)
  const [consentReview, setConsentReview] =
    useState<MicrosoftConsentResponse | null>(null)
  const [isSavingTenant, setIsSavingTenant] = useState(false)
  const [deletingTenantId, setDeletingTenantId] = useState<string | null>(null)

  const loading = isLoading || isFetching
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(
        'hawkview_tenants_view_mode'
      ) as ViewMode | null
      if (saved === 'tile' || saved === 'list') {
        setViewMode(saved)
      }
    } catch {
      // ignore
    }
  }, [])

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode)
    try {
      localStorage.setItem('hawkview_tenants_view_mode', mode)
    } catch {
      // ignore
    }
  }

  const handleCloseOnboarding = useCallback(
    (force = false) => {
      if (isSavingTenant && !force) return
      if (!force && onboardingStep === 'manual') {
        const hasEnteredValues =
          microsoftTenantId.trim().length > 0 ||
          customerClientId.trim().length > 0 ||
          customerClientSecret.trim().length > 0
        if (hasEnteredValues) {
          const confirmClose = window.confirm(
            'Discard entered application registration credentials?'
          )
          if (!confirmClose) return
        }
      }
      setShowOnboarding(false)
      setOnboardingError(null)
      setConsentReview(null)
      setHawkviewPreviewMessage(null)
      setOnboardingStep('select')
      setCustomerClientSecret('')
      setTimeout(() => {
        onboardButtonRef.current?.focus()
      }, 0)
    },
    [
      customerClientId,
      customerClientSecret,
      isSavingTenant,
      microsoftTenantId,
      onboardingStep,
    ]
  )

  useEffect(() => {
    if (!showOnboarding) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!isSavingTenant) {
          handleCloseOnboarding()
        }
      } else if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleCloseOnboarding, isSavingTenant, showOnboarding])

  useEffect(() => {
    if (!loading) {
      setElapsedSeconds(0)
      return
    }
    setElapsedSeconds(0)
    const interval = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1)
    }, 1000)

    return () => clearInterval(interval)
  }, [loading])

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const result = searchParams.get('microsoftConsent')
    const consentError = searchParams.get('error')
    const tenantId = searchParams.get('tenantId')
    if (!result) return

    const message: MicrosoftConsentMessage = {
      type: MICROSOFT_CONSENT_MESSAGE,
      result,
      error: consentError,
      tenantId,
    }
    const hasPopupMarker =
      window.sessionStorage.getItem(MICROSOFT_CONSENT_POPUP_MARKER) === 'true'
    const isConsentPopup =
      hasPopupMarker ||
      window.name === 'hawkview-microsoft-consent' ||
      (window.opener && !window.opener.closed)

    if (isConsentPopup) {
      window.sessionStorage.removeItem(MICROSOFT_CONSENT_POPUP_MARKER)
      if ('BroadcastChannel' in window) {
        const channel = new BroadcastChannel(MICROSOFT_CONSENT_CHANNEL)
        channel.postMessage(message)
        channel.close()
      }
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(message, window.location.origin)
      }
      window.setTimeout(() => window.close(), 100)
      return
    }

    if (result === 'success') {
      setConsentMessage({
        text: 'Microsoft 365 connection verified. HawkView is ready for the initial sync.',
        tone: 'success',
      })
      queryClient.invalidateQueries({ queryKey: ['tenants'] })
    } else if (result === 'missing-permissions') {
      setConsentMessage({
        text: 'Microsoft consent completed, but one or more required permissions are missing.',
        tone: 'warning',
      })
      queryClient.invalidateQueries({ queryKey: ['tenants'] })
    } else if (result === 'error') {
      setOnboardingError(
        'Microsoft administrator consent could not be verified. Review the tenant connection and try again.'
      )
      queryClient.invalidateQueries({ queryKey: ['tenants'] })
    }

    const cleanUrl = new URL(window.location.href)
    cleanUrl.searchParams.delete('microsoftConsent')
    cleanUrl.searchParams.delete('error')
    cleanUrl.searchParams.delete('tenantId')
    window.history.replaceState({}, '', cleanUrl)
  }, [queryClient])

  useEffect(() => {
    const handleConsentResult = (data: unknown) => {
      if (!data || typeof data !== 'object') return

      const message = data as Partial<MicrosoftConsentMessage>
      if (message.type !== MICROSOFT_CONSENT_MESSAGE) return

      if (consentPopupMonitorRef.current) {
        clearInterval(consentPopupMonitorRef.current)
        consentPopupMonitorRef.current = null
      }
      consentPopupRef.current?.close()
      consentPopupRef.current = null
      setIsSavingTenant(false)
      setShowOnboarding(false)
      setConsentReview(null)
      setOnboardingStep('select')

      if (message.result === 'success') {
        setOnboardingError(null)
        setConsentMessage({
          text: 'Microsoft 365 connection verified. HawkView is ready for the initial sync.',
          tone: 'success',
        })
      } else if (message.result === 'missing-permissions') {
        setOnboardingError(null)
        setConsentMessage({
          text: 'Microsoft consent completed, but one or more required permissions are missing.',
          tone: 'warning',
        })
      } else {
        setOnboardingError(
          'Microsoft administrator consent could not be verified. Review the tenant connection and try again.'
        )
      }

      queryClient.invalidateQueries({ queryKey: ['tenants'] })
      setTimeout(() => onboardButtonRef.current?.focus(), 0)
    }

    const handleConsentMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return
      handleConsentResult(event.data)
    }

    const channel =
      'BroadcastChannel' in window
        ? new BroadcastChannel(MICROSOFT_CONSENT_CHANNEL)
        : null
    if (channel) {
      channel.onmessage = (event: MessageEvent<unknown>) =>
        handleConsentResult(event.data)
    }

    window.addEventListener('message', handleConsentMessage)
    return () => {
      window.removeEventListener('message', handleConsentMessage)
      channel?.close()
    }
  }, [queryClient])

  useEffect(
    () => () => {
      if (consentPopupMonitorRef.current) {
        clearInterval(consentPopupMonitorRef.current)
      }
      consentPopupRef.current?.close()
    },
    []
  )

  const tenants = data?.tenants || []
  const errorMessage = error ? (error as Error).message : data?.error || null

  const handleRetry = () => {
    queryClient.invalidateQueries({ queryKey: ['tenants'] })
    refetch()
  }

  const handleCreateTenant = async (event: React.FormEvent) => {
    event.preventDefault()
    setOnboardingError(null)
    setIsSavingTenant(true)

    try {
      const created = await apiClient.post<CreateTenantResponse>(
        '/api/tenants',
        {
          microsoftTenantId,
          connectionMode,
          ...(connectionMode === 'CUSTOMER_MANAGED'
            ? {
                clientId: customerClientId,
                clientSecret: customerClientSecret,
              }
            : {}),
        }
      )
      await queryClient.invalidateQueries({ queryKey: ['tenants'] })
      setMicrosoftTenantId('')
      setCustomerClientId('')
      setCustomerClientSecret('')
      if (!created.requiresConsent) {
        handleCloseOnboarding(true)
        setConsentMessage({
          text: 'App registration Microsoft connection verified and stored securely. HawkView is ready for the initial sync.',
          tone: 'success',
        })
        return
      }
      const consent = await apiClient.post<MicrosoftConsentResponse>(
        `/api/tenants/${created.tenant.id}/microsoft-consent`
      )
      setConsentReview(consent)
    } catch (createError) {
      setOnboardingError(
        createError instanceof Error
          ? createError.message
          : 'Tenant onboarding could not be completed.'
      )
    } finally {
      setIsSavingTenant(false)
    }
  }

  const openMicrosoftConsentPopup = async (
    getConsent: () => Promise<MicrosoftConsentResponse>
  ) => {
    const width = 640
    const height = 760
    const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2)
    const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2)
    const popup = window.open(
      '',
      'hawkview-microsoft-consent',
      `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)},resizable=yes,scrollbars=yes`
    )

    if (!popup) {
      setOnboardingError(
        'Your browser blocked the Microsoft sign-in window. Allow pop-ups for HawkView and try again.'
      )
      return
    }

    consentPopupRef.current = popup
    setOnboardingError(null)
    setIsSavingTenant(true)
    try {
      popup.document.title = 'Connecting to Microsoft 365'
      popup.sessionStorage.setItem(MICROSOFT_CONSENT_POPUP_MARKER, 'true')
      popup.document.body.innerHTML =
        '<main style="font-family:system-ui;padding:32px;color:#0f172a"><h2>Connecting to Microsoft 365...</h2><p>This window will close automatically when authorization is complete.</p></main>'
    } catch {
      // The temporary same-origin document is optional.
    }

    try {
      const consent = await getConsent()
      if (popup.closed) {
        throw new Error(
          'The Microsoft sign-in window was closed before authorization started.'
        )
      }
      popup.location.replace(consent.consentUrl)
      popup.focus()

      if (consentPopupMonitorRef.current) {
        clearInterval(consentPopupMonitorRef.current)
      }
      consentPopupMonitorRef.current = setInterval(() => {
        if (!popup.closed) return
        if (consentPopupMonitorRef.current) {
          clearInterval(consentPopupMonitorRef.current)
          consentPopupMonitorRef.current = null
        }
        consentPopupRef.current = null
        setIsSavingTenant(false)
        queryClient.invalidateQueries({ queryKey: ['tenants'] })
      }, 500)
    } catch (error) {
      popup.close()
      consentPopupRef.current = null
      setIsSavingTenant(false)
      setOnboardingError(
        error instanceof Error
          ? error.message
          : 'Microsoft tenant onboarding could not be started.'
      )
    }
  }

  const handleManagedOnboarding = () => {
    setOnboardingError(null)
    setHawkviewPreviewMessage(null)
    void openMicrosoftConsentPopup(() =>
      apiClient.post<MicrosoftConsentResponse>(
        '/api/tenants/microsoft/onboarding'
      )
    )
  }

  const handleReviewConsent = async (tenant: Tenant) => {
    setOnboardingError(null)
    setIsSavingTenant(true)
    try {
      const consent = await apiClient.post<MicrosoftConsentResponse>(
        `/api/tenants/${tenant.id}/microsoft-consent`
      )
      setConsentReview(consent)
      setShowOnboarding(true)
    } catch (consentError) {
      setShowOnboarding(true)
      setOnboardingError(
        consentError instanceof Error
          ? consentError.message
          : 'Microsoft consent could not be started.'
      )
    } finally {
      setIsSavingTenant(false)
    }
  }

  const handleRemovePendingTenant = async (tenant: Tenant) => {
    const confirmed = window.confirm(
      `Remove "${tenant.name}" from HawkView? This only removes this pending setup record.`
    )
    if (!confirmed) return

    setOnboardingError(null)
    setDeletingTenantId(tenant.id)
    try {
      await apiClient.delete<{ removed: boolean; tenantId: string }>(
        `/api/tenants/${tenant.id}`,
        undefined
      )
      await queryClient.invalidateQueries({ queryKey: ['tenants'] })
      setConsentMessage({
        text: `${tenant.name} was removed from the pending tenant list.`,
        tone: 'success',
      })
    } catch (deleteError) {
      setOnboardingError(
        deleteError instanceof Error
          ? deleteError.message
          : 'The pending tenant could not be removed.'
      )
    } finally {
      setDeletingTenantId(null)
    }
  }

  const handleRemoveActiveTenant = async (tenant: Tenant) => {
    const confirmation = window.prompt(
      `This permanently removes "${tenant.name}" from HawkView and deletes its stored customer credential.\n\nType the Microsoft tenant ID to continue:\n${tenant.microsoftTenantId}`
    )
    if (confirmation === null) return

    if (
      confirmation.trim().toLowerCase() !==
      tenant.microsoftTenantId.toLowerCase()
    ) {
      setOnboardingError('The Microsoft tenant ID did not match.')
      return
    }

    setOnboardingError(null)
    setDeletingTenantId(tenant.id)
    try {
      await apiClient.delete<{
        removed: boolean
        tenantId: string
        credentialRemoved: boolean
      }>(`/api/tenants/${tenant.id}`, {
        confirmMicrosoftTenantId: confirmation,
      })
      await queryClient.invalidateQueries({ queryKey: ['tenants'] })
      setConsentMessage({
        text: `${tenant.name} and its stored connection were removed from HawkView.`,
        tone: 'success',
      })
    } catch (deleteError) {
      setOnboardingError(
        deleteError instanceof Error
          ? deleteError.message
          : 'The tenant could not be removed.'
      )
    } finally {
      setDeletingTenantId(null)
    }
  }

  const [sortField, setSortField] = useState<SortField>('name')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortOrder('asc')
    }
  }

  const filteredTenants = useMemo(() => {
    const list = data?.tenants || []
    return list.filter((tenant: any) => {
      const q = searchQuery.toLowerCase()
      const matchesSearch =
        tenant.name?.toLowerCase().includes(q) ||
        tenant.domain?.toLowerCase().includes(q) ||
        tenant.id?.toLowerCase().includes(q)

      const matchesFilter = filter === 'all' || tenant.provider === filter
      return matchesSearch && matchesFilter
    })
  }, [data?.tenants, searchQuery, filter])

  const sortedTenants = useMemo(() => {
    const list = [...filteredTenants]
    return list.sort((a: Tenant, b: Tenant) => {
      let cmp = 0
      switch (sortField) {
        case 'name': {
          const nameA = (a.name || '').toLowerCase()
          const nameB = (b.name || '').toLowerCase()
          cmp = nameA.localeCompare(nameB)
          break
        }
        case 'status': {
          const statusOrder: Record<string, number> = {
            active: 1,
            pending: 2,
            suspended: 3,
            disconnected: 4,
          }
          const rankA = statusOrder[a.status] || 99
          const rankB = statusOrder[b.status] || 99
          cmp = rankA - rankB
          if (cmp === 0) {
            cmp = (a.name || '')
              .toLowerCase()
              .localeCompare((b.name || '').toLowerCase())
          }
          break
        }
        case 'needsAttention': {
          const getAttentionWeight = (t: any) => {
            const items = topAttention(
              computeTenantAttention({
                ...(t?.bundle ?? {}),
                connectionStatus: t?.connectionStatus,
                status: t?.status,
              })
            )
            if (!items.length) return 0
            return items.reduce((acc, item) => {
              if (item.severity === 'critical') return acc + 3
              if (item.severity === 'high') return acc + 2
              if (item.severity === 'medium') return acc + 1
              return acc
            }, 0)
          }
          const weightA = getAttentionWeight(a)
          const weightB = getAttentionWeight(b)
          cmp = weightA - weightB
          if (cmp === 0) {
            cmp = (a.name || '')
              .toLowerCase()
              .localeCompare((b.name || '').toLowerCase())
          }
          break
        }
        case 'secureScore': {
          const scoreA = a.secureScore
          const scoreB = b.secureScore
          if (scoreA == null && scoreB == null) cmp = 0
          else if (scoreA == null) cmp = -1000
          else if (scoreB == null) cmp = 1000
          else cmp = scoreA - scoreB
          break
        }
        case 'lastSync': {
          const getSyncTime = (ts: string | null) => {
            if (!ts) return 0
            const time = new Date(ts).getTime()
            return isNaN(time) ? 0 : time
          }
          const timeA = getSyncTime(a.lastSync)
          const timeB = getSyncTime(b.lastSync)
          if (timeA === 0 && timeB === 0) cmp = 0
          else if (timeA === 0) cmp = -100000000000000
          else if (timeB === 0) cmp = 100000000000000
          else cmp = timeA - timeB
          break
        }
      }
      return sortOrder === 'asc' ? cmp : -cmp
    })
  }, [filteredTenants, sortField, sortOrder])

  const tenantsAwaitingConsent = tenants.filter(
    (tenant) =>
      tenant.connectionStatus === 'pending-consent' ||
      tenant.connectionStatus === 'error'
  )

  const loadingText =
    elapsedSeconds < 15
      ? `Loading tenant directory… ${elapsedSeconds}s`
      : `HawkView API is taking longer than expected… ${elapsedSeconds}s`

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
            Tenant Directory
          </h1>
          <p className="mt-2 text-base text-slate-500 dark:text-slate-400">
            Select a tenant environment to manage security, licenses, and users.
          </p>
        </div>
        <Button
          ref={onboardButtonRef}
          className="gap-2 rounded-xl"
          onClick={() => {
            setOnboardingError(null)
            setConsentReview(null)
            setHawkviewPreviewMessage(null)
            setOnboardingStep('select')
            setShowOnboarding(true)
          }}
        >
          <Plus className="h-4 w-4" />
          Onboard New Tenant
        </Button>
      </div>

      {showOnboarding && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isSavingTenant) {
              handleCloseOnboarding()
            }
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboarding-modal-title"
            className="relative w-full max-w-[600px] max-h-[90vh] overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 md:p-8 shadow-2xl dark:border-slate-800 dark:bg-slate-900 animate-in zoom-in-95 duration-200"
          >
            <button
              type="button"
              onClick={() => handleCloseOnboarding()}
              disabled={isSavingTenant}
              className="absolute right-5 top-5 rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Close dialog"
            >
              <X className="h-5 w-5" />
            </button>

            {consentReview ? (
              <div className="space-y-5">
                <div>
                  <h2
                    id="onboarding-modal-title"
                    className="text-xl font-bold text-slate-900 dark:text-white"
                  >
                    Permissions requested by HawkView
                  </h2>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    A Microsoft 365 administrator will review these permissions
                    on Microsoft&apos;s consent screen.
                  </p>
                </div>
                <div className="grid gap-3 max-h-60 overflow-y-auto pr-1">
                  {consentReview.requiredPermissions.map((permission) => (
                    <div
                      key={permission.name}
                      className="rounded-xl border border-blue-200 bg-white p-4 dark:border-blue-900 dark:bg-slate-900"
                    >
                      <p className="font-semibold text-slate-900 dark:text-white">
                        {permission.name}
                      </p>
                      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                        {permission.description}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-3 pt-2">
                  <Button
                    type="button"
                    className="rounded-xl"
                    onClick={() =>
                      void openMicrosoftConsentPopup(() =>
                        Promise.resolve(consentReview)
                      )
                    }
                  >
                    Continue to Microsoft
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl"
                    onClick={() => setConsentReview(null)}
                  >
                    Back
                  </Button>
                </div>
              </div>
            ) : onboardingStep === 'select' ? (
              <div className="space-y-6">
                <div>
                  <h2
                    id="onboarding-modal-title"
                    className="text-xl font-bold text-slate-900 dark:text-white"
                  >
                    Onboard a Microsoft 365 tenant
                  </h2>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    Choose how HawkView will connect to the customer tenant.
                  </p>
                </div>

                <div className="grid gap-4">
                  <button
                    type="button"
                    onClick={() => {
                      setConnectionMode('HAWKVIEW_MANAGED')
                      setOnboardingStep('hawkview')
                      setHawkviewPreviewMessage(null)
                      setOnboardingError(null)
                    }}
                    className="group relative rounded-2xl border border-slate-200 bg-white p-5 text-left transition-all hover:border-blue-500 hover:shadow-md dark:border-slate-800 dark:bg-slate-900/80 dark:hover:border-blue-500"
                  >
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="font-bold text-slate-900 dark:text-white group-hover:text-blue-600 transition-colors">
                        HawkView-managed connection
                      </span>
                      <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 border-0 font-semibold px-2.5 py-0.5 rounded-full text-xs">
                        Recommended
                      </Badge>
                    </div>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      Sign in with a Microsoft 365 administrator account and
                      approve the permissions requested by HawkView.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setConnectionMode('CUSTOMER_MANAGED')
                      setOnboardingStep('manual')
                      setOnboardingError(null)
                    }}
                    className="group relative rounded-2xl border border-slate-200 bg-white p-5 text-left transition-all hover:border-blue-500 hover:shadow-md dark:border-slate-800 dark:bg-slate-900/80 dark:hover:border-blue-500"
                  >
                    <div className="mb-2">
                      <span className="font-bold text-slate-900 dark:text-white group-hover:text-blue-600 transition-colors">
                        Manually register the app
                      </span>
                    </div>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      Enter credentials from an application registration
                      controlled by the customer.
                    </p>
                  </button>
                </div>
              </div>
            ) : onboardingStep === 'hawkview' ? (
              <div className="space-y-5">
                {/* Header with small Microsoft logo inside soft-blue icon container */}
                <div className="flex items-start gap-3.5 pr-8">
                  <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-950/60 border border-blue-100 dark:border-blue-900/50 flex items-center justify-center shrink-0">
                    <div className="grid grid-cols-2 gap-0.5">
                      <span className="h-2 w-2 bg-[#F25022] rounded-[1px]" />
                      <span className="h-2 w-2 bg-[#7FBA00] rounded-[1px]" />
                      <span className="h-2 w-2 bg-[#00A4EF] rounded-[1px]" />
                      <span className="h-2 w-2 bg-[#FFB900] rounded-[1px]" />
                    </div>
                  </div>
                  <div>
                    <h2
                      id="onboarding-modal-title"
                      className="text-xl font-bold text-slate-900 dark:text-white"
                    >
                      Connect with Microsoft 365
                    </h2>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                      Authorize HawkView to securely read and monitor this
                      tenant.
                    </p>
                  </div>
                </div>

                {/* Compact three-step progress indicator */}
                <div className="flex items-center justify-between text-xs border-y border-slate-100 dark:border-slate-800 py-3 my-2">
                  <div className="flex items-center gap-2 font-semibold text-blue-600 dark:text-blue-400">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 dark:bg-blue-500 text-[11px] font-bold text-white shrink-0">
                      1
                    </span>
                    <span>Sign in</span>
                  </div>
                  <div className="h-px flex-1 mx-2 sm:mx-3 bg-slate-200 dark:bg-slate-800" />
                  <div className="flex items-center gap-2 text-slate-400 dark:text-slate-500 font-medium">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 dark:border-slate-800 text-[11px] shrink-0">
                      2
                    </span>
                    <span className="hidden sm:inline">Review permissions</span>
                    <span className="sm:hidden">Permissions</span>
                  </div>
                  <div className="h-px flex-1 mx-2 sm:mx-3 bg-slate-200 dark:bg-slate-800" />
                  <div className="flex items-center gap-2 text-slate-400 dark:text-slate-500 font-medium">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 dark:border-slate-800 text-[11px] shrink-0">
                      3
                    </span>
                    <span className="hidden sm:inline">Connect tenant</span>
                    <span className="sm:hidden">Connect</span>
                  </div>
                </div>

                {/* Informational Panel */}
                <div className="rounded-2xl border border-blue-100 dark:border-blue-900/40 bg-blue-50/60 dark:bg-blue-950/30 p-4 space-y-3">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                    What happens next?
                  </h3>
                  <ul className="space-y-2 text-xs text-slate-600 dark:text-slate-300">
                    <li className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
                      <span>
                        Sign in using a Microsoft 365 administrator account.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
                      <span>
                        Review the read-only permissions requested by HawkView.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
                      <span>
                        Approve access and return to HawkView automatically.
                      </span>
                    </li>
                  </ul>
                </div>

                {/* Security Note */}
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 px-1">
                  <ShieldCheck className="h-4 w-4 text-slate-400 shrink-0" />
                  <span>
                    HawkView never receives or stores your Microsoft
                    administrator password.
                  </span>
                </div>

                {/* Preview state feedback */}
                {hawkviewPreviewMessage && (
                  <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3.5 text-xs font-medium text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/50 dark:text-blue-200">
                    {hawkviewPreviewMessage}
                  </div>
                )}

                {/* Footer Buttons */}
                <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl px-5 sm:w-auto w-full"
                    onClick={() => {
                      setOnboardingStep('select')
                      setHawkviewPreviewMessage(null)
                      setOnboardingError(null)
                    }}
                  >
                    Back
                  </Button>

                  <Button
                    type="button"
                    className="gap-2.5 rounded-xl px-5 py-2.5 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-sm transition-all sm:w-auto w-full"
                    onClick={handleManagedOnboarding}
                    disabled={isSavingTenant}
                  >
                    <div className="grid grid-cols-2 gap-0.5 shrink-0">
                      <span className="h-1.5 w-1.5 bg-[#F25022] rounded-[0.5px]" />
                      <span className="h-1.5 w-1.5 bg-[#7FBA00] rounded-[0.5px]" />
                      <span className="h-1.5 w-1.5 bg-[#00A4EF] rounded-[0.5px]" />
                      <span className="h-1.5 w-1.5 bg-[#FFB900] rounded-[0.5px]" />
                    </div>
                    {isSavingTenant
                      ? 'Connecting to Microsoft...'
                      : 'Continue with Microsoft'}
                  </Button>
                </div>
              </div>
            ) : (
              /* manual step */
              <div className="space-y-6">
                <div>
                  <h2
                    id="onboarding-modal-title"
                    className="text-xl font-bold text-slate-900 dark:text-white"
                  >
                    Manually register the app
                  </h2>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    Enter credentials from an application registration
                    controlled by the customer.
                  </p>
                </div>

                <form onSubmit={handleCreateTenant} className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="microsoft-tenant-id">
                      Microsoft tenant ID
                    </Label>
                    <Input
                      id="microsoft-tenant-id"
                      value={microsoftTenantId}
                      onChange={(event) =>
                        setMicrosoftTenantId(event.target.value)
                      }
                      placeholder="00000000-0000-0000-0000-000000000000"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="customer-client-id">
                      Application (client) ID
                    </Label>
                    <Input
                      id="customer-client-id"
                      value={customerClientId}
                      onChange={(event) =>
                        setCustomerClientId(event.target.value)
                      }
                      placeholder="00000000-0000-0000-0000-000000000000"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="customer-client-secret">
                      Client secret value
                    </Label>
                    <Input
                      id="customer-client-secret"
                      type="password"
                      autoComplete="off"
                      value={customerClientSecret}
                      onChange={(event) =>
                        setCustomerClientSecret(event.target.value)
                      }
                      required
                    />
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Sent once to the backend, stored in Secret Manager, and
                      never returned to this browser.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 pt-2">
                    <Button
                      type="submit"
                      disabled={isSavingTenant}
                      className="rounded-xl px-5"
                    >
                      {isSavingTenant
                        ? 'Verifying…'
                        : 'Verify and Save Securely'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-xl px-5"
                      onClick={() => {
                        setOnboardingStep('select')
                        setOnboardingError(null)
                      }}
                    >
                      Back
                    </Button>
                  </div>
                </form>
              </div>
            )}

            {onboardingError && (
              <p className="mt-4 text-sm font-medium text-red-600 dark:text-red-400">
                {onboardingError}
              </p>
            )}
          </div>
        </div>
      )}

      {consentMessage && (
        <Card
          className={
            consentMessage.tone === 'success'
              ? 'rounded-2xl border-emerald-200 bg-emerald-50/80 dark:border-emerald-900 dark:bg-emerald-950/20'
              : 'rounded-2xl border-amber-200 bg-amber-50/80 dark:border-amber-900 dark:bg-amber-950/20'
          }
        >
          <CardContent
            className={
              consentMessage.tone === 'success'
                ? 'p-4 text-sm font-medium text-emerald-800 dark:text-emerald-300'
                : 'p-4 text-sm font-medium text-amber-800 dark:text-amber-300'
            }
          >
            {consentMessage.text}
          </CardContent>
        </Card>
      )}

      {onboardingError && !showOnboarding && (
        <Card className="rounded-2xl border-red-200 bg-red-50/80 dark:border-red-900 dark:bg-red-950/20">
          <CardContent className="p-4 text-sm font-medium text-red-800 dark:text-red-300">
            {onboardingError}
          </CardContent>
        </Card>
      )}

      {!loading && tenantsAwaitingConsent.length > 0 && !showOnboarding && (
        <Card className="rounded-2xl border-amber-200 bg-amber-50/80 dark:border-amber-900 dark:bg-amber-950/20">
          <CardContent className="space-y-4 p-5">
            <div>
              <h2 className="font-semibold text-slate-900 dark:text-white">
                Microsoft authorization required
              </h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                These tenants are saved, but HawkView cannot synchronize them
                until a Microsoft 365 administrator grants consent.
              </p>
            </div>
            {tenantsAwaitingConsent.map((tenant) => (
              <div
                key={tenant.id}
                className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-white p-4 dark:border-amber-900 dark:bg-slate-900 md:flex-row md:items-center md:justify-between"
              >
                <div>
                  <p className="font-semibold text-slate-900 dark:text-white">
                    {tenant.name}
                  </p>
                  <p className="text-sm text-slate-500">
                    {tenant.microsoftTenantId}
                  </p>
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    Missing: {tenant.missingPermissions.join(', ')}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    className="rounded-xl"
                    disabled={isSavingTenant || deletingTenantId === tenant.id}
                    onClick={() => handleReviewConsent(tenant)}
                  >
                    Review and Authorize
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                    disabled={isSavingTenant || deletingTenantId === tenant.id}
                    onClick={() => handleRemovePendingTenant(tenant)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {deletingTenantId === tenant.id
                      ? 'Removing...'
                      : 'Remove pending tenant'}
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Database API Error Alert */}
      {errorMessage && !loading && (
        <Card className="border-red-200 bg-red-50/80 dark:bg-red-950/20 dark:border-red-900/50 p-4 rounded-2xl">
          <div className="flex items-start gap-3 text-red-800 dark:text-red-300">
            <AlertCircle className="h-5 w-5 mt-0.5 shrink-0" />
            <div className="flex-1 text-sm">
              <p className="font-semibold">
                Unable to load the tenant directory
              </p>
              <p className="mt-1 text-red-700 dark:text-red-400">
                {errorMessage}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetry}
              className="gap-1.5 bg-white dark:bg-slate-900 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-950/60"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        </Card>
      )}

      {/* Search + Filter bar */}
      <div className="bg-white dark:bg-slate-900 p-2 rounded-2xl border shadow-sm flex flex-col md:flex-row gap-2 md:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search by name, domain, or ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-11 h-12 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
          />
        </div>

        <div className="flex items-center justify-between md:justify-end gap-2 border-t md:border-t-0 md:border-l border-slate-200 dark:border-slate-800 pt-2 md:pt-0 pl-0 md:pl-3">
          <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
            {(['all', 'microsoft', 'google'] as FilterType[]).map((type) => (
              <button
                key={type}
                onClick={() => setFilter(type)}
                className={[
                  'px-4 py-2 rounded-lg text-sm font-semibold transition-all',
                  filter === type
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-white',
                ].join(' ')}
              >
                {type === 'all'
                  ? 'All'
                  : type === 'microsoft'
                    ? 'Microsoft'
                    : 'Google'}
              </button>
            ))}
          </div>

          <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl gap-1">
            <button
              type="button"
              onClick={() => handleViewModeChange('tile')}
              title="Tile view"
              aria-label="Tile view"
              className={[
                'p-2 rounded-lg transition-all',
                viewMode === 'tile'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-white',
              ].join(' ')}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => handleViewModeChange('list')}
              title="List view"
              aria-label="List view"
              className={[
                'p-2 rounded-lg transition-all',
                viewMode === 'list'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-white',
              ].join(' ')}
            >
              <List className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-500 dark:text-slate-400">
            <RefreshCw className="h-4 w-4 animate-spin text-blue-600" />
            <span>{loadingText}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <Card
                key={i}
                className="animate-pulse p-6 bg-white dark:bg-slate-900 rounded-3xl border"
              >
                <div className="flex items-center gap-4 mb-6">
                  <div className="w-14 h-14 bg-slate-100 dark:bg-slate-800 rounded-2xl" />
                  <div className="space-y-2 flex-1">
                    <div className="h-5 bg-slate-100 dark:bg-slate-800 rounded w-3/4" />
                    <div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-1/2" />
                  </div>
                </div>
                <div className="h-16 bg-slate-50 dark:bg-slate-800/60 rounded-xl mb-4" />
                <div className="grid grid-cols-2 gap-4">
                  <div className="h-14 bg-slate-50 dark:bg-slate-800/60 rounded-xl" />
                  <div className="h-14 bg-slate-50 dark:bg-slate-800/60 rounded-xl" />
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Tenants Display */}
      {!loading &&
        sortedTenants.length > 0 &&
        (viewMode === 'tile' ? (
          /* Tile View */
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {sortedTenants.map((tenant: Tenant) => (
              <div key={tenant.id} className="space-y-2">
                <Link href={`/tenants/${tenant.id}`}>
                  <Card className="group bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 p-0 hover:border-blue-200 hover:shadow-xl hover:shadow-blue-500/5 transition-all duration-300 cursor-pointer relative overflow-hidden">
                    {/* accent */}
                    <div
                      className={[
                        'absolute top-0 right-0 w-32 h-32 opacity-5 rounded-bl-full pointer-events-none -mr-8 -mt-8',
                        tenant.provider === 'microsoft'
                          ? 'bg-blue-500'
                          : 'bg-red-500',
                      ].join(' ')}
                    />

                    <CardContent className="p-6">
                      <div className="flex items-start justify-between mb-5 relative z-10">
                        <div className="flex items-center gap-4">
                          <ProviderIcon provider={tenant.provider} />
                          <div>
                            <h3 className="text-lg font-semibold text-slate-900 dark:text-white group-hover:text-blue-600 transition-colors">
                              {tenant.name}
                            </h3>
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                              {tenant.domain || 'Domain not synced'}
                            </p>
                          </div>
                        </div>

                        <Badge
                          className={`uppercase tracking-wide ${statusBadge(tenant.status)}`}
                        >
                          {tenant.status}
                        </Badge>
                      </div>

                      {/* Needs Attention tags */}
                      <div className="mb-5 relative z-10">
                        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
                          Needs Attention
                        </p>
                        <NeedsAttentionCell tenant={tenant} />
                      </div>

                      <div className="grid grid-cols-2 gap-4 mb-6 relative z-10">
                        <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 border border-slate-100 dark:border-slate-800">
                          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                            Secure Score
                          </p>
                          {tenant.secureScore == null ? (
                            <span className="text-sm font-semibold text-slate-500">
                              Not synced
                            </span>
                          ) : (
                            <div className="flex items-end gap-1">
                              <span
                                className={`text-xl font-bold ${scoreColor(tenant.secureScore)}`}
                              >
                                {tenant.secureScore}%
                              </span>
                              <span className="text-xs font-semibold text-slate-400 mb-1">
                                / 100
                              </span>
                            </div>
                          )}
                        </div>

                        <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 border border-slate-100 dark:border-slate-800">
                          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                            Licenses
                          </p>
                          {tenant.licenseCount == null ? (
                            <span className="text-sm font-semibold text-slate-500">
                              Not synced
                            </span>
                          ) : (
                            <div className="flex items-end gap-1">
                              <span className="text-xl font-bold text-slate-900 dark:text-white">
                                {tenant.licenseCount}
                              </span>
                              <span className="text-xs font-semibold text-slate-400 mb-1">
                                assigned
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-4 border-t border-slate-100 dark:border-slate-800 relative z-10">
                        <span
                          className="flex items-center gap-1.5 text-xs font-semibold text-slate-400"
                          title={tenant.lastSync || ''}
                        >
                          <Clock className="h-3.5 w-3.5" />
                          {tenant.lastSync
                            ? `Synced ${formatSyncTime(tenant.lastSync)}`
                            : 'Not synced yet'}
                        </span>
                        <span className="text-sm font-semibold text-blue-600 flex items-center gap-1 group-hover:underline">
                          Manage Tenant <ChevronRight className="h-4 w-4" />
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              </div>
            ))}
          </div>
        ) : (
          /* List View */
          <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {/* Desktop Table Layout */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  <tr>
                    <SortHeader
                      field="name"
                      label="Tenant"
                      activeField={sortField}
                      sortOrder={sortOrder}
                      onSort={handleSort}
                    />
                    <SortHeader
                      field="status"
                      label="Status"
                      activeField={sortField}
                      sortOrder={sortOrder}
                      onSort={handleSort}
                    />
                    <SortHeader
                      field="needsAttention"
                      label="Needs Attention"
                      activeField={sortField}
                      sortOrder={sortOrder}
                      onSort={handleSort}
                    />
                    <SortHeader
                      field="secureScore"
                      label="Secure Score"
                      activeField={sortField}
                      sortOrder={sortOrder}
                      onSort={handleSort}
                    />
                    <SortHeader
                      field="lastSync"
                      label="Last Sync"
                      activeField={sortField}
                      sortOrder={sortOrder}
                      onSort={handleSort}
                    />
                    <th
                      scope="col"
                      className="py-3 px-4 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-right"
                    >
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {sortedTenants.map((tenant: Tenant) => (
                    <tr
                      key={tenant.id}
                      className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors group"
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          <ProviderIcon
                            provider={tenant.provider}
                            size="small"
                          />
                          <div>
                            <Link
                              href={`/tenants/${tenant.id}`}
                              className="font-semibold text-slate-900 dark:text-white group-hover:text-blue-600 transition-colors block"
                            >
                              {tenant.name}
                            </Link>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                              {tenant.domain || 'Domain not synced'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <Badge
                          className={`uppercase tracking-wide text-[10px] ${statusBadge(tenant.status)}`}
                        >
                          {tenant.status}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 max-w-[220px]">
                        <NeedsAttentionCell tenant={tenant} />
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap font-medium">
                        {tenant.secureScore == null ? (
                          <span className="text-xs text-slate-400">
                            Not synced
                          </span>
                        ) : (
                          <span
                            className={`text-base font-bold ${scoreColor(tenant.secureScore)}`}
                          >
                            {tenant.secureScore}%
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
                        <span
                          className="flex items-center gap-1.5"
                          title={tenant.lastSync || ''}
                        >
                          <Clock className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                          {tenant.lastSync
                            ? formatSyncTime(tenant.lastSync)
                            : 'Not synced yet'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <Link href={`/tenants/${tenant.id}`}>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1 rounded-lg text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/50 font-semibold"
                          >
                            Manage
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Compact Stacked Layout */}
            <div className="lg:hidden divide-y divide-slate-100 dark:divide-slate-800">
              {sortedTenants.map((tenant: Tenant) => (
                <div key={tenant.id} className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <ProviderIcon provider={tenant.provider} size="small" />
                      <div>
                        <Link
                          href={`/tenants/${tenant.id}`}
                          className="font-semibold text-slate-900 dark:text-white hover:text-blue-600 transition-colors block"
                        >
                          {tenant.name}
                        </Link>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {tenant.domain || 'Domain not synced'}
                        </p>
                      </div>
                    </div>
                    <Badge
                      className={`uppercase tracking-wide text-[10px] shrink-0 ${statusBadge(tenant.status)}`}
                    >
                      {tenant.status}
                    </Badge>
                  </div>

                  <div>
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                      Needs Attention
                    </p>
                    <NeedsAttentionCell tenant={tenant} />
                  </div>

                  <div className="pt-1">
                    <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-2 border border-slate-100 dark:border-slate-800 inline-block pr-6">
                      <span className="text-[10px] text-slate-400 font-medium block">
                        Secure Score
                      </span>
                      {tenant.secureScore == null ? (
                        <span className="text-xs text-slate-400 font-medium">
                          Not synced
                        </span>
                      ) : (
                        <span
                          className={`text-sm font-bold ${scoreColor(tenant.secureScore)}`}
                        >
                          {tenant.secureScore}%
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
                    <span
                      className="flex items-center gap-1 text-slate-400"
                      title={tenant.lastSync || ''}
                    >
                      <Clock className="h-3.5 w-3.5" />
                      {tenant.lastSync
                        ? formatSyncTime(tenant.lastSync)
                        : 'Not synced'}
                    </span>
                    <Link href={`/tenants/${tenant.id}`}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 text-xs font-semibold text-blue-600 border-blue-200 hover:bg-blue-50 dark:hover:bg-blue-950/50"
                      >
                        Manage <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

      {!loading && !error && sortedTenants.length === 0 && (
        <div className="text-center py-20 bg-white dark:bg-slate-900 rounded-3xl border border-dashed">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
            No tenants found
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Try adjusting your search or filters.
          </p>
        </div>
      )}
    </div>
  )
}
