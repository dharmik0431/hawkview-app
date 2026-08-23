'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/components/providers/auth-provider'

import { apiClient } from '@/lib/api/client'
import { auditSyncFocusTarget, isM365AuditSyncDeepLink, m365AuditSyncHealth } from '@/lib/tenants/audit-sync-health'
import { normalizeCollectionReadiness, readinessDiagnostic, readinessLabel, readinessRemediation, synchronizationReadinessSummary, READINESS_STATES } from '@/lib/tenants/collection-readiness'
import { datasetStateNeedsTenantAction, datasetTierLabel, microsoftAccessDatasetView, microsoftAccessSummary, normalizeMicrosoftAccessCatalog, normalizeMicrosoftVerificationTimestamp } from '@/lib/tenants/microsoft-access-contract'
import {
  settingsConnectionHealth,
  settingsOverallHealth,
  settingsSynchronizationAttention,
  settingsSynchronizationStateLabel,
  settingsSynchronizationRows,
} from '@/lib/tenants/settings-readiness-view'
import type { TenantBundle } from '@/types/tenant-data'

import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Trash2,
  ExternalLink,
  Key,
  Info,
  Server,
  Activity,
  Layers,
  Building,
  Users,
  HardDrive,
  Mail,
  FileText,
  Lock,
  Copy,
  Search,
  Filter,
  SlidersHorizontal,
  Check,
  Clock,
  AlertCircle,
  Database,
  Globe,
  Laptop,
  Bell,
  ArrowUpDown,
  Eye,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LoadingState } from '@/components/common/loading-state'
import { ErrorState } from '@/components/common/error-state'
import { ExchangeReadonlySetup } from '@/components/tenants/exchange-readonly-setup'
import { cn } from '@/lib/utils'

function formatDate(isoString?: string | null) {
  if (!isoString) return 'Not available'
  try {
    const d = new Date(isoString)
    if (isNaN(d.getTime())) return 'Not available'
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d)
  } catch {
    return 'Not available'
  }
}

function calculateFreshness(lastSyncIso?: string | null) {
  if (!lastSyncIso) return 'Not available'
  try {
    const d = new Date(lastSyncIso)
    if (isNaN(d.getTime())) return 'Not available'
    const diffMs = Date.now() - d.getTime()
    const diffMins = Math.floor(diffMs / (1000 * 60))
    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins} min ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`
    const diffDays = Math.floor(diffHours / 24)
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`
  } catch {
    return 'Not available'
  }
}

function maskClientId(clientId?: string) {
  if (!clientId || clientId.length < 8) return 'Not available'
  return `${clientId.slice(0, 4)}••••-••••-${clientId.slice(-4)}`
}

function formatModuleName(rawName: string) {
  if (rawName === 'named_locations') return 'Named locations'
  if (rawName === 'M365_AUDIT') return 'Microsoft 365 Unified Audit'
  if (rawName === 'SHAREPOINT_SITES' || rawName === 'sharepoint') return 'SharePoint & OneDrive'
  if (rawName === 'EXCHANGE' || rawName === 'exchange') return 'Exchange Online'
  if (rawName === 'ENTRA' || rawName === 'entra') return 'Entra ID & Security'
  if (rawName === 'USERS' || rawName === 'users') return 'User Accounts'
  if (rawName === 'GROUPS' || rawName === 'groups') return 'Groups & Teams'
  if (rawName === 'LICENSES' || rawName === 'licenses') return 'Licenses & Subscriptions'
  if (rawName === 'DNS' || rawName === 'dns') return 'Domains & DNS'
  return rawName.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase())
}

export default function TenantSettingsPage() {
  const params = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { session } = useAuth()
  const tenantId = params?.id

  // Deep Link detection
  const sectionParam = searchParams.get('section')
  const resourceParam = searchParams.get('resource')
  const tabParam = searchParams.get('tab')
  const microsoftConsentResult = searchParams.get('microsoftConsent')
  const hash = typeof window !== 'undefined' ? window.location.hash : ''

  const auditSyncDeepLink = isM365AuditSyncDeepLink(sectionParam, resourceParam) || hash === '#sync-health'
  const auditSyncFocusId = auditSyncFocusTarget(sectionParam, resourceParam) || (hash === '#sync-health' ? 'sync-health' : null)

  const [activeTab, setActiveTab] = useState<string>('overview')
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null)

  const [bundle, setBundle] = useState<TenantBundle | null>(null)
  const [tenantListRecord, setTenantListRecord] = useState<any | null>(null)
  const [microsoftAccessContract, setMicrosoftAccessContract] = useState<unknown>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  // Action states
  const [isVerifying, setIsVerifying] = useState(false)
  const [verifyNotice, setVerifyNotice] = useState<string | null>(null)

  const [isSyncing, setIsSyncing] = useState(false)
  const [syncNotice, setSyncNotice] = useState<{ message: string; type: 'success' | 'error' } | null>(null)

  const [isReviewingConsent, setIsReviewingConsent] = useState(false)
  const [consentError, setConsentError] = useState<string | null>(null)

  // Danger zone state
  const [isDangerZoneExpanded, setIsDangerZoneExpanded] = useState(false)
  const [confirmTenantId, setConfirmTenantId] = useState('')
  const [ackChecked, setAckChecked] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Copy feedback state
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // Tab 2 (Collection) filters
  const [collectionSearch, setCollectionSearch] = useState('')
  const [collectionFilterState, setCollectionFilterState] = useState<string>('ALL')

  // Tab 3 (Permissions) filters
  const [permSearch, setPermSearch] = useState('')
  const [permServiceFilter, setPermServiceFilter] = useState<string>('ALL')
  const [permStatusFilter, setPermStatusFilter] = useState<string>('ALL')

  // Tab 4 (Synchronization) filters
  const [syncSearch, setSyncSearch] = useState('')
  const [syncFilterState, setSyncFilterState] = useState<string>('ALL')

  // Initial tab and deep-link routing
  useEffect(() => {
    if (sectionParam === 'sync' || resourceParam === 'M365_AUDIT' || hash === '#sync-health' || tabParam === 'synchronization' || tabParam === 'sync') {
      setActiveTab('synchronization')
      if (resourceParam === 'M365_AUDIT' || hash === '#sync-health' || sectionParam === 'sync') {
        setExpandedRows((prev) => ({ ...prev, M365_AUDIT: true, 'Microsoft 365 Unified Audit': true }))
        setFocusedRowId('row-M365_AUDIT')
      }
    } else if (sectionParam === 'collection' || tabParam === 'collection') {
      setActiveTab('collection')
      if (resourceParam) {
        setExpandedRows((prev) => ({ ...prev, [resourceParam]: true }))
        setFocusedRowId(`row-${resourceParam}`)
      }
    } else if (sectionParam === 'permissions' || tabParam === 'permissions') {
      setActiveTab('permissions')
    } else if (sectionParam === 'administration' || sectionParam === 'admin' || tabParam === 'administration') {
      setActiveTab('administration')
    } else if (tabParam === 'overview') {
      setActiveTab('overview')
    }
  }, [sectionParam, resourceParam, tabParam, hash])

  // Focus and scroll to deep-linked target
  useEffect(() => {
    if (focusedRowId && loadState === 'ready') {
      const timer = setTimeout(() => {
        const el = document.getElementById(focusedRowId) || document.getElementById('sync-health')
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          el.focus({ preventScroll: true })
        }
      }, 200)
      return () => clearTimeout(timer)
    }
  }, [focusedRowId, activeTab, loadState])

  const fetchTenantData = useCallback(async () => {
    if (!tenantId) return
    setLoadState('loading')
    setLoadError(null)

    try {
      const [bundleRes, listRes, accessContractRes] = await Promise.allSettled([
        apiClient.get<any>(`/api/tenants/${encodeURIComponent(String(tenantId))}`),
        apiClient.get<any>('/api/tenants'),
        queryClient.fetchQuery({
          queryKey: ['microsoft-access-contract', session?.user.id ?? 'unavailable'],
          queryFn: () => apiClient.get<unknown>('/api/tenants/microsoft/access-contract'),
          staleTime: 60 * 60 * 1000,
        }),
      ])

      let loadedBundle: TenantBundle | null = null
      if (bundleRes.status === 'fulfilled' && bundleRes.value?.bundle) {
        loadedBundle = bundleRes.value.bundle
        setBundle(loadedBundle)
      }

      if (listRes.status === 'fulfilled' && listRes.value?.tenants) {
        const found = listRes.value.tenants.find(
          (t: any) => String(t.id).toLowerCase() === String(tenantId).toLowerCase()
        )
        if (found) setTenantListRecord(found)
      }
      setMicrosoftAccessContract(accessContractRes.status === 'fulfilled' ? accessContractRes.value : null)

      if (!loadedBundle && bundleRes.status === 'rejected') {
        throw new Error('Unable to load tenant configuration.')
      }

      setLoadState('ready')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to load tenant settings.'
      setLoadError(msg)
      setLoadState('error')
    }
  }, [queryClient, session?.user.id, tenantId])

  useEffect(() => {
    fetchTenantData()
  }, [fetchTenantData])

  // Merged tenant data object
  const tenant = useMemo(() => {
    const rawBundleTenant = bundle?.tenant || {}
    const rawListTenant = tenantListRecord || {}
    return {
      ...rawBundleTenant,
      ...rawListTenant,
      id: rawListTenant.id || rawBundleTenant.id || tenantId,
      name: rawListTenant.name || rawBundleTenant.name || 'Tenant Settings',
      domain: rawListTenant.domain || rawBundleTenant.domain || 'Not available',
      microsoftTenantId:
        rawListTenant.microsoftTenantId ||
        rawBundleTenant.microsoftTenantId ||
        rawBundleTenant.id ||
        tenantId,
      provider: rawListTenant.provider || rawBundleTenant.provider || 'microsoft',
      connectionStatus: rawListTenant.connectionStatus ?? null,
      connectionMode: rawListTenant.connectionMode || rawBundleTenant.connectionMode || 'hawkview-managed',
      lastSync: rawListTenant.lastSync || rawBundleTenant.lastSync || null,
      connectionErrorCode: rawListTenant.connectionErrorCode || rawBundleTenant.connectionErrorCode || null,
      organization: rawListTenant.organization || rawBundleTenant.organization || null,
      connectedAt: rawListTenant.connectedAt || rawBundleTenant.connectedAt || null,
      connectedBy: rawListTenant.connectedBy || rawBundleTenant.connectedBy || null,
      credentialExpiresAt: rawListTenant.credentialExpiresAt || rawBundleTenant.credentialExpiresAt || null,
      appName: rawListTenant.appName || rawBundleTenant.appName || null,
      customerClientId: rawListTenant.customerClientId || rawBundleTenant.customerClientId || null,
    }
  }, [bundle, tenantListRecord, tenantId])

  const tenantOrganizationId = tenant.organization?.id
  const canDeleteTenant =
    Boolean(tenantOrganizationId) &&
    session?.user.memberships.some(
      (membership) =>
        membership.status === 'ACTIVE' &&
        membership.organization.id === tenantOrganizationId &&
        ['MSP_OWNER', 'MSP_ADMIN'].includes(membership.role)
    ) === true

  const handleVerifyConnection = async () => {
    setIsVerifying(true)
    setVerifyNotice(null)
    try {
      await apiClient.post(`/api/tenants/${encodeURIComponent(String(tenantId))}/verify-connection`)
      await queryClient.invalidateQueries({ queryKey: ['tenants'] })
      await fetchTenantData()
      const timeStr = new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      }).format(new Date())
      setVerifyNotice(`Connection status refreshed at ${timeStr}.`)
    } catch (error) {
      await queryClient.invalidateQueries({ queryKey: ['tenants'] })
      await fetchTenantData()
      setVerifyNotice(
        error instanceof Error ? error.message : 'Unable to verify the Microsoft connection.'
      )
    } finally {
      setIsVerifying(false)
    }
  }

  const handleRefreshConnection = async () => {
    if (!tenantId || isSyncing) return
    setIsSyncing(true)
    setSyncNotice(null)
    try {
      const res = await apiClient.post<any>(
        `/api/tenants/${encodeURIComponent(String(tenantId))}/sync`,
        undefined,
        { timeoutMs: 60_000 }
      )
      if (res?.bundle) {
        setBundle(res.bundle)
      }
      setSyncNotice({
        message: 'Tenant synchronization completed successfully.',
        type: 'success',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Synchronization failed.'
      setSyncNotice({ message: msg, type: 'error' })
    } finally {
      setIsSyncing(false)
      window.setTimeout(() => setSyncNotice(null), 5000)
    }
  }

  const handleReviewPermissions = async () => {
    setIsReviewingConsent(true)
    setConsentError(null)
    try {
      const res = await apiClient.post<any>(`/api/tenants/${tenant.id}/microsoft-consent`)
      if (res?.consentUrl) {
        window.open(res.consentUrl, '_blank')
      }
    } catch (err) {
      setConsentError(
        err instanceof Error ? err.message : 'Microsoft consent workflow is unavailable.'
      )
    } finally {
      setIsReviewingConsent(false)
    }
  }

  const handleDeleteTenant = async () => {
    const requiredId = String(tenant.microsoftTenantId || tenant.id).trim().toLowerCase()
    const enteredId = confirmTenantId.trim().toLowerCase()

    if (enteredId !== requiredId) {
      setDeleteError('The entered Microsoft tenant ID does not match.')
      return
    }

    if (!ackChecked) {
      setDeleteError('You must acknowledge tenant removal before proceeding.')
      return
    }

    setIsDeleting(true)
    setDeleteError(null)

    try {
      await apiClient.delete<{ removed: boolean }>(`/api/tenants/${tenant.id}`, {
        confirmMicrosoftTenantId: enteredId,
      })
      await queryClient.invalidateQueries({ queryKey: ['tenants'] })
      router.push('/tenants')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to disconnect and delete tenant.'
      setDeleteError(msg)
      setIsDeleting(false)
    }
  }

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 2000)
  }

  const handleTabChange = (newTab: string) => {
    setActiveTab(newTab)
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', newTab)
    params.delete('section')
    params.delete('resource')
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  const toggleRowExpansion = (key: string) => {
    setExpandedRows((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  // Computed health & collection views
  const connectionHealth = settingsConnectionHealth(tenant.connectionStatus)
  const normalizedConnectionStatus = String(tenant.connectionStatus ?? '').toLowerCase()
  const isConnectionLost = connectionHealth.state === 'DISCONNECTED'
  const collectionReadiness = useMemo(
    () => normalizeCollectionReadiness(tenantListRecord?.collectionReadiness),
    [tenantListRecord]
  )
  const accessCatalog = useMemo(
    () => normalizeMicrosoftAccessCatalog(microsoftAccessContract),
    [microsoftAccessContract],
  )
  const accessSummary = useMemo(
    () => microsoftAccessSummary(collectionReadiness, accessCatalog),
    [accessCatalog, collectionReadiness],
  )
  const permissionVerificationAt = useMemo(
    () => normalizeMicrosoftVerificationTimestamp(collectionReadiness?.permissionVerifiedAt),
    [collectionReadiness],
  )
  const hasPermissionsData = accessSummary.contractAvailable
  const missingPermsCount = accessSummary.missingConnectionRequired + accessSummary.missingCore
  const requiresMicrosoftReconnection =
    isConnectionLost ||
    ['pending-consent', 'pending', 'warning'].includes(normalizedConnectionStatus) ||
    accessSummary.missingConnectionRequired > 0
  const synchronizationSummary = useMemo(
    () => synchronizationReadinessSummary(collectionReadiness),
    [collectionReadiness]
  )
  const auditSync = useMemo(
    () => m365AuditSyncHealth(tenantListRecord?.tenantHealth?.resourceHealth ?? tenantListRecord?.resourceHealth),
    [tenantListRecord]
  )

  // Badges
  const connectionStatusBadge = useMemo(() => {
    if (connectionHealth.state === 'CONNECTED') {
      return (
        <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 gap-1 font-medium">
          <CheckCircle2 className="h-3 w-3" /> Connected
        </Badge>
      )
    }
    if (connectionHealth.state === 'PENDING') {
      return (
        <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 gap-1 font-medium">
          <AlertTriangle className="h-3 w-3" /> Pending Consent
        </Badge>
      )
    }
    if (connectionHealth.state === 'DISCONNECTED') {
      return (
        <Badge className="bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30 gap-1 font-medium">
          <XCircle className="h-3 w-3" /> Disconnected
        </Badge>
      )
    }
    return <Badge variant="secondary">Unknown</Badge>
  }, [connectionHealth.state])

  const overallHealthBadge = useMemo(() => {
    const health = settingsOverallHealth(synchronizationSummary)
    if (health.state === 'HEALTHY') {
      return (
        <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 font-medium">
          {health.label}
        </Badge>
      )
    }
    if (health.state === 'UNVERIFIED') {
      return (
        <Badge className="bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 font-medium">
          {health.label}
        </Badge>
      )
    }
    return (
      <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 font-medium">
        {health.label}
      </Badge>
    )
  }, [synchronizationSummary])

  // Priority Attention Items computation
  const priorityAttentionItems = useMemo(() => {
    const items: Array<{
      id: string
      title: string
      status: string
      statusVariant: 'amber' | 'red' | 'blue'
      explanation: string
      timestamp: string
      actionLabel: string
      targetTab: string
      targetRowId?: string
    }> = []

    // Non-ready workloads from collection readiness
    if (collectionReadiness?.workloads) {
      collectionReadiness.workloads.forEach((w) => {
        if (w.state !== 'READY') {
          const isRed = ['BLOCKED_PERMISSION', 'BLOCKED_TENANT_CONFIGURATION', 'FAILED_TRANSIENT'].includes(w.state)
          items.push({
            id: `collection-${w.key}`,
            title: w.workload,
            status: readinessLabel(w.state),
            statusVariant: isRed ? 'red' : 'amber',
            explanation: readinessDiagnostic(w.reasonCode, w.reason) || w.remediation || 'Requires attention.',
            timestamp: formatDate(w.lastAttemptAt || w.lastVerifiedAt),
            actionLabel: 'Investigate in Collection',
            targetTab: 'collection',
            targetRowId: `row-${w.key}`,
          })
        }
      })
    }

    // Audit Sync issues
    if (auditSync && auditSync.classification !== 'READY' && auditSync.classification !== 'HEALTHY') {
      items.push({
        id: 'audit-sync',
        title: 'Microsoft 365 Unified Audit',
        status: readinessLabel(auditSync.classification),
        statusVariant: 'amber',
        explanation: auditSync.message || 'Audit log synchronization requires attention.',
        timestamp: formatDate(auditSync.lastAttemptAt),
        actionLabel: 'Investigate in Sync',
        targetTab: 'synchronization',
        targetRowId: 'row-m365_unified_audit',
      })
    }

    return items
  }, [collectionReadiness, auditSync])

  // Filtered & Sorted Collection Workloads
  const filteredWorkloads = useMemo(() => {
    if (!collectionReadiness?.workloads) return []
    let list = [...collectionReadiness.workloads]

    if (collectionSearch.trim()) {
      const q = collectionSearch.toLowerCase()
      list = list.filter(
        (w) =>
          w.workload.toLowerCase().includes(q) ||
          w.key.toLowerCase().includes(q) ||
          w.components.some((c) => c.label.toLowerCase().includes(q)) ||
          w.datasets.some((dataset) => dataset.label.toLowerCase().includes(q))
      )
    }

    if (collectionFilterState !== 'ALL') {
      if (collectionFilterState === 'ATTENTION') {
        list = list.filter((w) => w.state !== 'READY')
      } else {
        list = list.filter((w) => w.state === collectionFilterState)
      }
    }

    // Default ordering: Problems (0-7), Initializing/Unverified (8-10), Ready (11)
    const ORDER: Record<string, number> = {
      BLOCKED_PERMISSION: 0,
      BLOCKED_TENANT_CONFIGURATION: 1,
      FAILED_TRANSIENT: 2,
      STALE: 3,
      BACKLOGGED: 4,
      PARTIAL: 5,
      NOT_LICENSED: 6,
      UNSUPPORTED: 7,
      UNVERIFIED: 8,
      INITIALIZING: 9,
      NEVER_SUCCEEDED: 10,
      READY: 11,
    }

    return list.sort((a, b) => (ORDER[a.state] ?? 99) - (ORDER[b.state] ?? 99))
  }, [collectionReadiness, collectionSearch, collectionFilterState])

  // Filtered Permissions list
  const filteredPermissions = useMemo(() => {
    const list = accessSummary.permissions

    return list.filter((p: any) => {
      if (permSearch.trim()) {
        const q = permSearch.toLowerCase()
        if (!p.name.toLowerCase().includes(q) && !p.purpose.toLowerCase().includes(q)) return false
      }
      if (permServiceFilter !== 'ALL' && p.service !== permServiceFilter) return false
      if (permStatusFilter !== 'ALL' && p.status !== permStatusFilter) return false
      return true
    })
  }, [accessSummary.permissions, permSearch, permServiceFilter, permStatusFilter])

  // Modules list for Synchronization Tab
  const moduleRows = useMemo(() => {
    return settingsSynchronizationRows(collectionReadiness).map((row) => {
      const key = row.key.toLowerCase()
      const icon = key.includes('sharepoint')
        ? <HardDrive className="h-4 w-4 text-slate-500" />
        : key.includes('exchange')
          ? <Mail className="h-4 w-4 text-slate-500" />
          : key.includes('audit')
            ? <Activity className="h-4 w-4 text-slate-500" />
            : key.includes('entra') || key.includes('sign_in')
              ? <ShieldCheck className="h-4 w-4 text-slate-500" />
              : key.includes('directory')
                ? <Users className="h-4 w-4 text-slate-500" />
                : <Server className="h-4 w-4 text-slate-500" />
      return {
        ...row,
        icon,
        issue: readinessDiagnostic(row.reasonCode, row.reason),
      }
    })
  }, [collectionReadiness])

  const synchronizationAttention = useMemo(
    () => settingsSynchronizationAttention(moduleRows),
    [moduleRows],
  )

  const filteredSyncModules = useMemo(() => {
    let list = [...moduleRows]
    if (syncSearch.trim()) {
      const q = syncSearch.toLowerCase()
      list = list.filter((m) => m.name.toLowerCase().includes(q) || m.key.toLowerCase().includes(q))
    }
    if (syncFilterState !== 'ALL') {
      if (syncFilterState === 'FAILED') {
        list = list.filter((m) => ['BLOCKED_PERMISSION', 'FAILED_TRANSIENT', 'NEVER_SUCCEEDED'].includes(m.status))
      } else if (syncFilterState === 'STALE') {
        list = list.filter((m) => m.status === 'STALE')
      } else if (syncFilterState === 'CURRENT') {
        list = list.filter((m) => m.status === 'READY')
      }
    }
    return list
  }, [moduleRows, syncSearch, syncFilterState])

  if (loadState === 'loading') {
    return (
      <div className="container mx-auto p-6 max-w-7xl">
        <Card className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-card shadow-2xs">
          <CardContent className="p-12">
            <LoadingState message="Loading tenant settings and connection state..." />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (loadState === 'error') {
    return (
      <div className="container mx-auto p-6 max-w-7xl space-y-4">
        <Link
          href={`/tenants/${tenantId}`}
          className="inline-flex items-center text-sm font-medium text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to tenant overview
        </Link>
        <Card className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-card shadow-2xs">
          <CardContent className="p-8">
            <ErrorState message={loadError || 'Unable to load tenant settings.'} onRetry={fetchTenantData} />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="w-full space-y-4 p-2 sm:p-4 max-w-7xl mx-auto">
      {/* COMPACT PAGE HEADER */}
      <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 shadow-2xs space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
                {tenant.name}
              </h1>
              {connectionStatusBadge}
              {overallHealthBadge}
            </div>

            <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 flex-wrap pt-0.5">
              <div>
                <span className="font-semibold text-slate-700 dark:text-slate-300">Domain: </span>
                {tenant.domain || 'Not available'}
              </div>
              <span className="text-slate-300 dark:text-slate-700">•</span>
              <div className="flex items-center gap-1">
                <span className="font-semibold text-slate-700 dark:text-slate-300">Microsoft Tenant ID: </span>
                <code className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-[11px]">
                  {tenant.microsoftTenantId || tenant.id}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  onClick={() => handleCopy(String(tenant.microsoftTenantId || tenant.id), 'header-tid')}
                  title="Copy Tenant ID"
                >
                  {copiedKey === 'header-tid' ? <Check className="h-3 w-3 text-teal-600" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
              <span className="text-slate-300 dark:text-slate-700">•</span>
              <div>
                <span className="font-semibold text-slate-700 dark:text-slate-300">Latest successful collection: </span>
                {formatDate(tenant.lastSync)}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleVerifyConnection}
              disabled={isVerifying}
              className="gap-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white dark:bg-teal-600 dark:hover:bg-teal-500 text-xs font-semibold h-8 shadow-2xs"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isVerifying ? 'animate-spin' : ''}`} />
              {isVerifying ? 'Verifying...' : 'Verify connection'}
            </Button>
          </div>
        </div>

        {/* Action Notices */}
        {verifyNotice && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/80 dark:bg-emerald-950/30 dark:border-emerald-900/50 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>{verifyNotice}</span>
          </div>
        )}

        {syncNotice && (
          <div
            className={cn(
              'rounded-lg border px-3 py-2 text-xs flex items-center gap-2',
              syncNotice.type === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:border-emerald-900/50 dark:text-emerald-300'
                : 'border-red-200 bg-red-50 text-red-800 dark:bg-red-950/30 dark:border-red-900/50 dark:text-red-300'
            )}
          >
            {syncNotice.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0" />
            )}
            <span>{syncNotice.message}</span>
          </div>
        )}
      </div>

      {/* RECONNECTION WARNING BANNER */}
      {requiresMicrosoftReconnection && (
        <div
          className={cn(
            'rounded-xl border p-4 shadow-2xs text-xs space-y-3',
            isConnectionLost
              ? 'border-red-200 bg-red-50/90 dark:border-red-900/50 dark:bg-red-950/20 text-red-900 dark:text-red-200'
              : 'border-amber-200 bg-amber-50/90 dark:border-amber-900/50 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200'
          )}
        >
          <div className="flex items-start gap-3">
            <div className="p-1.5 rounded-lg bg-white/80 dark:bg-slate-900/80 shrink-0">
              <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="space-y-1 min-w-0 flex-1">
              <h2 className="font-semibold text-sm">
                {isConnectionLost
                  ? 'Reconnect Microsoft 365'
                  : missingPermsCount > 0
                  ? 'Microsoft permission update required'
                  : 'Complete Microsoft 365 authorization'}
              </h2>
              <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                {isConnectionLost
                  ? 'HawkView can no longer access this tenant. Previously synchronized data remains available, but new synchronization is paused until access is restored.'
                  : missingPermsCount > 0
                  ? 'One or more core datasets are missing required read-only access. Optional enrichment does not block otherwise healthy collection.'
                  : 'This tenant is registered, but synchronization cannot complete until a Global Administrator grants the required read-only permissions.'}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                type="button"
                size="sm"
                onClick={handleReviewPermissions}
                disabled={isReviewingConsent}
                className="gap-1.5 text-xs h-8 bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {isReviewingConsent ? 'Opening...' : 'Review & Authorize'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* TABS NAVIGATION */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full space-y-4">
        <TabsList className="w-full justify-start overflow-x-auto h-11 bg-slate-100 dark:bg-slate-800/80 p-1 rounded-xl border border-slate-200/80 dark:border-slate-800">
          <TabsTrigger value="overview" className="rounded-lg text-xs font-semibold px-4 py-2 cursor-pointer">
            Overview
          </TabsTrigger>
          <TabsTrigger value="collection" className="rounded-lg text-xs font-semibold px-4 py-2 cursor-pointer flex items-center gap-1.5">
            <span>Collection</span>
            {collectionReadiness?.workloads.some((w) => w.state !== 'READY') && (
              <span className="h-2 w-2 rounded-full bg-amber-500 shrink-0" />
            )}
          </TabsTrigger>
          <TabsTrigger value="permissions" className="rounded-lg text-xs font-semibold px-4 py-2 cursor-pointer flex items-center gap-1.5">
            <span>Permissions</span>
            {missingPermsCount > 0 && (
              <Badge variant="destructive" className="h-4 px-1 text-[10px] min-w-4 text-center">
                {missingPermsCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="synchronization" className="rounded-lg text-xs font-semibold px-4 py-2 cursor-pointer flex items-center gap-1.5">
            <span>Synchronization</span>
            {synchronizationSummary && synchronizationSummary.attentionWorkloads > 0 && (
              <span className="h-2 w-2 rounded-full bg-amber-500 shrink-0" />
            )}
          </TabsTrigger>
          <TabsTrigger value="administration" className="rounded-lg text-xs font-semibold px-4 py-2 cursor-pointer">
            Administration
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: OVERVIEW */}
        <TabsContent value="overview" className="space-y-4 focus-visible:outline-none">
          {/* Status Ribbon */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Connection State</span>
              <div className="font-semibold text-xs text-slate-900 dark:text-white capitalize flex items-center gap-1.5 pt-0.5">
                <Server className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                <span>{connectionHealth.label}</span>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Overall Health</span>
              <div className="pt-0.5">{overallHealthBadge}</div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Latest Successful Collection</span>
              <div className="font-semibold text-xs text-slate-900 dark:text-white pt-0.5 truncate">
                {formatDate(tenant.lastSync)}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Last Successful Sync</span>
              <div className="font-semibold text-xs text-slate-900 dark:text-white pt-0.5 truncate">
                {formatDate(synchronizationSummary?.primaryLastSuccessfulAt || tenant.lastSync)}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs col-span-2 sm:col-span-1">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Actionable Issues</span>
              <div className="font-bold text-sm pt-0.5 flex items-center gap-1.5">
                {priorityAttentionItems.length > 0 ? (
                  <span className="text-amber-600 dark:text-amber-400">{priorityAttentionItems.length} issues needing review</span>
                ) : (
                  <span className="text-emerald-600 dark:text-emerald-400">0 issues</span>
                )}
              </div>
            </div>
          </div>

          {/* 4 Compact Summaries */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 p-4 space-y-1">
              <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">Connection Status</div>
              <div className="text-base font-bold text-slate-900 dark:text-white capitalize">
                {connectionHealth.label}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 p-4 space-y-1">
              <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">Collection Coverage</div>
              <div className="text-base font-bold text-slate-900 dark:text-white">
                {collectionReadiness
                  ? `${collectionReadiness.workloads.filter((w) => w.state === 'READY').length} / ${collectionReadiness.workloads.length} workloads ready`
                  : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 p-4 space-y-1">
              <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">Permissions Granted</div>
              <div className="text-base font-bold text-slate-900 dark:text-white">
                {accessSummary.contractAvailable
                  ? `${accessSummary.granted} / ${accessSummary.permissions.length} verified scopes`
                  : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 p-4 space-y-1">
              <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">Synchronization Progress</div>
              <div className="text-base font-bold text-slate-900 dark:text-white">
                {synchronizationSummary
                  ? `${synchronizationSummary.currentWorkloads} / ${synchronizationSummary.applicableWorkloads} modules current`
                  : 'Not available'}
              </div>
            </div>
          </div>

          {/* PRIORITY ATTENTION SECTION */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4 shadow-2xs">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">Priority attention</h2>
              </div>
              <span className="text-xs text-slate-500">
                {priorityAttentionItems.length} item{priorityAttentionItems.length !== 1 ? 's' : ''} require administrative review
              </span>
            </div>

            {priorityAttentionItems.length === 0 ? (
              <div className="text-xs text-slate-500 dark:text-slate-400 py-4 text-center">
                No priority issues detected across tenant connections, collection readiness, or permissions.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {priorityAttentionItems.map((item) => (
                  <div key={item.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-slate-900 dark:text-white">{item.title}</span>
                        <Badge
                          variant={item.statusVariant === 'red' ? 'destructive' : 'secondary'}
                          className="text-[10px] px-2 py-0"
                        >
                          {item.status}
                        </Badge>
                        <span className="text-slate-400 dark:text-slate-500 text-[11px]">• {item.timestamp}</span>
                      </div>
                      <p className="text-slate-600 dark:text-slate-300 text-xs leading-relaxed">{item.explanation}</p>
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        handleTabChange(item.targetTab)
                        if (item.targetRowId) {
                          setExpandedRows((prev) => ({ ...prev, [item.targetRowId!.replace('row-', '')]: true }))
                          setFocusedRowId(item.targetRowId)
                        }
                      }}
                      className="text-xs h-7 gap-1 text-teal-700 dark:text-teal-300 border-teal-200 dark:border-teal-800 bg-teal-50/50 hover:bg-teal-100 dark:hover:bg-teal-900/40 shrink-0 self-start sm:self-auto cursor-pointer"
                    >
                      <span>{item.actionLabel}</span>
                      <ChevronRight className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* CONNECTION SUMMARY */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4 shadow-2xs">
            <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
              <Server className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Connection summary</h2>
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4 text-xs">
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Connection Method</dt>
                <dd className="font-medium text-slate-900 dark:text-white mt-0.5">
                  {tenant.connectionMode === 'customer-managed' ? 'Manually registered app' : 'HawkView-managed'}
                </dd>
              </div>

              {tenant.appName && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Application Name</dt>
                  <dd className="font-medium text-slate-900 dark:text-white mt-0.5">{tenant.appName}</dd>
                </div>
              )}

              {tenant.customerClientId && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Application / Client ID</dt>
                  <dd className="font-mono font-medium text-slate-900 dark:text-white mt-0.5">
                    {maskClientId(tenant.customerClientId)}
                  </dd>
                </div>
              )}

              <div>
                <dt className="text-slate-500 dark:text-slate-400">Microsoft Tenant ID</dt>
                <dd className="font-mono font-medium text-slate-900 dark:text-white mt-0.5 flex items-center gap-1.5 truncate">
                  <span className="truncate">{tenant.microsoftTenantId || tenant.id}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 text-slate-400 hover:text-slate-600"
                    onClick={() => handleCopy(String(tenant.microsoftTenantId || tenant.id), 'conn-tid')}
                  >
                    {copiedKey === 'conn-tid' ? <Check className="h-3 w-3 text-teal-600" /> : <Copy className="h-3 w-3" />}
                  </Button>
                </dd>
              </div>

              <div>
                <dt className="text-slate-500 dark:text-slate-400">Primary Domain</dt>
                <dd className="font-medium text-slate-900 dark:text-white mt-0.5">{tenant.domain || 'Not available'}</dd>
              </div>

              {tenant.connectedAt && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Date Connected</dt>
                  <dd className="font-medium text-slate-900 dark:text-white mt-0.5">{formatDate(tenant.connectedAt)}</dd>
                </div>
              )}

              <div>
                <dt className="text-slate-500 dark:text-slate-400">Credential Type</dt>
                <dd className="font-medium text-slate-900 dark:text-white mt-0.5">
                  {tenant.connectionMode === 'customer-managed' ? 'Stored in Secret Manager' : 'HawkView OAuth Token'}
                </dd>
              </div>

              {tenant.credentialExpiresAt && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Credential Expiry</dt>
                  <dd className="font-medium text-slate-900 dark:text-white mt-0.5">{formatDate(tenant.credentialExpiresAt)}</dd>
                </div>
              )}

              {tenant.organization?.name && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">HawkView Workspace</dt>
                  <dd className="font-medium text-slate-900 dark:text-white mt-0.5">{tenant.organization.name}</dd>
                </div>
              )}
            </dl>
          </div>

          {/* QUICK ACTIONS BAR */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between gap-3 flex-wrap shadow-2xs">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Quick Actions</span>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleVerifyConnection}
                disabled={isVerifying}
                className="text-xs h-8 gap-1.5"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', isVerifying && 'animate-spin')} />
                <span>Verify Connection</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleReviewPermissions}
                disabled={isReviewingConsent}
                className="text-xs h-8 gap-1.5"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span>Review Permissions</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRefreshConnection}
                disabled={isSyncing}
                className="text-xs h-8 gap-1.5"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')} />
                <span>Refresh Sync Status</span>
              </Button>
            </div>
          </div>
        </TabsContent>

        {/* TAB 2: COLLECTION */}
        <TabsContent value="collection" className="space-y-4 focus-visible:outline-none">
          {/* Toolbar */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 sm:p-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shadow-2xs">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <Input
                type="text"
                placeholder="Search workload or component..."
                value={collectionSearch}
                onChange={(e) => setCollectionSearch(e.target.value)}
                className="pl-9 h-8 text-xs bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700"
              />
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 text-xs">
              <span className="text-slate-400 shrink-0 mr-1 hidden md:inline">Filter:</span>
              <Button
                type="button"
                variant={collectionFilterState === 'ALL' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setCollectionFilterState('ALL')}
                className="h-7 text-xs px-2.5 rounded-lg"
              >
                All ({collectionReadiness?.workloads.length || 0})
              </Button>
              <Button
                type="button"
                variant={collectionFilterState === 'ATTENTION' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setCollectionFilterState('ATTENTION')}
                className="h-7 text-xs px-2.5 rounded-lg"
              >
                Needs Attention ({collectionReadiness?.workloads.filter((w) => w.state !== 'READY').length || 0})
              </Button>
              <Button
                type="button"
                variant={collectionFilterState === 'READY' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setCollectionFilterState('READY')}
                className="h-7 text-xs px-2.5 rounded-lg"
              >
                Ready
              </Button>
              <Button
                type="button"
                variant={collectionFilterState === 'BLOCKED_PERMISSION' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setCollectionFilterState('BLOCKED_PERMISSION')}
                className="h-7 text-xs px-2.5 rounded-lg"
              >
                Blocked Permission
              </Button>
              <Button
                type="button"
                variant={collectionFilterState === 'STALE' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setCollectionFilterState('STALE')}
                className="h-7 text-xs px-2.5 rounded-lg"
              >
                Stale
              </Button>
            </div>
          </div>

          {/* Collection Table */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider border-b border-slate-200/90 dark:border-slate-800">
                  <tr>
                    <th className="px-4 py-3">Workload</th>
                    <th className="px-3 py-3">State</th>
                    <th className="px-3 py-3">Capability</th>
                    <th className="px-3 py-3">Permission</th>
                    <th className="px-3 py-3">Freshness</th>
                    <th className="px-3 py-3">Last Attempt</th>
                    <th className="px-3 py-3">Last Success</th>
                    <th className="px-3 py-3 text-center">Components</th>
                    <th className="px-3 py-3 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredWorkloads.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                        No workloads matching the selected filter criteria.
                      </td>
                    </tr>
                  ) : (
                    filteredWorkloads.map((w) => {
                      const isExpanded = Boolean(expandedRows[w.key])
                      const rowId = `row-${w.key}`
                      const isFocused = focusedRowId === rowId

                      return (
                        <React.Fragment key={w.key}>
                          <tr
                            id={rowId}
                            tabIndex={0}
                            className={cn(
                              'hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors',
                              isExpanded && 'bg-slate-50/40 dark:bg-slate-800/20',
                              isFocused && 'ring-2 ring-teal-500 dark:ring-teal-400 ring-offset-1'
                            )}
                          >
                            <td className="px-4 py-3 font-semibold text-slate-900 dark:text-white">
                              {w.workload}
                            </td>
                            <td className="px-3 py-3">
                              <Badge
                                variant={
                                  w.state === 'READY'
                                    ? 'success'
                                    : ['BLOCKED_PERMISSION', 'FAILED_TRANSIENT'].includes(w.state)
                                    ? 'destructive'
                                    : 'secondary'
                                }
                                className="text-[11px] px-2 py-0"
                              >
                                {readinessLabel(w.state)}
                              </Badge>
                            </td>
                            <td className="px-3 py-3 text-slate-600 dark:text-slate-300">
                              {readinessLabel(w.configuredCapability)}
                            </td>
                            <td className="px-3 py-3 text-slate-600 dark:text-slate-300">
                              {readinessLabel(w.permissionStatus)}
                            </td>
                            <td className="px-3 py-3 text-slate-600 dark:text-slate-300">
                              {readinessLabel(w.freshness)}
                            </td>
                            <td className="px-3 py-3 text-slate-500 dark:text-slate-400">
                              {formatDate(w.lastAttemptAt)}
                            </td>
                            <td className="px-3 py-3 text-slate-500 dark:text-slate-400">
                              {formatDate(w.lastSuccessfulAt)}
                            </td>
                            <td className="px-3 py-3 text-center">
                              <Badge variant="outline" className="text-[10px]">
                                {w.datasets.length || w.components.length}
                              </Badge>
                            </td>
                            <td className="px-3 py-3 text-right">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => toggleRowExpansion(w.key)}
                                className="h-7 w-7 p-0 cursor-pointer"
                                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} details for ${w.workload}`}
                              >
                                {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                              </Button>
                            </td>
                          </tr>

                          {/* EXPANDED ROW DETAILS */}
                          {isExpanded && (
                            <tr className="bg-slate-50/60 dark:bg-slate-800/30">
                              <td colSpan={9} className="px-4 py-4 space-y-3">
                                {/* Reason & Remediation */}
                                {readinessDiagnostic(w.reasonCode, w.reason) && (
                                  <div className="rounded-lg border border-amber-200 bg-amber-50/90 dark:bg-amber-950/30 dark:border-amber-900/50 p-3 text-amber-900 dark:text-amber-200 space-y-1">
                                    <div className="font-semibold text-xs">Diagnostic Reason</div>
                                    <p className="leading-relaxed">{readinessDiagnostic(w.reasonCode, w.reason)}</p>
                                  </div>
                                )}

                                {/* Special Inline SharePoint Note */}
                                {(w.key === 'SHAREPOINT_SITES' || w.workload.toLowerCase().includes('sharepoint')) && (
                                  <div className="rounded-lg border border-teal-200 bg-teal-50/70 dark:bg-teal-950/30 dark:border-teal-900/50 p-3 text-teal-900 dark:text-teal-200 text-xs space-y-1">
                                    <div className="font-semibold">SharePoint Least-Privilege Mode</div>
                                    <p className="leading-relaxed">
                                      HawkView collects SharePoint site metadata and storage metrics using least-privilege Graph permissions (`Sites.Read.All`). Individual item contents are not downloaded or indexed.
                                    </p>
                                  </div>
                                )}

                                {/* Special Inline M365 Audit Components */}
                                {(w.key === 'M365_AUDIT' || w.workload.toLowerCase().includes('audit')) && (
                                  <div className="rounded-lg border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-2">
                                    <div className="font-semibold text-xs text-slate-800 dark:text-slate-200">
                                      M365 Unified Audit Content Types (4)
                                    </div>
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                                      <div className="p-2 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700">
                                        <span className="font-semibold block">Audit.Exchange</span>
                                        <span className="text-[11px] text-slate-500">Mailbox & admin actions</span>
                                      </div>
                                      <div className="p-2 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700">
                                        <span className="font-semibold block">Audit.General</span>
                                        <span className="text-[11px] text-slate-500">General M365 events</span>
                                      </div>
                                      <div className="p-2 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700">
                                        <span className="font-semibold block">Audit.AzureActiveDirectory</span>
                                        <span className="text-[11px] text-slate-500">Entra ID directory audit</span>
                                      </div>
                                      <div className="p-2 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700">
                                        <span className="font-semibold block">DLP.All</span>
                                        <span className="text-[11px] text-slate-500">DLP policy enforcement</span>
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {/* Dataset-level Microsoft access contract */}
                                {w.datasets.length > 0 && (
                                  <div className="space-y-2">
                                    <div className="font-semibold text-xs text-slate-700 dark:text-slate-300">
                                      Dataset capabilities ({w.datasets.length})
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                                      {w.datasets.map((rawDataset) => {
                                        const dataset = microsoftAccessDatasetView(rawDataset, accessCatalog)
                                        if (!dataset) {
                                          return (
                                            <div key={rawDataset.key} className="p-2.5 rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-1.5">
                                              <div className="flex items-start justify-between gap-2">
                                                <span className="font-medium text-slate-900 dark:text-white">Unsupported capability contract</span>
                                                <Badge variant="secondary" className="text-[10px] shrink-0">Unsupported</Badge>
                                              </div>
                                              <p className="text-[11px] text-slate-500">Static capability metadata was not available for key {rawDataset.key}.</p>
                                            </div>
                                          )
                                        }
                                        return (
                                          <div
                                            key={dataset.key}
                                            className="p-2.5 rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-1.5"
                                          >
                                            <div className="flex items-start justify-between gap-2">
                                              <div>
                                                <span className="font-medium text-slate-900 dark:text-white block">{dataset.label}</span>
                                                <span className="text-[11px] text-slate-500">{datasetTierLabel(dataset.tier)}</span>
                                              </div>
                                              <Badge
                                                variant={dataset.state === 'READY' ? 'success' : datasetStateNeedsTenantAction(dataset) ? 'destructive' : 'secondary'}
                                                className="text-[10px] shrink-0"
                                              >
                                                {readinessLabel(dataset.state)}
                                              </Badge>
                                            </div>
                                            <div className="text-[11px] text-slate-500">
                                              Permission: {readinessLabel(dataset.permissionStatus)}
                                              {dataset.fallbackDatasetKey ? ` · Fallback: ${dataset.fallbackDatasetKey}` : ''}
                                            </div>
                                            {dataset.reason && <p className="text-[11px] text-slate-600 dark:text-slate-400">{dataset.reason}</p>}
                                          </div>
                                        )
                                      })}
                                    </div>
                                  </div>
                                )}

                                {/* Legacy component statuses */}
                                {w.components.length > 0 && (
                                  <div className="space-y-2">
                                    <div className="font-semibold text-xs text-slate-700 dark:text-slate-300">
                                      Component Statuses ({w.components.length})
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                                      {w.components.map((comp) => (
                                        <div
                                          key={comp.key}
                                          className="p-2.5 rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-start justify-between gap-2"
                                        >
                                          <div>
                                            <span className="font-medium text-slate-900 dark:text-white block">
                                              {comp.label}
                                            </span>
                                            {comp.reason && (
                                              <span className="text-[11px] text-slate-500 block mt-0.5">
                                                {comp.reason}
                                              </span>
                                            )}
                                          </div>
                                          <Badge variant="outline" className="text-[10px] shrink-0">
                                            {readinessLabel(comp.state)}
                                          </Badge>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {/* Remediation Guidance */}
                                {w.remediation && (
                                  <div className="text-xs text-slate-600 dark:text-slate-400 pt-1">
                                    <span className="font-semibold text-slate-700 dark:text-slate-300">Remediation: </span>
                                    {readinessRemediation(w.state, w.remediation)}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>

        {/* TAB 3: PERMISSIONS */}
        <TabsContent value="permissions" className="space-y-4 focus-visible:outline-none">
          {/* Top Summary Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Connection / Core</span>
              <div className="text-lg font-bold text-slate-900 dark:text-white pt-0.5">
                {hasPermissionsData ? `${accessSummary.connectionRequired} / ${accessSummary.core}` : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Optional / Fallback</span>
              <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400 pt-0.5">
                {hasPermissionsData ? `${accessSummary.optional} / ${accessSummary.fallback + accessSummary.alternative}` : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Missing Core</span>
              <div className="text-lg font-bold text-amber-600 dark:text-amber-400 pt-0.5">
                {missingPermsCount}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Verification State</span>
              <div className="pt-0.5">
                {!hasPermissionsData ? (
                  <Badge variant="secondary" className="text-[10px]">Not verified</Badge>
                ) : missingPermsCount > 0 ? (
                  <Badge variant="destructive" className="text-[10px]">Action Required</Badge>
                ) : accessSummary.missingOptional > 0 || accessSummary.unverified > 0 ? (
                  <Badge variant="secondary" className="text-[10px]">Core available</Badge>
                ) : (
                  <Badge variant="success" className="text-[10px]">Verified</Badge>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs col-span-2 sm:col-span-1">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Latest Permission Verification</span>
              <div className="text-xs font-semibold text-slate-900 dark:text-white pt-0.5 truncate">
                {formatDate(permissionVerificationAt)}
              </div>
            </div>
          </div>

          {/* Toolbar */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 sm:p-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shadow-2xs">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <Input
                type="text"
                placeholder="Search permission or purpose..."
                value={permSearch}
                onChange={(e) => setPermSearch(e.target.value)}
                className="pl-9 h-8 text-xs bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700"
              />
            </div>

            <div className="flex items-center gap-2 overflow-x-auto text-xs">
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={handleReviewPermissions}
                disabled={isReviewingConsent}
                className="h-8 text-xs font-semibold gap-1.5 bg-teal-600 hover:bg-teal-700 text-white cursor-pointer shrink-0"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span>Review Permissions</span>
              </Button>
            </div>
          </div>

          {/* Permissions Table */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs overflow-hidden">
            <div className="overflow-x-auto max-h-[600px]">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider border-b border-slate-200/90 dark:border-slate-800 sticky top-0 z-10">
                  <tr>
                    <th className="px-4 py-3">Permission Name</th>
                    <th className="px-3 py-3">API / Service</th>
                    <th className="px-3 py-3">Type</th>
                    <th className="px-3 py-3">Requirement</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-4 py-3">Purpose & Scope Breadth</th>
                    <th className="px-3 py-3">Latest Permission Verification</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredPermissions.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                        No permissions found matching search filter.
                      </td>
                    </tr>
                  ) : (
                    filteredPermissions.map((p: any, idx: number) => (
                      <tr key={idx} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors">
                        <td className="px-4 py-3 font-mono font-semibold text-slate-900 dark:text-white">
                          {p.name}
                        </td>
                        <td className="px-3 py-3 text-slate-600 dark:text-slate-300">{p.service}</td>
                        <td className="px-3 py-3 text-slate-500 dark:text-slate-400">{p.type}</td>
                        <td className="px-3 py-3 text-slate-700 dark:text-slate-300 font-medium">{p.requirement}</td>
                        <td className="px-3 py-3">
                          {p.status === 'Granted' && <Badge variant="success" className="text-[10px]">Granted</Badge>}
                          {p.status === 'Missing' && <Badge variant="destructive" className="text-[10px]">Missing</Badge>}
                          {p.status === 'Not verified' && <Badge variant="secondary" className="text-[10px]">Not verified</Badge>}
                        </td>
                        <td className="px-4 py-3 max-w-md space-y-0.5">
                          <p className="font-medium text-slate-800 dark:text-slate-200">{p.purpose}</p>
                          <p className="text-[11px] text-slate-500 leading-snug">{p.consentMode}</p>
                        </td>
                        <td className="px-3 py-3 text-slate-500 dark:text-slate-400">{formatDate(permissionVerificationAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>

        {/* TAB 4: SYNCHRONIZATION */}
        <TabsContent value="synchronization" className="space-y-4 focus-visible:outline-none">
          {/* Summary Ribbon */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Overall Collection Status</span>
              <div className="font-semibold text-xs text-slate-900 dark:text-white capitalize pt-0.5">
                {synchronizationSummary ? settingsSynchronizationStateLabel(synchronizationSummary.overallState) : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Workloads Ready</span>
              <div className="font-semibold text-xs text-slate-900 dark:text-white pt-0.5">
                {synchronizationSummary ? `${synchronizationSummary.currentWorkloads} / ${synchronizationSummary.applicableWorkloads}` : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Status Evaluated</span>
              <div className="font-semibold text-xs text-slate-900 dark:text-white pt-0.5 truncate">
                {formatDate(collectionReadiness?.evaluatedAt)}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Affected Data Last Success</span>
              <div className="font-semibold text-xs text-slate-900 dark:text-white pt-0.5">
                {synchronizationSummary ? calculateFreshness(synchronizationSummary.primaryLastSuccessfulAt) : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-1 shadow-2xs col-span-2 sm:col-span-1">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Needs Attention</span>
              <div className="font-semibold text-xs pt-0.5">
                {synchronizationAttention.total > 0 ? (
                  <span className="text-amber-600 dark:text-amber-400">{synchronizationAttention.label}</span>
                ) : (
                  <span className="text-emerald-600 dark:text-emerald-400">None</span>
                )}
              </div>
            </div>
          </div>

          {/* Toolbar */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 sm:p-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shadow-2xs">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <Input
                type="text"
                placeholder="Search module or resource..."
                value={syncSearch}
                onChange={(e) => setSyncSearch(e.target.value)}
                className="pl-9 h-8 text-xs bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700"
              />
            </div>

            <div className="flex items-center gap-2 overflow-x-auto text-xs">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRefreshConnection}
                disabled={isSyncing}
                className="h-8 text-xs gap-1.5 cursor-pointer"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')} />
                <span>Refresh Status</span>
              </Button>
            </div>
          </div>

          {/* Modules Table */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider border-b border-slate-200/90 dark:border-slate-800">
                  <tr>
                    <th className="px-4 py-3">Module</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Last Attempt</th>
                    <th className="px-3 py-3">Last Success</th>
                    <th className="px-3 py-3">Freshness</th>
                    <th className="px-4 py-3">Key Result</th>
                    <th className="px-3 py-3 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredSyncModules.map((m) => {
                    const isExpanded = Boolean(expandedRows[m.key] || expandedRows[m.name])
                    const rowId = `row-${m.key}`
                    const isFocused = focusedRowId === rowId

                    return (
                      <React.Fragment key={m.key}>
                        <tr
                          id={rowId}
                          tabIndex={0}
                          className={cn(
                            'hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors',
                            isExpanded && 'bg-slate-50/40 dark:bg-slate-800/20',
                            isFocused && 'ring-2 ring-teal-500 dark:ring-teal-400 ring-offset-1'
                          )}
                        >
                          <td className="px-4 py-3 font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                            <div className="p-1.5 rounded bg-slate-100 dark:bg-slate-800">{m.icon}</div>
                            <span>{m.name}</span>
                          </td>
                          <td className="px-3 py-3">
                            <Badge
                              variant={m.status === 'READY' ? 'success' : ['BLOCKED_PERMISSION', 'FAILED_TRANSIENT'].includes(m.status) ? 'destructive' : 'secondary'}
                              className="text-[11px] px-2 py-0"
                            >
                              {settingsSynchronizationStateLabel(m.status)}
                            </Badge>
                          </td>
                          <td className="px-3 py-3 text-slate-500 dark:text-slate-400">{formatDate(m.lastAttempt)}</td>
                          <td className="px-3 py-3 text-slate-500 dark:text-slate-400">{formatDate(m.lastSuccess)}</td>
                          <td className="px-3 py-3 text-slate-600 dark:text-slate-300">{readinessLabel(String(m.freshness))}</td>
                          <td className="px-4 py-3 text-slate-600 dark:text-slate-300 max-w-xs truncate">
                            {m.issue ? m.issue : 'Data synchronized successfully'}
                          </td>
                          <td className="px-3 py-3 text-right">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => toggleRowExpansion(m.key)}
                              className="h-7 w-7 p-0 cursor-pointer"
                              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} details for ${m.name}`}
                            >
                              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </Button>
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr className="bg-slate-50/60 dark:bg-slate-800/30">
                            <td colSpan={7} className="px-4 py-4 space-y-3">
                              {m.issue && (
                                <div className="rounded-lg border border-amber-200 bg-amber-50/90 dark:bg-amber-950/30 dark:border-amber-900/50 p-3 text-amber-900 dark:text-amber-200 space-y-1">
                                  <div className="font-semibold text-xs">Diagnostic Message</div>
                                  <p className="leading-relaxed">{m.issue}</p>
                                </div>
                              )}

                              {m.key === 'M365_AUDIT' && auditSync && (
                                <div id="sync-health" tabIndex={-1} className="rounded-lg border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-2">
                                  <div className="font-semibold text-xs text-slate-800 dark:text-slate-200">
                                    Microsoft 365 Unified Audit Synchronization
                                  </div>
                                  <dl className="grid grid-cols-2 gap-2 text-xs text-slate-600 dark:text-slate-400">
                                    <div><dt className="text-slate-400">Classification</dt><dd className="font-semibold text-slate-900 dark:text-white">{auditSync.classification}</dd></div>
                                    <div><dt className="text-slate-400">Last Attempt</dt><dd className="font-semibold text-slate-900 dark:text-white">{formatDate(auditSync.lastAttemptAt)}</dd></div>
                                    <div><dt className="text-slate-400">Last Success</dt><dd className="font-semibold text-slate-900 dark:text-white">{formatDate(auditSync.lastSuccessfulAt)}</dd></div>
                                    <div><dt className="text-slate-400">Current Reason</dt><dd className="font-semibold text-slate-900 dark:text-white">{auditSync.message}</dd></div>
                                  </dl>
                                </div>
                              )}

                              {m.remediation && (
                                <div className="text-xs text-slate-600 dark:text-slate-400">
                                  <span className="font-semibold text-slate-700 dark:text-slate-300">Remediation Guidance: </span>
                                  {m.remediation}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>

        {/* TAB 5: ADMINISTRATION */}
        <TabsContent value="administration" className="space-y-4 focus-visible:outline-none">
          {/* Connection Details Section */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4 shadow-2xs">
            <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
              <Server className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Connection details</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4 text-xs">
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Microsoft Tenant ID</dt>
                <dd className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5 flex items-center gap-1.5 truncate">
                  <span className="truncate">{tenant.microsoftTenantId || tenant.id}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 text-slate-400 hover:text-slate-600"
                    onClick={() => handleCopy(String(tenant.microsoftTenantId || tenant.id), 'admin-tid')}
                  >
                    {copiedKey === 'admin-tid' ? <Check className="h-3 w-3 text-teal-600" /> : <Copy className="h-3 w-3" />}
                  </Button>
                </dd>
              </div>

              <div>
                <dt className="text-slate-500 dark:text-slate-400">Connection Method</dt>
                <dd className="font-semibold text-slate-900 dark:text-white mt-0.5">
                  {tenant.connectionMode === 'customer-managed' ? 'Manually registered app' : 'HawkView-managed'}
                </dd>
              </div>

              {tenant.customerClientId && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Application / Client ID</dt>
                  <dd className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5">
                    {maskClientId(tenant.customerClientId)}
                  </dd>
                </div>
              )}

              <div>
                <dt className="text-slate-500 dark:text-slate-400">Credential Type</dt>
                <dd className="font-semibold text-slate-900 dark:text-white mt-0.5">
                  {tenant.connectionMode === 'customer-managed' ? 'Stored in Secret Manager' : 'HawkView OAuth Token'}
                </dd>
              </div>

              {tenant.credentialExpiresAt && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Credential Expiry</dt>
                  <dd className="font-semibold text-slate-900 dark:text-white mt-0.5">{formatDate(tenant.credentialExpiresAt)}</dd>
                </div>
              )}

              <div>
                <dt className="text-slate-500 dark:text-slate-400">Last Verification</dt>
                <dd className="font-semibold text-slate-900 dark:text-white mt-0.5">{formatDate(tenant.lastSync)}</dd>
              </div>

              {tenant.connectedAt && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Date Connected</dt>
                  <dd className="font-semibold text-slate-900 dark:text-white mt-0.5">{formatDate(tenant.connectedAt)}</dd>
                </div>
              )}
            </div>
          </div>

          <ExchangeReadonlySetup
            tenantId={String(tenant.id)}
            connectionMode={tenant.connectionMode === 'customer-managed' ? 'customer-managed' : 'hawkview-managed'}
            active={activeTab === 'administration'}
            consentResult={microsoftConsentResult}
          />

          {/* Tenant Activity and Ownership Section */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4 shadow-2xs">
            <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
              <Building className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Tenant activity and ownership</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4 text-xs">
              {tenant.connectedBy && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Connected By Account</dt>
                  <dd className="font-semibold text-slate-900 dark:text-white mt-0.5">{tenant.connectedBy}</dd>
                </div>
              )}

              {tenant.organization?.name && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">HawkView Workspace</dt>
                  <dd className="font-semibold text-slate-900 dark:text-white mt-0.5">{tenant.organization.name}</dd>
                </div>
              )}

              <div>
                <dt className="text-slate-500 dark:text-slate-400">Tenant Record ID</dt>
                <dd className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5 flex items-center gap-1.5 truncate">
                  <span className="truncate">{tenant.id}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 text-slate-400 hover:text-slate-600"
                    onClick={() => handleCopy(String(tenant.id), 'rec-id')}
                  >
                    {copiedKey === 'rec-id' ? <Check className="h-3 w-3 text-teal-600" /> : <Copy className="h-3 w-3" />}
                  </Button>
                </dd>
              </div>
            </div>
          </div>

          {/* Actions Section */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4 shadow-2xs">
            <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
              <Lock className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Connection actions</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              <div className="p-3.5 rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 space-y-2 flex flex-col justify-between">
                <div>
                  <span className="font-semibold text-slate-900 dark:text-white block">Review Permissions</span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400 block mt-0.5">
                    Re-evaluate OAuth scope permissions granted to HawkView.
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleReviewPermissions}
                  disabled={isReviewingConsent}
                  className="w-full text-xs h-8 cursor-pointer"
                >
                  Review permissions
                </Button>
              </div>

              <div className="p-3.5 rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 space-y-2 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-900 dark:text-white block">Reconnect Tenant</span>
                    <Badge variant="secondary" className="text-[10px]">Disabled</Badge>
                  </div>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400 block mt-0.5">
                    Re-initialize OAuth handshake or app secret registration.
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled
                  title="Backend support is required before this action can be used."
                  className="w-full text-xs h-8 cursor-not-allowed opacity-60"
                >
                  Reconnect tenant
                </Button>
              </div>

              <div className="p-3.5 rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 space-y-2 flex flex-col justify-between">
                <div>
                  <span className="font-semibold text-slate-900 dark:text-white block">Refresh Status</span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400 block mt-0.5">
                    Trigger immediate API poll and sync verification.
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleRefreshConnection}
                  disabled={isSyncing}
                  className="w-full text-xs h-8 gap-1.5 cursor-pointer"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')} />
                  <span>Refresh status</span>
                </Button>
              </div>

              <div className="p-3.5 rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 space-y-2 flex flex-col justify-between">
                <div>
                  <span className="font-semibold text-slate-900 dark:text-white block">Tenant Directory</span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400 block mt-0.5">
                    Return to the main list of all managed organization tenants.
                  </span>
                </div>
                <Button type="button" variant="secondary" size="sm" asChild className="w-full text-xs h-8 cursor-pointer">
                  <Link href="/tenants">Return to Directory</Link>
                </Button>
              </div>
            </div>
          </div>

          {/* Danger Zone Section */}
          {canDeleteTenant && (
            <div className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/30 dark:bg-red-950/10 p-5 space-y-4 shadow-2xs">
              <div
                className="flex items-center justify-between cursor-pointer select-none"
                onClick={() => setIsDangerZoneExpanded(!isDangerZoneExpanded)}
              >
                <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
                  <ShieldAlert className="h-4 w-4" />
                  <h2 className="text-sm font-bold">Danger zone: Disconnect and delete tenant</h2>
                </div>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-red-700 dark:text-red-400 gap-1">
                  <span>{isDangerZoneExpanded ? 'Hide' : 'Expand'}</span>
                  {isDangerZoneExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </Button>
              </div>

              {isDangerZoneExpanded && (
                <div className="space-y-4 pt-2 border-t border-red-200/80 dark:border-red-900/50 text-xs">
                  <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                    Disconnecting and deleting this tenant removes the tenant record, synchronized data, and stored connection credentials from this HawkView workspace.
                    <br />
                    <strong className="text-slate-900 dark:text-white">Note:</strong> This does not delete or modify Microsoft 365 tenant data.
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-3 rounded-lg border border-red-200/80 dark:border-red-900/50 bg-white dark:bg-slate-900">
                      <span className="text-slate-500 block text-[11px]">Target Tenant Name</span>
                      <span className="font-bold text-slate-900 dark:text-white mt-0.5 block">{tenant.name}</span>
                    </div>

                    <div className="p-3 rounded-lg border border-red-200/80 dark:border-red-900/50 bg-white dark:bg-slate-900">
                      <span className="text-slate-500 block text-[11px]">Microsoft Tenant ID to match</span>
                      <div className="mt-0.5 flex items-center justify-between gap-1">
                        <code className="font-mono font-bold text-slate-900 dark:text-white select-all">
                          {tenant.microsoftTenantId || tenant.id}
                        </code>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[10px] gap-1"
                          onClick={() => handleCopy(String(tenant.microsoftTenantId || tenant.id), 'del-tid')}
                        >
                          <Copy className="h-3 w-3" /> Copy
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="confirm-tid-input" className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Type the Microsoft tenant ID to confirm deletion:
                    </Label>
                    <Input
                      id="confirm-tid-input"
                      type="text"
                      value={confirmTenantId}
                      onChange={(e) => setConfirmTenantId(e.target.value)}
                      placeholder={tenant.microsoftTenantId || tenant.id}
                      className="font-mono text-xs bg-white dark:bg-slate-900 border-red-200 dark:border-red-900/50 focus-visible:ring-red-500"
                    />
                  </div>

                  <div className="flex items-start gap-2 pt-1">
                    <Checkbox
                      id="ack-checkbox"
                      checked={ackChecked}
                      onCheckedChange={(checked) => setAckChecked(Boolean(checked))}
                      className="mt-0.5 data-[state=checked]:bg-red-600 data-[state=checked]:border-red-600"
                    />
                    <Label htmlFor="ack-checkbox" className="text-xs text-slate-700 dark:text-slate-300 leading-snug cursor-pointer">
                      I acknowledge that deleting this tenant will permanently remove its record, synchronized data, and credentials from HawkView workspace.
                    </Label>
                  </div>

                  {deleteError && (
                    <div className="rounded-lg border border-red-300 bg-red-100 dark:bg-red-950/80 p-3 text-xs text-red-800 dark:text-red-200 font-medium">
                      {deleteError}
                    </div>
                  )}

                  <div className="pt-1">
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={handleDeleteTenant}
                      disabled={
                        isDeleting ||
                        !ackChecked ||
                        confirmTenantId.trim().toLowerCase() !== String(tenant.microsoftTenantId || tenant.id).trim().toLowerCase()
                      }
                      className="w-full sm:w-auto h-8 text-xs font-semibold gap-1.5 cursor-pointer shadow-2xs"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>{isDeleting ? 'Deleting tenant...' : 'Delete tenant from HawkView'}</span>
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
