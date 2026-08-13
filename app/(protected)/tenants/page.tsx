'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Search,
  Plus,
  Clock,
  ChevronRight,
  AlertCircle,
  RefreshCw,
  LayoutGrid,
  List,
  X,
  ShieldCheck,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Copy,
  Check,
  Shield,
  Building2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Filter,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { useTenants } from '@/lib/api/hooks'
import { apiClient } from '@/lib/api/client'
import { useAuth } from '@/components/providers/auth-provider'
import type {
  CreateTenantResponse,
  MicrosoftConsentResponse,
  Tenant,
} from '@/types/api'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'

import { computeTenantAttention } from '@/lib/attention/computeTenantAttention'
import { topAttention } from '@/lib/attention/topAttention'
import { TenantIssueDrawer } from '@/components/tenants/tenant-issue-drawer'
import { tenantOverviewPath } from '@/lib/tenants/navigation'
import { AffectedServices } from '@/components/tenants/affected-services'
import {
  TenantStatusBadge,
  getTenantDisplayStatus,
  type DisplayStatusKey,
} from '@/components/tenants/tenant-status-badge'

type Provider = 'microsoft' | 'google'
type ProviderFilter = 'all' | 'microsoft' | 'google'
type StatusFilter =
  | 'all'
  | 'healthy'
  | 'needs_attention'
  | 'disconnected_pending'
  | 'stale'
type ViewMode = 'list' | 'tile'
type SortField = 'name' | 'status' | 'needsAttention' | 'lastSync'
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
        'py-3.5 px-4 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider select-none sticky top-0 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 z-10',
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

function formatSyncTime(timeStr: string | null) {
  if (!timeStr) return 'Awaiting initial sync'
  try {
    const d = new Date(timeStr)
    if (isNaN(d.getTime())) return timeStr
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d)
  } catch {
    return timeStr
  }
}

function ProviderIcon({
  provider,
  size = 'small',
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

function MicrosoftMark({ size = 'small' }: { size?: 'normal' | 'small' }) {
  const isSmall = size === 'small'
  return (
    <div
      className={cn(
        'flex items-center justify-center border shadow-sm shrink-0 rounded-lg',
        isSmall ? 'w-8 h-8 bg-blue-50/80 border-blue-100 dark:bg-blue-950/40 dark:border-blue-900' : 'w-10 h-10 bg-blue-50 border-blue-100 dark:bg-blue-950 dark:border-blue-900'
      )}
      title="Microsoft 365 Tenant"
    >
      <div className="grid grid-cols-2 gap-0.5">
        <span className={cn('bg-[#F25022] rounded-[1px]', isSmall ? 'h-1.5 w-1.5' : 'h-2 w-2')} />
        <span className={cn('bg-[#7FBA00] rounded-[1px]', isSmall ? 'h-1.5 w-1.5' : 'h-2 w-2')} />
        <span className={cn('bg-[#00A4EF] rounded-[1px]', isSmall ? 'h-1.5 w-1.5' : 'h-2 w-2')} />
        <span className={cn('bg-[#FFB900] rounded-[1px]', isSmall ? 'h-1.5 w-1.5' : 'h-2 w-2')} />
      </div>
    </div>
  )
}

function GoogleMark({ size = 'small' }: { size?: 'normal' | 'small' }) {
  const isSmall = size === 'small'
  return (
    <div
      className={cn(
        'flex items-center justify-center border shadow-sm shrink-0 rounded-lg',
        isSmall ? 'w-8 h-8 bg-red-50/80 border-red-100 dark:bg-red-950/40 dark:border-red-900' : 'w-10 h-10 bg-red-50 border-red-100 dark:bg-red-950 dark:border-red-900'
      )}
    >
      <svg
        width={isSmall ? '16' : '20'}
        height={isSmall ? '16' : '20'}
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

function TenantIdPill({ tenantId }: { tenantId: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(tenantId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={`Click to copy Tenant ID: ${tenantId}`}
      className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors group/copy"
    >
      <span className="truncate max-w-[120px]">{tenantId}</span>
      {copied ? (
        <Check className="h-3 w-3 text-emerald-500 shrink-0" />
      ) : (
        <Copy className="h-3 w-3 opacity-0 group-hover/copy:opacity-100 shrink-0 transition-opacity" />
      )}
    </button>
  )
}

export default function TenantsPage() {
  const queryClient = useQueryClient()
  const { session } = useAuth()
  const { data, isLoading, isFetching, error, refetch } = useTenants()

  // Scope the affordance to the workspace represented by this directory.
  // A role in another workspace must never make tenant administration actions
  // appear here. The API remains authoritative for the operation itself.
  const visibleOrganizationIds = new Set(
    (data?.tenants ?? []).map((tenant) => tenant.organization.id)
  )
  const canOnboardTenant =
    visibleOrganizationIds.size === 1 &&
    session?.user.memberships.some(
      (membership) =>
        membership.status === 'ACTIVE' &&
        visibleOrganizationIds.has(membership.organization.id) &&
        ['MSP_OWNER', 'MSP_ADMIN', 'MSP_TECHNICIAN'].includes(membership.role)
    ) === true

  const onboardButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const consentPopupRef = useRef<Window | null>(null)
  const consentPopupMonitorRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  )

  const [searchQuery, setSearchQuery] = useState('')
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')

  const [selectedDrawerTenant, setSelectedDrawerTenant] = useState<Tenant | null>(null)

  // Onboarding state
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

  const loading = isLoading || isFetching
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    try {
      const saved = localStorage.getItem('hawkview_tenants_view_mode') as ViewMode | null
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
        text: 'Microsoft 365 connection verified. HawkView is performing initial synchronization.',
        tone: 'success',
      })
      queryClient.invalidateQueries({ queryKey: ['tenants'] })
    } else if (result === 'missing-permissions') {
      setConsentMessage({
        text: 'Microsoft consent completed, but required administrator permissions are missing.',
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
          text: 'Microsoft 365 connection verified. HawkView is performing initial synchronization.',
          tone: 'success',
        })
      } else if (message.result === 'missing-permissions') {
        setOnboardingError(null)
        setConsentMessage({
          text: 'Microsoft consent completed, but required permissions are missing.',
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

  const tenants: Tenant[] = useMemo(() => data?.tenants || [], [data?.tenants])
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
          text: 'App registration Microsoft connection verified and stored securely.',
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
      // temporary same-origin document
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
    } catch (err) {
      popup.close()
      consentPopupRef.current = null
      setIsSavingTenant(false)
      setOnboardingError(
        err instanceof Error
          ? err.message
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

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortOrder('asc')
    }
  }

  // Calculate Truthful Counts strictly from API response
  const counts = useMemo(() => {
    let healthy = 0
    let needsAttention = 0
    let disconnectedPending = 0

    tenants.forEach((t) => {
      const displayStatus = getTenantDisplayStatus(t)
      if (displayStatus.key === 'healthy') {
        healthy++
      } else if (displayStatus.key === 'needs_attention') {
        needsAttention++
      } else {
        disconnectedPending++
      }
    })

    return {
      total: tenants.length,
      healthy,
      needsAttention,
      disconnectedPending,
    }
  }, [tenants])

  // Filter & Search logic
  const filteredTenants = useMemo(() => {
    return tenants.filter((tenant) => {
      const q = searchQuery.trim().toLowerCase()
      const matchesSearch =
        !q ||
        tenant.name?.toLowerCase().includes(q) ||
        tenant.domain?.toLowerCase().includes(q) ||
        tenant.id?.toLowerCase().includes(q) ||
        tenant.microsoftTenantId?.toLowerCase().includes(q)

      const matchesProvider =
        providerFilter === 'all' || tenant.provider === providerFilter

      const displayStatus = getTenantDisplayStatus(tenant)
      let matchesStatus = true
      if (statusFilter === 'healthy') {
        matchesStatus = displayStatus.key === 'healthy'
      } else if (statusFilter === 'needs_attention') {
        matchesStatus = displayStatus.key === 'needs_attention'
      } else if (statusFilter === 'disconnected_pending') {
        matchesStatus =
          displayStatus.key === 'disconnected' ||
          displayStatus.key === 'pending_setup'
      } else if (statusFilter === 'stale') {
        matchesStatus = displayStatus.key === 'stale'
      }

      return matchesSearch && matchesProvider && matchesStatus
    })
  }, [tenants, searchQuery, providerFilter, statusFilter])

  // Sorting
  const sortedTenants = useMemo(() => {
    const list = [...filteredTenants]
    return list.sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'name': {
          const nameA = (a.name || '').toLowerCase()
          const nameB = (b.name || '').toLowerCase()
          cmp = nameA.localeCompare(nameB)
          break
        }
        case 'status': {
          const statusRank: Record<DisplayStatusKey, number> = {
            needs_attention: 1,
            disconnected: 2,
            pending_setup: 3,
            stale: 4,
            syncing: 5,
            partially_synchronized: 6,
            healthy: 7,
          }
          const rankA = statusRank[getTenantDisplayStatus(a).key] || 99
          const rankB = statusRank[getTenantDisplayStatus(b).key] || 99
          cmp = rankA - rankB
          break
        }
        case 'needsAttention': {
          const itemsA = computeTenantAttention({
            ...((a as any)?.bundle ?? {}),
            connectionStatus: a.connectionStatus,
            status: a.status,
            missingPermissions: a.missingPermissions,
          })
          const itemsB = computeTenantAttention({
            ...((b as any)?.bundle ?? {}),
            connectionStatus: b.connectionStatus,
            status: b.status,
            missingPermissions: b.missingPermissions,
          })
          cmp = itemsB.length - itemsA.length
          break
        }
        case 'lastSync': {
          const timeA = a.lastSync ? new Date(a.lastSync).getTime() : 0
          const timeB = b.lastSync ? new Date(b.lastSync).getTime() : 0
          cmp = timeA - timeB
          break
        }
      }
      return sortOrder === 'asc' ? cmp : -cmp
    })
  }, [filteredTenants, sortField, sortOrder])

  const clearFilters = () => {
    setSearchQuery('')
    setProviderFilter('all')
    setStatusFilter('all')
  }

  const hasActiveFilters =
    Boolean(searchQuery.trim()) ||
    providerFilter !== 'all' ||
    statusFilter !== 'all'

  const loadingText =
    elapsedSeconds < 15
      ? `Loading tenant directory… ${elapsedSeconds}s`
      : `HawkView API is taking longer than expected… ${elapsedSeconds}s`

  return (
    <div className="space-y-6 animate-in fade-in duration-300 pb-12">
      {/* 1. Page Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2.5">
            <Building2 className="h-7 w-7 text-blue-600 shrink-0" />
            <span>Tenant Directory</span>
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Monitor and manage customer environments.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {canOnboardTenant && (
            <Button
              ref={onboardButtonRef}
              className="gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm"
              onClick={() => {
                setOnboardingError(null)
                setConsentReview(null)
                setHawkviewPreviewMessage(null)
                setOnboardingStep('select')
                setShowOnboarding(true)
              }}
            >
              <Plus className="h-4 w-4" />
              <span>Onboard Tenant</span>
            </Button>
          )}
        </div>
      </div>

      {/* 1b. Compact Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3.5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Total Tenants
            </p>
            <p className="text-2xl font-extrabold text-slate-900 dark:text-white mt-0.5">
              {counts.total}
            </p>
          </div>
          <div className="h-10 w-10 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-300">
            <Building2 className="h-5 w-5" />
          </div>
        </div>

        <div className="p-3.5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
              Healthy
            </p>
            <p className="text-2xl font-extrabold text-emerald-700 dark:text-emerald-400 mt-0.5">
              {counts.healthy}
            </p>
          </div>
          <div className="h-10 w-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900 flex items-center justify-center text-emerald-600">
            <CheckCircle2 className="h-5 w-5" />
          </div>
        </div>

        <div className="p-3.5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">
              Needs Attention
            </p>
            <p className="text-2xl font-extrabold text-amber-700 dark:text-amber-400 mt-0.5">
              {counts.needsAttention}
            </p>
          </div>
          <div className="h-10 w-10 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-900 flex items-center justify-center text-amber-600">
            <AlertTriangle className="h-5 w-5" />
          </div>
        </div>

        <div className="p-3.5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wider">
              Disconnected / Pending
            </p>
            <p className="text-2xl font-extrabold text-red-700 dark:text-red-400 mt-0.5">
              {counts.disconnectedPending}
            </p>
          </div>
          <div className="h-10 w-10 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900 flex items-center justify-center text-red-600">
            <XCircle className="h-5 w-5" />
          </div>
        </div>
      </div>

      {/* Onboarding Modal */}
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
                    A Microsoft 365 administrator will review these permissions on Microsoft&apos;s consent screen.
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
                    className="rounded-xl bg-blue-600 hover:bg-blue-700 text-white"
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
                      Sign in with a Microsoft 365 administrator account and approve the permissions requested by HawkView.
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
                      Enter credentials from an application registration controlled by the customer.
                    </p>
                  </button>
                </div>
              </div>
            ) : onboardingStep === 'hawkview' ? (
              <div className="space-y-5">
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
                      Authorize HawkView to securely read and monitor this tenant.
                    </p>
                  </div>
                </div>

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
                    <span>Permissions</span>
                  </div>
                  <div className="h-px flex-1 mx-2 sm:mx-3 bg-slate-200 dark:bg-slate-800" />
                  <div className="flex items-center gap-2 text-slate-400 dark:text-slate-500 font-medium">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 dark:border-slate-800 text-[11px] shrink-0">
                      3
                    </span>
                    <span>Connect</span>
                  </div>
                </div>

                <div className="rounded-2xl border border-blue-100 dark:border-blue-900/40 bg-blue-50/60 dark:bg-blue-950/30 p-4 space-y-3">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                    What happens next?
                  </h3>
                  <ul className="space-y-2 text-xs text-slate-600 dark:text-slate-300">
                    <li className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
                      <span>Sign in using a Microsoft 365 administrator account.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
                      <span>Review read-only permissions requested by HawkView.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
                      <span>Approve access and return to HawkView automatically.</span>
                    </li>
                  </ul>
                </div>

                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 px-1">
                  <ShieldCheck className="h-4 w-4 text-slate-400 shrink-0" />
                  <span>
                    HawkView never receives or stores your Microsoft administrator password.
                  </span>
                </div>

                {hawkviewPreviewMessage && (
                  <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3.5 text-xs font-medium text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/50 dark:text-blue-200">
                    {hawkviewPreviewMessage}
                  </div>
                )}

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
                    {isSavingTenant
                      ? 'Connecting to Microsoft...'
                      : 'Continue with Microsoft'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div>
                  <h2
                    id="onboarding-modal-title"
                    className="text-xl font-bold text-slate-900 dark:text-white"
                  >
                    Manually register the app
                  </h2>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    Enter credentials from an application registration controlled by the customer.
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
                  </div>

                  <div className="flex flex-wrap items-center gap-3 pt-2">
                    <Button
                      type="submit"
                      disabled={isSavingTenant}
                      className="rounded-xl px-5 bg-blue-600 hover:bg-blue-700 text-white"
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

      {/* Notifications / Banners */}
      {consentMessage && (
        <Card
          className={cn(
            'rounded-2xl border p-4 text-sm font-medium',
            consentMessage.tone === 'success'
              ? 'border-emerald-200 bg-emerald-50/80 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300'
              : 'border-amber-200 bg-amber-50/80 text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300'
          )}
        >
          {consentMessage.text}
        </Card>
      )}

      {/* Backend API Error Alert */}
      {errorMessage && !loading && (
        <Card className="border-red-200 bg-red-50/80 dark:bg-red-950/20 dark:border-red-900/50 p-4 rounded-2xl">
          <div className="flex items-start gap-3 text-red-800 dark:text-red-300">
            <AlertCircle className="h-5 w-5 mt-0.5 shrink-0 text-red-600" />
            <div className="flex-1 text-sm">
              <p className="font-semibold">
                Unable to load tenant directory
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
              <span>Retry</span>
            </Button>
          </div>
        </Card>
      )}

      {/* 2. Search and Control Bar */}
      <div className="bg-white dark:bg-slate-900 p-2 sm:p-3 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-2 lg:space-y-0 lg:flex lg:items-center lg:gap-3">
        {/* Search input */}
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search by tenant name, primary domain, or tenant ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 h-10 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-sm placeholder:text-slate-400"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Filter controls group */}
        <div className="flex flex-wrap items-center gap-2 pt-2 lg:pt-0 border-t lg:border-t-0 lg:border-l border-slate-200 dark:border-slate-800 lg:pl-3">
          {/* Status Filter Dropdown / Selector */}
          <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
            <span className="text-xs font-semibold text-slate-400 px-2 hidden sm:inline">
              Status:
            </span>
            <button
              type="button"
              onClick={() => setStatusFilter('all')}
              className={cn(
                'px-2.5 py-1 rounded-lg text-xs font-semibold transition-all',
                statusFilter === 'all'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white'
              )}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('healthy')}
              className={cn(
                'px-2.5 py-1 rounded-lg text-xs font-semibold transition-all',
                statusFilter === 'healthy'
                  ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 shadow-sm font-bold'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white'
              )}
            >
              Healthy
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('needs_attention')}
              className={cn(
                'px-2.5 py-1 rounded-lg text-xs font-semibold transition-all',
                statusFilter === 'needs_attention'
                  ? 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300 shadow-sm font-bold'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white'
              )}
            >
              Attention
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('disconnected_pending')}
              className={cn(
                'px-2.5 py-1 rounded-lg text-xs font-semibold transition-all',
                statusFilter === 'disconnected_pending'
                  ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300 shadow-sm font-bold'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white'
              )}
            >
              Offline/Pending
            </button>
          </div>

          {/* Provider Filter */}
          <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
            {(['all', 'microsoft', 'google'] as ProviderFilter[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProviderFilter(p)}
                className={cn(
                  'px-2.5 py-1 rounded-lg text-xs font-semibold transition-all capitalize',
                  providerFilter === p
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white'
                )}
              >
                {p}
              </button>
            ))}
          </div>

          {/* View Mode Switcher */}
          <div className="flex items-center bg-slate-100 dark:bg-slate-800 p-1 rounded-xl gap-0.5 ml-auto">
            <button
              type="button"
              onClick={() => handleViewModeChange('list')}
              title="List view (Recommended for 100+ tenants)"
              aria-label="List view"
              className={cn(
                'p-1.5 rounded-lg transition-all',
                viewMode === 'list'
                  ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm'
                  : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              )}
            >
              <List className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => handleViewModeChange('tile')}
              title="Card view"
              aria-label="Card view"
              className={cn(
                'p-1.5 rounded-lg transition-all',
                viewMode === 'tile'
                  ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm'
                  : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              )}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Active Filter Clear Bar (if active) */}
      {hasActiveFilters && (
        <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-100/70 dark:bg-slate-800/40 border border-slate-200/60 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-500">Active Filters:</span>
            {searchQuery && (
              <Badge variant="outline" className="gap-1 bg-white dark:bg-slate-800">
                Search: &quot;{searchQuery}&quot;
              </Badge>
            )}
            {statusFilter !== 'all' && (
              <Badge variant="outline" className="gap-1 bg-white dark:bg-slate-800 capitalize">
                Status: {statusFilter.replace('_', ' ')}
              </Badge>
            )}
            {providerFilter !== 'all' && (
              <Badge variant="outline" className="gap-1 bg-white dark:bg-slate-800 capitalize">
                Provider: {providerFilter}
              </Badge>
            )}
            <span className="text-slate-400 font-medium">
              ({sortedTenants.length} of {tenants.length} matching)
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="h-7 px-2 text-xs text-blue-600 hover:text-blue-700 font-semibold"
          >
            Clear Filters
          </Button>
        </div>
      )}

      {/* 3. Loading Skeleton */}
      {loading && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400 px-1">
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-blue-600" />
            <span>{loadingText}</span>
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            <div className="p-4 space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-4 animate-pulse pb-3 border-b border-slate-100 dark:border-slate-800 last:border-0 last:pb-0"
                >
                  <div className="flex items-center gap-3 w-1/3">
                    <div className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-slate-800 shrink-0" />
                    <div className="space-y-1.5 flex-1">
                      <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-3/4" />
                      <div className="h-3 bg-slate-100 dark:bg-slate-800/60 rounded w-1/2" />
                    </div>
                  </div>
                  <div className="h-6 w-24 bg-slate-200 dark:bg-slate-800 rounded-md" />
                  <div className="h-6 w-20 bg-slate-100 dark:bg-slate-800/60 rounded-md hidden md:block" />
                  <div className="h-8 w-24 bg-slate-200 dark:bg-slate-800 rounded-lg" />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 4. Primary Tenant Directory Display */}
      {!loading && sortedTenants.length > 0 && (
        viewMode === 'list' ? (
          /* List View (Default for 100+ scalability) */
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
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
                      label="Overall Status"
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
                    <th
                      scope="col"
                      className="py-3.5 px-4 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider sticky top-0 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800"
                    >
                      Affected Services
                    </th>
                    <SortHeader
                      field="lastSync"
                      label="Last Successful Sync"
                      activeField={sortField}
                      sortOrder={sortOrder}
                      onSort={handleSort}
                    />
                    <th
                      scope="col"
                      className="py-3.5 px-4 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-right sticky top-0 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800"
                    >
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {sortedTenants.map((tenant) => {
                    const statusInfo = getTenantDisplayStatus(tenant)
                    const attentionItems = computeTenantAttention({
                      ...((tenant as any)?.bundle ?? {}),
                      connectionStatus: tenant.connectionStatus,
                      status: tenant.status,
                      missingPermissions: tenant.missingPermissions,
                    })

                    return (
                      <tr
                        key={tenant.id}
                        className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors group"
                      >
                        {/* Tenant Column */}
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-3">
                            <ProviderIcon
                              provider={tenant.provider}
                              size="small"
                            />
                            <div className="min-w-0">
                              <Link
                                href={tenantOverviewPath(String(tenant.id))}
                                className="font-bold text-slate-900 dark:text-white group-hover:text-blue-600 transition-colors block truncate"
                              >
                                {tenant.name}
                              </Link>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-xs text-slate-500 dark:text-slate-400 truncate">
                                  {tenant.domain || 'Domain collection pending'}
                                </span>
                                <span className="text-slate-300 dark:text-slate-700">
                                  •
                                </span>
                                <TenantIdPill
                                  tenantId={tenant.microsoftTenantId || tenant.id}
                                />
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Overall Status */}
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <TenantStatusBadge tenant={tenant} />
                        </td>

                        {/* Needs Attention Column */}
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          {attentionItems.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => setSelectedDrawerTenant(tenant)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200 dark:border-amber-900 hover:bg-amber-100 dark:hover:bg-amber-900/60 transition-colors text-xs font-semibold text-left"
                            >
                              <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                              <span>{attentionItems.length} issue{attentionItems.length > 1 ? 's' : ''}</span>
                              <ChevronRight className="h-3.5 w-3.5 opacity-60 ml-0.5" />
                            </button>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500 font-medium">
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                              <span>No issues</span>
                            </span>
                          )}
                        </td>

                        {/* Affected Services */}
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <AffectedServices tenant={tenant} compact />
                        </td>

                        {/* Last Sync */}
                        <td className="py-3.5 px-4 whitespace-nowrap text-xs text-slate-600 dark:text-slate-400 font-medium">
                          <div
                            className="flex items-center gap-1.5"
                            title={tenant.lastSync || 'Awaiting initial sync'}
                          >
                            <Clock className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                            <span>{formatSyncTime(tenant.lastSync)}</span>
                          </div>
                        </td>

                        {/* Context-Sensitive Primary Action */}
                        <td className="py-3.5 px-4 text-right whitespace-nowrap">
                          {statusInfo.key === 'needs_attention' ? (
                            <Button
                              size="sm"
                              onClick={() => setSelectedDrawerTenant(tenant)}
                              className="h-8 px-3 gap-1 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white shadow-sm"
                            >
                              <span>{statusInfo.primaryActionLabel}</span>
                              <ChevronRight className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <Link href={tenantOverviewPath(String(tenant.id))}>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 px-3 gap-1 rounded-lg text-xs font-semibold text-blue-600 dark:text-blue-400 border-slate-200 dark:border-slate-800 hover:bg-blue-50 dark:hover:bg-blue-950/50"
                              >
                                <span>{statusInfo.primaryActionLabel}</span>
                                <ChevronRight className="h-3.5 w-3.5" />
                              </Button>
                            </Link>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          /* Card View */
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {sortedTenants.map((tenant) => {
              const statusInfo = getTenantDisplayStatus(tenant)
              const attentionItems = computeTenantAttention({
                ...((tenant as any)?.bundle ?? {}),
                connectionStatus: tenant.connectionStatus,
                status: tenant.status,
                missingPermissions: tenant.missingPermissions,
              })

              return (
                <Card
                  key={tenant.id}
                  className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 hover:border-blue-300 dark:hover:border-blue-800 hover:shadow-md transition-all space-y-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <ProviderIcon provider={tenant.provider} size="small" />
                      <div className="min-w-0">
                        <Link
                          href={tenantOverviewPath(String(tenant.id))}
                          className="font-bold text-slate-900 dark:text-white hover:text-blue-600 transition-colors block truncate"
                        >
                          {tenant.name}
                        </Link>
                        <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                          {tenant.domain || 'Domain collection pending'}
                        </p>
                      </div>
                    </div>
                    <TenantStatusBadge tenant={tenant} />
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs border-y border-slate-100 dark:border-slate-800/80 py-3">
                    <div>
                      <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                        Issues
                      </span>
                      {attentionItems.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => setSelectedDrawerTenant(tenant)}
                          className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 font-bold hover:underline"
                        >
                          <AlertTriangle className="h-3.5 w-3.5" />
                          <span>{attentionItems.length} Needs Review</span>
                        </button>
                      ) : (
                        <span className="text-emerald-600 font-semibold flex items-center gap-1">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Clean</span>
                        </span>
                      )}
                    </div>

                    <div>
                      <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                        Last Sync
                      </span>
                      <span className="text-slate-600 dark:text-slate-300 font-medium truncate block">
                        {formatSyncTime(tenant.lastSync)}
                      </span>
                    </div>
                  </div>

                  <div>
                    <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block mb-1.5">
                      Affected Services
                    </span>
                    <AffectedServices tenant={tenant} compact />
                  </div>

                  <div className="pt-2 flex items-center justify-between border-t border-slate-100 dark:border-slate-800">
                    <TenantIdPill tenantId={tenant.microsoftTenantId || tenant.id} />
                    {statusInfo.key === 'needs_attention' ? (
                      <Button
                        size="sm"
                        onClick={() => setSelectedDrawerTenant(tenant)}
                        className="h-8 px-3 gap-1 text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white"
                      >
                        <span>{statusInfo.primaryActionLabel}</span>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Link href={tenantOverviewPath(String(tenant.id))}>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 px-3 gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 border-slate-200 dark:border-slate-800"
                        >
                          <span>{statusInfo.primaryActionLabel}</span>
                          <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                      </Link>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>
        )
      )}

      {/* 5. Empty State when zero tenants onboarded */}
      {!loading && !error && tenants.length === 0 && (
        <div className="text-center py-16 px-6 bg-white dark:bg-slate-900 rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 max-w-lg mx-auto space-y-4">
          <div className="h-12 w-12 rounded-2xl bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 flex items-center justify-center mx-auto">
            <Building2 className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white">
              No tenants onboarded yet
            </h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              HawkView provides unified security monitoring, licensing control, and audit trail management across your Microsoft 365 customer environments.
            </p>
          </div>
          <Button
            className="gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold"
            onClick={() => {
              setOnboardingError(null)
              setConsentReview(null)
              setHawkviewPreviewMessage(null)
              setOnboardingStep('select')
              setShowOnboarding(true)
            }}
          >
            <Plus className="h-4 w-4" />
            <span>Onboard Your First Tenant</span>
          </Button>
        </div>
      )}

      {/* 6. No Search/Filter Results */}
      {!loading && !error && tenants.length > 0 && sortedTenants.length === 0 && (
        <div className="text-center py-12 px-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 max-w-md mx-auto space-y-3">
          <Filter className="h-8 w-8 text-slate-400 mx-auto" />
          <h3 className="text-base font-bold text-slate-900 dark:text-white">
            No matching tenants found
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            No customer environments match your active search terms or status filters.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={clearFilters}
            className="text-xs font-semibold"
          >
            Clear Active Filters
          </Button>
        </div>
      )}

      {/* 7. Tenant Issue Details Drawer */}
      <TenantIssueDrawer
        tenant={selectedDrawerTenant}
        isOpen={Boolean(selectedDrawerTenant)}
        onClose={() => setSelectedDrawerTenant(null)}
      />
    </div>
  )
}
