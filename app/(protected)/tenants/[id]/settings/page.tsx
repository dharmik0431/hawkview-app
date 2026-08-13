'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { tenantOverviewPath } from '@/lib/tenants/navigation'
import { useParams, useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/components/providers/auth-provider'

import { apiClient } from '@/lib/api/client'
import type { TenantBundle } from '@/types/tenant-data'

import {
  ChevronLeft,
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
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { LoadingState } from '@/components/common/loading-state'
import { ErrorState } from '@/components/common/error-state'

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
    if (diffHours < 24)
      return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`
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

export default function TenantSettingsPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { session } = useAuth()
  const tenantId = params?.id
  const canDeleteTenant =
    session?.user.memberships.some(
      (membership) =>
        membership.status === 'ACTIVE' &&
        ['MSP_OWNER', 'MSP_ADMIN'].includes(membership.role)
    ) ?? false

  const [bundle, setBundle] = useState<TenantBundle | null>(null)
  const [tenantListRecord, setTenantListRecord] = useState<any | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  )
  const [loadError, setLoadError] = useState<string | null>(null)

  // Action states
  const [isVerifying, setIsVerifying] = useState(false)
  const [verifyNotice, setVerifyNotice] = useState<string | null>(null)

  const [isSyncing, setIsSyncing] = useState(false)
  const [syncNotice, setSyncNotice] = useState<{
    message: string
    type: 'success' | 'error'
  } | null>(null)

  const [isReviewingConsent, setIsReviewingConsent] = useState(false)
  const [consentError, setConsentError] = useState<string | null>(null)

  // Danger zone state
  const [confirmTenantId, setConfirmTenantId] = useState('')
  const [ackChecked, setAckChecked] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const fetchTenantData = useCallback(async () => {
    if (!tenantId) return
    setLoadState('loading')
    setLoadError(null)

    try {
      const [bundleRes, listRes] = await Promise.allSettled([
        apiClient.get<any>(
          `/api/tenants/${encodeURIComponent(String(tenantId))}`
        ),
        apiClient.get<any>('/api/tenants'),
      ])

      let loadedBundle: TenantBundle | null = null
      if (bundleRes.status === 'fulfilled' && bundleRes.value?.bundle) {
        loadedBundle = bundleRes.value.bundle
        setBundle(loadedBundle)
      }

      if (listRes.status === 'fulfilled' && listRes.value?.tenants) {
        const found = listRes.value.tenants.find(
          (t: any) =>
            String(t.id).toLowerCase() === String(tenantId).toLowerCase()
        )
        if (found) setTenantListRecord(found)
      }

      if (!loadedBundle && !bundleRes) {
        throw new Error('Unable to load tenant configuration.')
      }

      setLoadState('ready')
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Unable to load tenant settings.'
      setLoadError(msg)
      setLoadState('error')
    }
  }, [tenantId])

  useEffect(() => {
    fetchTenantData()
  }, [fetchTenantData])

  // Merged tenant data object from bundle and tenant list
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
      provider:
        rawListTenant.provider || rawBundleTenant.provider || 'microsoft',
      status: rawListTenant.status || rawBundleTenant.status || 'healthy',
      connectionStatus:
        rawListTenant.connectionStatus ||
        rawBundleTenant.connectionStatus ||
        null,
      connectionMode:
        rawListTenant.connectionMode ||
        rawBundleTenant.connectionMode ||
        'hawkview-managed',
      lastSync: rawListTenant.lastSync || rawBundleTenant.lastSync || null,
      requiredPermissions:
        rawListTenant.requiredPermissions ||
        rawBundleTenant.requiredPermissions ||
        null,
      consentedPermissions:
        rawListTenant.consentedPermissions ||
        rawBundleTenant.consentedPermissions ||
        null,
      missingPermissions:
        rawListTenant.missingPermissions ||
        rawBundleTenant.missingPermissions ||
        null,
      connectionErrorCode:
        rawListTenant.connectionErrorCode ||
        rawBundleTenant.connectionErrorCode ||
        null,
      organization:
        rawListTenant.organization || rawBundleTenant.organization || null,
    }
  }, [bundle, tenantListRecord, tenantId])

  // Ask the backend to prove current Microsoft access; do not rely on the
  // last successful synchronization snapshot.
  const handleVerifyConnection = async () => {
    setIsVerifying(true)
    setVerifyNotice(null)
    try {
      await apiClient.post(
        `/api/tenants/${encodeURIComponent(String(tenantId))}/verify-connection`
      )
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
        error instanceof Error
          ? error.message
          : 'Unable to verify the Microsoft connection.'
      )
    } finally {
      setIsVerifying(false)
    }
  }

  // Refresh / Sync handler (using existing endpoint)
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

  // Review permissions action using existing endpoint if supported
  const handleReviewPermissions = async () => {
    setIsReviewingConsent(true)
    setConsentError(null)
    try {
      const res = await apiClient.post<any>(
        `/api/tenants/${tenant.id}/microsoft-consent`
      )
      if (res?.consentUrl) {
        window.open(res.consentUrl, '_blank')
      }
    } catch (err) {
      setConsentError(
        err instanceof Error
          ? err.message
          : 'Microsoft consent workflow is unavailable.'
      )
    } finally {
      setIsReviewingConsent(false)
    }
  }

  // Tenant deletion using existing deletion endpoint
  const handleDeleteTenant = async () => {
    const requiredId = String(tenant.microsoftTenantId || tenant.id)
      .trim()
      .toLowerCase()
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
      await apiClient.delete<{ removed: boolean }>(
        `/api/tenants/${tenant.id}`,
        { confirmMicrosoftTenantId: enteredId }
      )
      await queryClient.invalidateQueries({ queryKey: ['tenants'] })
      router.push('/tenants')
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Failed to disconnect and delete tenant.'
      setDeleteError(msg)
      setIsDeleting(false)
    }
  }

  // Computed permission health status
  const hasPermissionsData =
    Array.isArray(tenant.requiredPermissions) &&
    tenant.requiredPermissions.length > 0
  const missingPermsCount = Array.isArray(tenant.missingPermissions)
    ? tenant.missingPermissions.length
    : 0
  const normalizedConnectionStatus = String(
    tenant.connectionStatus || tenant.status || '',
  ).toLowerCase()
  const isConnectionLost = [
    'error',
    'critical',
    'disconnected',
    'revoked',
  ].includes(normalizedConnectionStatus)
  const requiresMicrosoftReconnection =
    isConnectionLost ||
    ['pending-consent', 'pending', 'warning'].includes(
      normalizedConnectionStatus,
    ) ||
    missingPermsCount > 0

  const permissionStatusBadge = useMemo(() => {
    if (!hasPermissionsData) {
      return <Badge variant="secondary">Verification unavailable</Badge>
    }
    if (missingPermsCount > 0) {
      return (
        <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200 border-amber-300">
          Missing permissions ({missingPermsCount})
        </Badge>
      )
    }
    return <Badge variant="success">Healthy</Badge>
  }, [hasPermissionsData, missingPermsCount])

  // Connection status formatting
  const connectionStatusBadge = useMemo(() => {
    const status = tenant.connectionStatus || tenant.status
    if (status === 'connected' || status === 'healthy' || status === 'active') {
      return (
        <Badge variant="success" className="gap-1">
          <CheckCircle2 className="h-3 w-3" /> Connected
        </Badge>
      )
    }
    if (
      status === 'pending-consent' ||
      status === 'pending' ||
      status === 'warning'
    ) {
      return (
        <Badge variant="warning" className="gap-1">
          <AlertTriangle className="h-3 w-3" /> Pending Consent
        </Badge>
      )
    }
    if (
      status === 'error' ||
      status === 'critical' ||
      status === 'disconnected'
    ) {
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="h-3 w-3" /> Disconnected
        </Badge>
      )
    }
    return <Badge variant="secondary">{status || 'Not available'}</Badge>
  }, [tenant.connectionStatus, tenant.status])

  const overallHealthBadge = useMemo(() => {
    const status = tenant.connectionStatus || tenant.status
    if (status === 'healthy' || status === 'connected' || status === 'active') {
      return (
        <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 font-medium">
          Healthy
        </Badge>
      )
    }
    if (
      status === 'warning' ||
      status === 'pending-consent' ||
      status === 'pending'
    ) {
      return (
        <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 font-medium">
          Warning
        </Badge>
      )
    }
    return (
      <Badge className="bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30 font-medium">
        Critical
      </Badge>
    )
  }, [tenant.connectionStatus, tenant.status])

  // Module health summary
  const moduleRows = useMemo(() => {
    if (!bundle) return []

    return [
      {
        name: 'Organization',
        icon: <Building className="h-4 w-4 text-slate-500" />,
        available: Boolean(bundle.tenant || tenant.name),
        detail: bundle.tenant ? 'Details synchronized' : 'Not available',
      },
      {
        name: 'Users',
        icon: <Users className="h-4 w-4 text-slate-500" />,
        available: Array.isArray(bundle.users) && bundle.users.length > 0,
        detail: Array.isArray(bundle.users)
          ? `${bundle.users.length} users`
          : 'Not available',
      },
      {
        name: 'Groups',
        icon: <Layers className="h-4 w-4 text-slate-500" />,
        available: Boolean(
          bundle.teams ||
          (bundle.exchange && (bundle.exchange as any).groups?.length)
        ),
        detail:
          bundle.exchange && (bundle.exchange as any).groups?.length
            ? `${(bundle.exchange as any).groups.length} mail groups`
            : bundle.teams
              ? 'Teams groups synced'
              : 'Not available',
      },
      {
        name: 'Licenses',
        icon: <Key className="h-4 w-4 text-slate-500" />,
        available: Boolean(
          bundle.licenses?.rows && bundle.licenses.rows.length > 0
        ),
        detail: bundle.licenses?.rows
          ? `${bundle.licenses.rows.length} license SKUs`
          : 'Not available',
      },
      {
        name: 'Entra ID',
        icon: <ShieldCheck className="h-4 w-4 text-slate-500" />,
        available: Boolean(bundle.entra),
        detail: bundle.entra
          ? 'Policies & auth methods loaded'
          : 'Not available',
      },
      {
        name: 'Exchange',
        icon: <Mail className="h-4 w-4 text-slate-500" />,
        available: Boolean(bundle.exchange),
        detail: bundle.exchange?.mailboxes
          ? `${bundle.exchange.mailboxes.length} mailboxes`
          : 'Not available',
      },
      {
        name: 'SharePoint / OneDrive',
        icon: <HardDrive className="h-4 w-4 text-slate-500" />,
        available: Boolean(bundle.sharepoint),
        detail: bundle.sharepoint?.sites
          ? `${bundle.sharepoint.sites.length} sites`
          : 'Not available',
      },
      {
        name: 'Domains and DNS',
        icon: <Server className="h-4 w-4 text-slate-500" />,
        available: Boolean(bundle.dns),
        detail: bundle.dns?.domain
          ? `Domain: ${bundle.dns.domain}`
          : 'Not available',
      },
      {
        name: 'Logs',
        icon: <Activity className="h-4 w-4 text-slate-500" />,
        available: Array.isArray(bundle.signIns) && bundle.signIns.length > 0,
        detail: Array.isArray(bundle.signIns)
          ? `${bundle.signIns.length} sign-in events`
          : 'Not available',
      },
    ]
  }, [bundle, tenant])

  const successfulModulesCount = useMemo(
    () => moduleRows.filter((m) => m.available).length,
    [moduleRows]
  )

  if (loadState === 'loading') {
    return (
      <div className="container mx-auto p-6 max-w-7xl">
        <Card className="rounded-2xl border bg-card shadow-sm">
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
          href={tenantOverviewPath(String(tenantId))}
          className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground transition"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to tenant
        </Link>
        <Card className="rounded-2xl border bg-card shadow-sm">
          <CardContent className="p-8">
            <ErrorState
              message={loadError || 'Unable to load tenant settings.'}
              onRetry={fetchTenantData}
            />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="w-full space-y-4 p-1 sm:p-2">
      {/* Top Navigation */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Link
            href={tenantOverviewPath(String(tenantId))}
            className="inline-flex items-center text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-foreground transition rounded-lg px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Back to tenant
          </Link>
          <span className="text-slate-300 dark:text-slate-700">|</span>
          <Link
            href="/tenants"
            className="text-sm font-medium text-slate-500 hover:text-foreground transition"
          >
            Tenant Directory
          </Link>
        </div>
      </div>

      {/* Page Header */}
      <div className="rounded-2xl border bg-card p-6 shadow-sm space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">
                {tenant.name}
              </h1>
              {connectionStatusBadge}
              {overallHealthBadge}
            </div>

            <div className="mt-2 flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
              <div>
                <span className="font-semibold text-foreground">Domain: </span>
                {tenant.domain || 'Not available'}
              </div>
              <span>•</span>
              <div>
                <span className="font-semibold text-foreground">
                  Microsoft Tenant ID:{' '}
                </span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                  {tenant.microsoftTenantId || tenant.id}
                </code>
              </div>
              <span>•</span>
              <div>
                <span className="font-semibold text-foreground">
                  Last verified:{' '}
                </span>
                {formatDate(tenant.lastSync)}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleVerifyConnection}
              disabled={isVerifying}
              className="gap-2 rounded-xl"
            >
              <RefreshCw
                className={`h-4 w-4 ${isVerifying ? 'animate-spin' : ''}`}
              />
              {isVerifying ? 'Verifying...' : 'Verify connection'}
            </Button>
          </div>
        </div>

        {verifyNotice && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-900/50 px-4 py-2 text-sm text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>{verifyNotice}</span>
          </div>
        )}

        {syncNotice && (
          <div
            className={`rounded-xl border px-4 py-2 text-sm flex items-center gap-2 ${
              syncNotice.type === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:border-emerald-900/50 dark:text-emerald-300'
                : 'border-red-200 bg-red-50 text-red-800 dark:bg-red-950/30 dark:border-red-900/50 dark:text-red-300'
            }`}
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

      {requiresMicrosoftReconnection && (
        <section
          className={`rounded-2xl border p-6 shadow-sm ${
            isConnectionLost
              ? 'border-red-300 bg-red-50/80 dark:border-red-900/70 dark:bg-red-950/25'
              : 'border-amber-300 bg-amber-50/80 dark:border-amber-900/70 dark:bg-amber-950/25'
          }`}
          aria-labelledby="microsoft-reconnection-title"
        >
          <div className="flex items-start gap-4">
            <div
              className={`rounded-xl border p-2.5 ${
                isConnectionLost
                  ? 'border-red-200 bg-red-100 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300'
                  : 'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300'
              }`}
            >
              <ShieldAlert className="h-5 w-5" />
            </div>

            <div className="min-w-0 flex-1 space-y-5">
              <div>
                <h2
                  id="microsoft-reconnection-title"
                  className="text-lg font-bold text-foreground"
                >
                  {isConnectionLost
                    ? 'Reconnect Microsoft 365'
                    : missingPermsCount > 0
                      ? 'Microsoft permission update required'
                    : 'Complete Microsoft 365 authorization'}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {isConnectionLost
                    ? 'HawkView can no longer access this tenant. Previously synchronized data remains available, but new synchronization is paused until access is restored.'
                    : missingPermsCount > 0
                      ? 'HawkView has added a read-only capability that this tenant has not approved yet. Existing data remains available while a Microsoft 365 administrator reviews the update.'
                    : 'This tenant is saved, but HawkView cannot complete synchronization until a Microsoft 365 administrator grants the required permissions.'}
                </p>
              </div>

              <div className="rounded-xl border bg-background/80 p-4">
                <p className="text-sm font-semibold text-foreground">
                  How to restore the connection
                </p>
                <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
                  <li className="flex gap-3">
                    <span className="font-semibold text-foreground">1.</span>
                    Click <strong className="text-foreground">Review and authorize</strong> below.
                  </li>
                  <li className="flex gap-3">
                    <span className="font-semibold text-foreground">2.</span>
                    Sign in with a Microsoft 365 Global Administrator for <strong className="text-foreground">{tenant.name}</strong>.
                  </li>
                  <li className="flex gap-3">
                    <span className="font-semibold text-foreground">3.</span>
                    Review and approve HawkView&apos;s read-only application permissions.
                  </li>
                  <li className="flex gap-3">
                    <span className="font-semibold text-foreground">4.</span>
                    Microsoft closes the authorization window, HawkView verifies the updated permissions automatically, and synchronization resumes.
                  </li>
                </ol>
              </div>

              {missingPermsCount > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-100/60 p-4 dark:border-amber-900 dark:bg-amber-950/40">
                  <p className="text-sm font-semibold text-amber-950 dark:text-amber-100">
                    Missing permissions ({missingPermsCount})
                  </p>
                  <p className="mt-1 break-words text-sm text-amber-800 dark:text-amber-200">
                    {tenant.missingPermissions.join(', ')}
                  </p>
                </div>
              )}

              {consentError && (
                <div className="rounded-xl border border-red-200 bg-red-100/70 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
                  {consentError}
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <Button
                  onClick={handleReviewPermissions}
                  disabled={isReviewingConsent}
                  className="gap-2 rounded-xl"
                >
                  <ExternalLink className="h-4 w-4" />
                  {isReviewingConsent
                    ? 'Opening Microsoft...'
                    : missingPermsCount > 0
                      ? 'Review permission update'
                    : 'Review and authorize'}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleVerifyConnection}
                  disabled={isVerifying}
                  className="gap-2 rounded-xl bg-background"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${isVerifying ? 'animate-spin' : ''}`}
                  />
                  {isVerifying ? 'Verifying...' : 'Verify connection'}
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* SECTION 1: Connection Overview */}
      <Card className="rounded-2xl border shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            Connection overview
          </CardTitle>
          <CardDescription>
            Technical connection parameters and Microsoft tenant registration
            details.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Connection Method
              </span>
              <div className="font-semibold text-foreground">
                {tenant.connectionMode === 'customer-managed'
                  ? 'Manually registered app'
                  : 'HawkView-managed'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Connected Application Name
              </span>
              <div className="font-semibold text-foreground">
                {tenant.appName || tenant.applicationName || 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Application / Client ID
              </span>
              <div className="font-mono font-semibold text-foreground">
                {tenant.customerClientId
                  ? maskClientId(tenant.customerClientId)
                  : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Microsoft Tenant ID
              </span>
              <div
                className="font-mono font-semibold text-foreground truncate"
                title={tenant.microsoftTenantId || tenant.id}
              >
                {tenant.microsoftTenantId || tenant.id}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Primary Domain
              </span>
              <div className="font-semibold text-foreground">
                {tenant.domain || 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Connection Status
              </span>
              <div className="font-semibold text-foreground capitalize">
                {tenant.connectionStatus || tenant.status || 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Date Connected
              </span>
              <div className="font-semibold text-foreground">
                {tenant.connectedAt
                  ? formatDate(tenant.connectedAt)
                  : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Last Successful Sync
              </span>
              <div className="font-semibold text-foreground">
                {formatDate(tenant.lastSync)}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Last Attempted Sync
              </span>
              <div className="font-semibold text-foreground">
                {formatDate(tenant.lastSync)}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Credential / Secret Status
              </span>
              <div className="font-semibold text-foreground">
                {tenant.connectionMode === 'customer-managed'
                  ? 'Stored securely in Secret Manager'
                  : 'HawkView OAuth Token'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Credential Expiration Date
              </span>
              <div className="font-semibold text-foreground">
                {tenant.credentialExpiresAt
                  ? formatDate(tenant.credentialExpiresAt)
                  : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Connected By Account
              </span>
              <div className="font-semibold text-foreground">
                {tenant.connectedBy || 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1 lg:col-span-3">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Owning Organization / Workspace
              </span>
              <div className="font-semibold text-foreground">
                {tenant.organization?.name || 'Not available'}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* SECTION 2: Permission Health */}
      <Card className="rounded-2xl border shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-lg font-bold flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-primary" />
                Permission health
              </CardTitle>
              <CardDescription>
                Summary of Microsoft Graph and Office 365 permission scopes
                granted to HawkView.
              </CardDescription>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={handleReviewPermissions}
              disabled={isReviewingConsent}
              className="gap-2 rounded-xl"
            >
              <ExternalLink className="h-4 w-4" />
              {isReviewingConsent ? 'Starting review...' : 'Review permissions'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {consentError && (
            <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900/50 p-3 text-sm text-red-700 dark:text-red-300">
              {consentError}
            </div>
          )}

          {/* Permission Summary Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="rounded-xl border bg-muted/20 p-3 text-center space-y-1">
              <div className="text-xs text-muted-foreground font-medium">
                Required Permissions
              </div>
              <div className="text-xl font-bold text-foreground">
                {Array.isArray(tenant.requiredPermissions)
                  ? tenant.requiredPermissions.length
                  : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-3 text-center space-y-1">
              <div className="text-xs text-muted-foreground font-medium">
                Granted Permissions
              </div>
              <div className="text-xl font-bold text-foreground">
                {Array.isArray(tenant.consentedPermissions)
                  ? tenant.consentedPermissions.length
                  : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-3 text-center space-y-1">
              <div className="text-xs text-muted-foreground font-medium">
                Missing Permissions
              </div>
              <div className="text-xl font-bold text-foreground">
                {Array.isArray(tenant.missingPermissions)
                  ? tenant.missingPermissions.length
                  : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-3 text-center space-y-1">
              <div className="text-xs text-muted-foreground font-medium">
                Permission Status
              </div>
              <div className="pt-1 flex justify-center">
                {permissionStatusBadge}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-3 text-center space-y-1 col-span-2 sm:col-span-1">
              <div className="text-xs text-muted-foreground font-medium">
                Last Verification
              </div>
              <div className="text-xs font-semibold text-foreground pt-1">
                {formatDate(tenant.lastSync)}
              </div>
            </div>
          </div>

          {missingPermsCount > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-900/50 p-4 text-sm text-amber-900 dark:text-amber-200 flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">
                  Missing permissions warning:{' '}
                </span>
                HawkView may be unable to synchronize some Microsoft 365 data
                because this permission is missing.
              </div>
            </div>
          )}

          {!hasPermissionsData ? (
            <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground space-y-1">
              <Info className="h-5 w-5 mx-auto text-slate-400" />
              <div className="font-semibold text-foreground">
                Permission verification is not available yet.
              </div>
              <div>
                The current API response does not supply individual permission
                scope verification data for this tenant.
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b">
                  <tr>
                    <th className="px-4 py-3">Permission Name</th>
                    <th className="px-4 py-3">API / Service</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Required</th>
                    <th className="px-4 py-3">Granted Status</th>
                    <th className="px-4 py-3">Purpose</th>
                    <th className="px-4 py-3">Last Verified</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tenant.requiredPermissions.map((perm: any, idx: number) => {
                    const permName = typeof perm === 'string' ? perm : perm.name
                    const desc =
                      typeof perm === 'object'
                        ? perm.description
                        : 'Required for synchronization'
                    const isConsented = Array.isArray(
                      tenant.consentedPermissions
                    )
                      ? tenant.consentedPermissions.includes(permName)
                      : true
                    const isMissing = Array.isArray(tenant.missingPermissions)
                      ? tenant.missingPermissions.includes(permName)
                      : false

                    const status = isMissing
                      ? 'Missing'
                      : isConsented
                        ? 'Granted'
                        : 'Not verified'

                    return (
                      <tr key={idx} className="hover:bg-muted/10 transition">
                        <td className="px-4 py-3 font-mono text-xs font-semibold">
                          {permName}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          Microsoft Graph
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          Application
                        </td>
                        <td className="px-4 py-3 text-xs font-medium">Yes</td>
                        <td className="px-4 py-3">
                          {status === 'Granted' && (
                            <Badge
                              variant="success"
                              className="text-[11px] py-0"
                            >
                              Granted
                            </Badge>
                          )}
                          {status === 'Missing' && (
                            <Badge
                              variant="destructive"
                              className="text-[11px] py-0"
                            >
                              Missing
                            </Badge>
                          )}
                          {status === 'Not verified' && (
                            <Badge
                              variant="secondary"
                              className="text-[11px] py-0"
                            >
                              Not verified
                            </Badge>
                          )}
                        </td>
                        <td
                          className="px-4 py-3 text-xs text-muted-foreground max-w-xs truncate"
                          title={desc}
                        >
                          {desc}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {formatDate(tenant.lastSync)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* SECTION 3: Synchronization Health */}
      <Card className="rounded-2xl border shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Synchronization health
          </CardTitle>
          <CardDescription>
            Overall data sync state, module status, and data freshness
            telemetry.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Overall Sync Status
              </span>
              <div className="font-semibold text-foreground capitalize">
                {tenant.status || tenant.connectionStatus || 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Current Sync Progress
              </span>
              <div className="font-semibold text-foreground">
                {tenant.status === 'active' || tenant.status === 'healthy'
                  ? '100% (Completed)'
                  : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Last Full Sync
              </span>
              <div className="font-semibold text-foreground">
                {formatDate(tenant.lastSync)}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Next Scheduled Sync
              </span>
              <div className="font-semibold text-foreground">Not available</div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Successful Modules
              </span>
              <div className="font-semibold text-foreground">
                {bundle
                  ? `${successfulModulesCount} / ${moduleRows.length}`
                  : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Failed Modules
              </span>
              <div className="font-semibold text-foreground">
                {bundle ? '0' : 'Not available'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Data Freshness
              </span>
              <div className="font-semibold text-foreground">
                {calculateFreshness(tenant.lastSync)}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Recent Sync Errors
              </span>
              <div className="font-semibold text-foreground">
                {tenant.connectionErrorCode || 'None'}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">
              Module Synchronization Matrix
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {moduleRows.map((mod) => (
                <div
                  key={mod.name}
                  className="rounded-xl border bg-card p-3 flex items-center justify-between gap-3 shadow-2xs"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 rounded-lg bg-muted/40 shrink-0">
                      {mod.icon}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-foreground truncate">
                        {mod.name}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {mod.detail}
                      </div>
                    </div>
                  </div>

                  {mod.available ? (
                    <Badge variant="success" className="shrink-0 text-[11px]">
                      Synced
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="shrink-0 text-[11px]">
                      Not available
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* SECTION 4: Tenant Activity and Ownership */}
      <Card className="rounded-2xl border shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Building className="h-5 w-5 text-primary" />
            Tenant activity and ownership
          </CardTitle>
          <CardDescription>
            Audit log metadata, consent history, and administrative record
            information.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Tenant Added Date
              </span>
              <div className="font-semibold text-foreground">Not available</div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Added By Name
              </span>
              <div className="font-semibold text-foreground">Not available</div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Added By Email
              </span>
              <div className="font-semibold text-foreground">Not available</div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Connection Method Selected
              </span>
              <div className="font-semibold text-foreground">
                {tenant.connectionMode === 'customer-managed'
                  ? 'Manually registered app'
                  : 'HawkView-managed'}
              </div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Last Modified Date
              </span>
              <div className="font-semibold text-foreground">Not available</div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Last Modified By
              </span>
              <div className="font-semibold text-foreground">Not available</div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Consent Granted Date
              </span>
              <div className="font-semibold text-foreground">Not available</div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Account That Granted Consent
              </span>
              <div className="font-semibold text-foreground">Not available</div>
            </div>

            <div className="rounded-xl border bg-muted/20 p-4 space-y-1">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Tenant Record ID
              </span>
              <div
                className="font-mono font-semibold text-foreground truncate"
                title={tenant.id}
              >
                {tenant.id}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* SECTION 5: Connection Actions */}
      <Card className="rounded-2xl border shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Lock className="h-5 w-5 text-primary" />
            Connection actions
          </CardTitle>
          <CardDescription>
            Administrative triggers for synchronization, permission consent, and
            connection maintenance.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Review Microsoft permissions */}
            <div className="rounded-xl border p-4 space-y-3 flex flex-col justify-between">
              <div>
                <div className="font-semibold text-foreground text-sm">
                  Review Microsoft permissions
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Re-evaluate OAuth scope permissions granted to HawkView.
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleReviewPermissions}
                disabled={isReviewingConsent}
                className="w-full justify-center rounded-xl"
              >
                Review permissions
              </Button>
            </div>

            {/* Reconnect tenant */}
            <div className="rounded-xl border p-4 space-y-3 flex flex-col justify-between bg-muted/10">
              <div>
                <div className="font-semibold text-foreground text-sm flex items-center justify-between">
                  <span>Reconnect tenant</span>
                  <Badge variant="secondary" className="text-[10px]">
                    Disabled
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Re-initialize OAuth handshake or app secret registration.
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled
                title="Backend support is required before this action can be used."
                className="w-full justify-center rounded-xl cursor-not-allowed opacity-60"
              >
                Reconnect tenant
              </Button>
            </div>

            {/* Refresh connection status */}
            <div className="rounded-xl border p-4 space-y-3 flex flex-col justify-between">
              <div>
                <div className="font-semibold text-foreground text-sm">
                  Refresh connection status
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Trigger immediate API poll and sync verification.
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefreshConnection}
                disabled={isSyncing}
                className="w-full justify-center rounded-xl gap-2"
              >
                <RefreshCw
                  className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`}
                />
                {isSyncing ? 'Refreshing...' : 'Refresh status'}
              </Button>
            </div>

            {/* Return to Tenant Directory */}
            <div className="rounded-xl border p-4 space-y-3 flex flex-col justify-between">
              <div>
                <div className="font-semibold text-foreground text-sm">
                  Tenant Directory
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Return to the main list of all managed organization tenants.
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                asChild
                className="w-full justify-center rounded-xl"
              >
                <Link href="/tenants">Return to Directory</Link>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* SECTION 6: Danger Zone */}
      {canDeleteTenant && (
        <Card className="rounded-2xl border border-red-200 dark:border-red-900/50 bg-red-50/20 dark:bg-red-950/10 shadow-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
            <ShieldAlert className="h-5 w-5" />
            <CardTitle className="text-lg font-bold text-red-700 dark:text-red-400">
              Danger zone
            </CardTitle>
          </div>
          <CardDescription className="text-red-900/70 dark:text-red-300/70">
            Disconnect and delete tenant from HawkView workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="rounded-xl border border-red-200 dark:border-red-900/50 bg-background p-4 space-y-2 text-sm">
            <div className="font-semibold text-foreground">
              Disconnect and delete tenant
            </div>
            <p className="text-muted-foreground text-xs leading-relaxed">
              This removes the tenant, synchronized tenant data and stored
              connection credentials from this HawkView workspace. It does not
              delete anything from Microsoft 365.
            </p>
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div className="rounded-xl border bg-background p-3">
                <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                  Target Tenant Name
                </span>
                <div className="font-bold text-foreground mt-0.5">
                  {tenant.name}
                </div>
              </div>
              <div className="rounded-xl border bg-background p-3">
                <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                  Microsoft Tenant ID to match
                </span>
                <div className="mt-1 flex items-center gap-2">
                  <div className="font-mono font-bold text-foreground select-all">
                    {tenant.microsoftTenantId || tenant.id}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() =>
                      navigator.clipboard.writeText(
                        String(tenant.microsoftTenantId || tenant.id)
                      )
                    }
                  >
                    <Copy className="h-3 w-3" /> Copy
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="tenant-id-confirm"
                className="text-sm font-medium"
              >
                Type the Microsoft tenant ID to confirm deletion:
              </Label>
              <Input
                id="tenant-id-confirm"
                value={confirmTenantId}
                onChange={(e) => setConfirmTenantId(e.target.value)}
                placeholder={tenant.microsoftTenantId || tenant.id}
                className="font-mono text-sm bg-background border-red-200 dark:border-red-900/50 focus-visible:ring-red-500"
              />
            </div>

            <div className="flex items-start gap-2 pt-1">
              <Checkbox
                id="ack-checkbox"
                checked={ackChecked}
                onCheckedChange={(checked) => setAckChecked(Boolean(checked))}
                className="mt-0.5 data-[state=checked]:bg-red-600 data-[state=checked]:border-red-600"
              />
              <Label
                htmlFor="ack-checkbox"
                className="text-xs text-slate-700 dark:text-slate-300 leading-snug cursor-pointer"
              >
                I acknowledge that deleting this tenant will permanently remove
                its record, synchronized data, and credentials from HawkView
                workspace.
              </Label>
            </div>

            {deleteError && (
              <div className="rounded-xl border border-red-300 bg-red-100 dark:bg-red-950/80 p-3 text-xs text-red-800 dark:text-red-200 font-medium">
                {deleteError}
              </div>
            )}

            <div className="pt-2">
              <Button
                variant="destructive"
                onClick={handleDeleteTenant}
                disabled={
                  isDeleting ||
                  !ackChecked ||
                  confirmTenantId.trim().toLowerCase() !==
                    String(tenant.microsoftTenantId || tenant.id)
                      .trim()
                      .toLowerCase()
                }
                className="w-full sm:w-auto rounded-xl gap-2 font-semibold shadow-xs"
              >
                <Trash2 className="h-4 w-4" />
                {isDeleting
                  ? 'Deleting tenant...'
                  : 'Delete tenant from HawkView'}
              </Button>
            </div>
          </div>
        </CardContent>
        </Card>
      )}
    </div>
  )
}
