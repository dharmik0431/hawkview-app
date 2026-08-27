'use client'

import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import {
  ActivityFilters,
  type ActivityFiltersValue,
} from './components/activity-filters'
import {
  type AdvancedFiltersState,
  type FilterOptions,
  initialAdvancedFilters,
} from './components/advanced-filter-panel'
import { SignInLogsPage } from './components/signin-logs-page'
import { AuditLogsPage } from './components/audit-logs-page'
import type { ActivityTab, AuditEvent, SignInEvent } from './data/types'
import {
  hasIncompleteActivityEvidence,
  normalizeAuditEvent,
  normalizeSignInEvent,
} from './data/normalize'
import { apiClient } from '@/lib/api/client'
import { triggerNotification } from '@/components/providers/notification-provider'
import { exportSignInsToCsv, exportAuditLogsToCsv } from './utils/csv-exporter'
import { LoadingState } from '@/components/common/loading-state'
import { ErrorState } from '@/components/common/error-state'
import { EmptyState } from '@/components/common/empty-state'
import { Building2 } from 'lucide-react'

function parseISO(iso?: string) {
  if (!iso) return 0
  const d = new Date(iso)
  const t = d.getTime()
  return Number.isFinite(t) ? t : 0
}

function nowUTC() {
  return Date.now()
}

function daysToMs(days: number) {
  return days * 24 * 60 * 60 * 1000
}

function inPresetRange(
  createdAt: string | undefined,
  preset: ActivityFiltersValue['datePreset'],
  from: string,
  to: string
) {
  const t = parseISO(createdAt)
  if (!t) {
    return preset !== 'custom' || (!from && !to)
  }

  if (preset === 'custom') {
    if (!from || !to) return true // if not set yet, don't block
    const start = new Date(from + 'T00:00:00Z').getTime()
    const end = new Date(to + 'T23:59:59Z').getTime()
    return t >= start && t <= end
  }

  const map: Record<string, number> = {
    '7d': 7,
    '30d': 30,
    '60d': 60,
    '90d': 90,
    '180d': 180,
  }

  const days = map[preset]
  const min = nowUTC() - daysToMs(days)
  return t >= min
}

function compareIPs(ipA?: string, ipB?: string): number {
  if (!ipA && !ipB) return 0
  if (!ipA) return 1
  if (!ipB) return -1
  const partsA = ipA.split('.').map(Number)
  const partsB = ipB.split('.').map(Number)
  if (
    partsA.length === 4 &&
    partsB.length === 4 &&
    partsA.every((n) => !isNaN(n)) &&
    partsB.every((n) => !isNaN(n))
  ) {
    for (let i = 0; i < 4; i++) {
      if (partsA[i] !== partsB[i]) return partsA[i] - partsB[i]
    }
    return 0
  }
  return ipA.localeCompare(ipB, undefined, { sensitivity: 'base' })
}

export default function ActivityPage() {
  const [tab, setTab] = React.useState<ActivityTab>('signins')

  const [directoryState, setDirectoryState] = React.useState<
    'loading' | 'ready' | 'error'
  >('loading')
  const [directoryReloadKey, setDirectoryReloadKey] = React.useState(0)
  const [bundleState, setBundleState] = React.useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle')
  const [bundleReloadKey, setBundleReloadKey] = React.useState(0)
  const [tenants, setTenants] = React.useState<
    Array<{ id: string; name: string }>
  >([])
  const [selectedBundle, setSelectedBundle] = React.useState<any>(null)

  const [filters, setFilters] = React.useState<ActivityFiltersValue>({
    tenantId: '',
    userUpn: 'all',
    datePreset: '7d',
    dateFrom: '',
    dateTo: '',
    search: '',
  })

  const [advancedFilters, setAdvancedFilters] =
    React.useState<AdvancedFiltersState>(initialAdvancedFilters)

  // Sorting state
  const [signInSortField, setSignInSortField] =
    React.useState<keyof SignInEvent>('createdAt')
  const [signInSortOrder, setSignInSortOrder] = React.useState<'asc' | 'desc'>(
    'desc'
  )

  const [auditSortField, setAuditSortField] =
    React.useState<keyof AuditEvent>('createdAt')
  const [auditSortOrder, setAuditSortOrder] = React.useState<'asc' | 'desc'>(
    'desc'
  )

  const [isExporting, setIsExporting] = React.useState(false)

  // Load tenant directory
  React.useEffect(() => {
    let alive = true
    const controller = new AbortController()
    setDirectoryState('loading')
    apiClient
      .get<any>('/api/tenants', { signal: controller.signal })
      .then((data) => {
        if (!alive) return
        setTenants(
          (data.tenants ?? []).map((t: any) => ({ id: t.id, name: t.name }))
        )
        setDirectoryState('ready')
      })
      .catch(() => {
        if (alive) setDirectoryState('error')
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [directoryReloadKey])

  // Load tenant detail bundle
  React.useEffect(() => {
    let alive = true
    const controller = new AbortController()
    if (!filters.tenantId) {
      setSelectedBundle(null)
      setBundleState('idle')
      return () => {
        alive = false
        controller.abort()
      }
    }

    setSelectedBundle(null)
    setBundleState('loading')
    apiClient
      .get<any>(`/api/tenants/${encodeURIComponent(filters.tenantId)}`, {
        signal: controller.signal,
      })
      .then((data) => {
        if (!alive) return
        setSelectedBundle(data.bundle ?? null)
        setBundleState(data.bundle ? 'ready' : 'error')
      })
      .catch(() => {
        if (alive) {
          setSelectedBundle(null)
          setBundleState('error')
        }
      })

    return () => {
      alive = false
      controller.abort()
    }
  }, [bundleReloadKey, filters.tenantId])

  // Build user dropdown options
  const userOptions = React.useMemo(() => {
    const signIns = selectedBundle?.signIns ?? []
    const map = new Map<string, string>()
    for (const s of signIns) {
      const upn = s.userPrincipalName ?? s.upn
      if (!upn) continue
      const name = s.userDisplayName ?? s.user ?? upn
      if (!map.has(upn)) map.set(upn, name)
    }
    return Array.from(map.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([upn, name]) => ({ upn, label: `${name} (${upn})` }))
  }, [selectedBundle])

  // Map raw sign-in events
  const rawSignInEvents = React.useMemo<SignInEvent[]>(() => {
    if (bundleState !== 'ready' || !selectedBundle) return []
    const all = (selectedBundle.signIns ?? []) as any[]
    const tenantId = selectedBundle?.tenant?.id ?? selectedBundle?.id
    const tenantName = selectedBundle?.tenant?.name ?? selectedBundle?.name

    return all.map((event, index) =>
      normalizeSignInEvent(event, { tenantId, tenantName, index }),
    )
  }, [bundleState, selectedBundle])

  // Map raw audit events
  const rawAuditEvents = React.useMemo<AuditEvent[]>(() => {
    if (bundleState !== 'ready' || !selectedBundle) return []
    const all = (selectedBundle.auditLogs ?? []) as any[]
    const tenantId = selectedBundle?.tenant?.id ?? selectedBundle?.id
    const tenantName = selectedBundle?.tenant?.name ?? selectedBundle?.name

    return all.map((event, index) =>
      normalizeAuditEvent(event, { tenantId, tenantName, index }),
    )
  }, [bundleState, selectedBundle])

  // Dynamically extract available filter options from real event data
  const filterOptions = React.useMemo<FilterOptions>(() => {
    // Helper to get sorted unique non-empty values
    const uniqueVals = (arr: (string | undefined | null)[]) => {
      const set = new Set<string>()
      for (const v of arr) {
        if (v && v.trim() && v !== '—' && v !== 'Not available') {
          set.add(v.trim())
        }
      }
      return Array.from(set).sort((a, b) => a.localeCompare(b))
    }

    // Sign-in options
    const rawStatuses = uniqueVals(rawSignInEvents.map((s) => s.status))
    const statuses = rawStatuses

    const rawCA = uniqueVals(rawSignInEvents.map((s) => s.conditionalAccess))
    const caResults = rawCA

    const apps = uniqueVals(rawSignInEvents.map((s) => s.appDisplayName))
    const locations = uniqueVals(rawSignInEvents.map((s) => s.location))
    const ips = uniqueVals(rawSignInEvents.map((s) => s.ipAddress))
    const clientApps = uniqueVals(rawSignInEvents.map((s) => s.clientAppUsed))
    const osList = uniqueVals(rawSignInEvents.map((s) => s.os))
    const riskLevels = uniqueVals(rawSignInEvents.map((s) => s.riskLevel))

    // Audit options
    const rawResults = uniqueVals(rawAuditEvents.map((a) => a.result))
    const results = rawResults

    const activities = uniqueVals(rawAuditEvents.map((a) => a.activity))
    const categories = uniqueVals(rawAuditEvents.map((a) => a.category))
    const services = uniqueVals(rawAuditEvents.map((a) => a.service))
    const actors = uniqueVals(rawAuditEvents.map((a) => a.actor))
    const targetTypes = uniqueVals(rawAuditEvents.map((a) => a.targetType))

    return {
      signInOptions: {
        statuses,
        caResults,
        apps,
        locations,
        ips,
        clientApps,
        osList,
        riskLevels,
      },
      auditOptions: {
        results,
        activities,
        categories,
        services,
        actors,
        targetTypes,
      },
    }
  }, [rawSignInEvents, rawAuditEvents])

  // Processed and sorted Sign-in rows
  const signInRows = React.useMemo<SignInEvent[]>(() => {
    if (bundleState !== 'ready' || !selectedBundle) return []
    const q = filters.search.trim().toLowerCase()
    const adv = advancedFilters

    const filtered = rawSignInEvents.filter((r) => {
      // Date range filter
      if (
        !inPresetRange(
          r.createdAt,
          filters.datePreset,
          filters.dateFrom,
          filters.dateTo
        )
      ) {
        return false
      }

      // User filter
      if (
        filters.userUpn !== 'all' &&
        r.userPrincipalName !== filters.userUpn
      ) {
        return false
      }

      // Advanced filters
      if (adv.signInStatus !== 'all' && r.status !== adv.signInStatus) {
        return false
      }
      if (
        adv.signInCA !== 'all' &&
        (r.conditionalAccess ?? 'Not Applied') !== adv.signInCA
      ) {
        return false
      }
      if (adv.signInApp !== 'all' && r.appDisplayName !== adv.signInApp) {
        return false
      }
      if (adv.signInLocation !== 'all' && r.location !== adv.signInLocation) {
        return false
      }
      if (adv.signInIP !== 'all' && r.ipAddress !== adv.signInIP) {
        return false
      }
      if (
        adv.signInClientApp !== 'all' &&
        r.clientAppUsed !== adv.signInClientApp
      ) {
        return false
      }
      if (adv.signInOS !== 'all' && r.os !== adv.signInOS) {
        return false
      }
      if (
        adv.signInRiskLevel !== 'all' &&
        r.riskLevel !== adv.signInRiskLevel
      ) {
        return false
      }

      // Search query
      if (!q) return true
      const hay = [
        r.userDisplayName,
        r.userPrincipalName,
        r.appDisplayName,
        r.status,
        r.conditionalAccess ?? '',
        r.ipAddress ?? '',
        r.location ?? '',
        r.clientAppUsed ?? '',
        r.device ?? '',
        r.os ?? '',
        r.userAgent ?? '',
      ]
        .join(' ')
        .toLowerCase()

      return hay.includes(q)
    })

    // Sort
    return filtered.sort((a, b) => {
      let valA: any = a[signInSortField]
      let valB: any = b[signInSortField]

      if (signInSortField === 'userDisplayName') {
        valA = `${a.userDisplayName} ${a.userPrincipalName}`
        valB = `${b.userDisplayName} ${b.userPrincipalName}`
      }

      const isMissingA =
        valA === undefined || valA === null || valA === '' || valA === '—'
      const isMissingB =
        valB === undefined || valB === null || valB === '' || valB === '—'

      if (isMissingA && isMissingB) return 0
      if (isMissingA) return 1
      if (isMissingB) return -1

      let cmp = 0
      if (signInSortField === 'ipAddress') {
        cmp = compareIPs(String(valA), String(valB))
      } else if (signInSortField === 'createdAt') {
        const tA = new Date(String(valA)).getTime() || 0
        const tB = new Date(String(valB)).getTime() || 0
        cmp = tA - tB
      } else {
        cmp = String(valA).localeCompare(String(valB), undefined, {
          sensitivity: 'base',
          numeric: true,
        })
      }

      return signInSortOrder === 'asc' ? cmp : -cmp
    })
  }, [
    bundleState,
    selectedBundle,
    rawSignInEvents,
    filters,
    advancedFilters,
    signInSortField,
    signInSortOrder,
  ])

  // Processed and sorted Audit rows
  const auditRows = React.useMemo<AuditEvent[]>(() => {
    if (bundleState !== 'ready' || !selectedBundle) return []
    const q = filters.search.trim().toLowerCase()
    const adv = advancedFilters

    const filtered = rawAuditEvents.filter((event) => {
      // Date range filter
      if (
        !inPresetRange(
          event.createdAt,
          filters.datePreset,
          filters.dateFrom,
          filters.dateTo
        )
      ) {
        return false
      }

      // Advanced filters
      if (adv.auditResult !== 'all' && event.result !== adv.auditResult) {
        return false
      }
      if (adv.auditActivity !== 'all' && event.activity !== adv.auditActivity) {
        return false
      }
      if (adv.auditCategory !== 'all' && event.category !== adv.auditCategory) {
        return false
      }
      if (adv.auditService !== 'all' && event.service !== adv.auditService) {
        return false
      }
      if (
        adv.auditActor !== 'all' &&
        event.actor !== adv.auditActor &&
        event.actorPrincipalName !== adv.auditActor
      ) {
        return false
      }
      if (
        adv.auditTargetType !== 'all' &&
        event.targetType !== adv.auditTargetType
      ) {
        return false
      }

      // Search query
      if (!q) return true
      return [
        event.activity,
        event.actor,
        event.actorPrincipalName,
        event.target,
        event.category,
        event.result,
        event.service,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q)
    })

    // Sort
    return filtered.sort((a, b) => {
      let valA: any = a[auditSortField]
      let valB: any = b[auditSortField]

      if (auditSortField === 'actor') {
        valA = `${a.actor || ''} ${a.actorPrincipalName || ''}`
        valB = `${b.actor || ''} ${b.actorPrincipalName || ''}`
      }

      const isMissingA =
        valA === undefined || valA === null || valA === '' || valA === '—'
      const isMissingB =
        valB === undefined || valB === null || valB === '' || valB === '—'

      if (isMissingA && isMissingB) return 0
      if (isMissingA) return 1
      if (isMissingB) return -1

      let cmp = 0
      if (auditSortField === 'createdAt') {
        const tA = new Date(String(valA)).getTime() || 0
        const tB = new Date(String(valB)).getTime() || 0
        cmp = tA - tB
      } else {
        cmp = String(valA).localeCompare(String(valB), undefined, {
          sensitivity: 'base',
          numeric: true,
        })
      }

      return auditSortOrder === 'asc' ? cmp : -cmp
    })
  }, [
    bundleState,
    selectedBundle,
    rawAuditEvents,
    filters,
    advancedFilters,
    auditSortField,
    auditSortOrder,
  ])

  // Get current tenant name for export
  const selectedTenantName = React.useMemo(() => {
    if (!filters.tenantId) return ''
    const found = tenants.find((t) => t.id === filters.tenantId)
    return (
      found?.name || selectedBundle?.tenant?.name || selectedBundle?.name || ''
    )
  }, [filters.tenantId, tenants, selectedBundle])

  // Handle Export CSV
  function handleExportCsv() {
    setIsExporting(true)
    try {
      let ok = false
      if (tab === 'signins') {
        ok = exportSignInsToCsv(signInRows, selectedTenantName)
      } else {
        ok = exportAuditLogsToCsv(auditRows, selectedTenantName)
      }

      if (ok) {
        triggerNotification({
          title: 'CSV export downloaded.',
          description: `${
            tab === 'signins' ? signInRows.length : auditRows.length
          } events exported to CSV file.`,
          category: 'success',
        })
      } else {
        triggerNotification({
          title: 'CSV export could not be created.',
          description: 'An error occurred while generating the CSV file.',
          category: 'error',
        })
      }
    } catch (err) {
      console.error(err)
      triggerNotification({
        title: 'CSV export could not be created.',
        description: 'An unexpected error occurred.',
        category: 'error',
      })
    } finally {
      setIsExporting(false)
    }
  }

  // Reset handler
  function handleReset() {
    setFilters({
      tenantId: '',
      userUpn: 'all',
      datePreset: '7d',
      dateFrom: '',
      dateTo: '',
      search: '',
    })
    setAdvancedFilters(initialAdvancedFilters)
    setSignInSortField('createdAt')
    setSignInSortOrder('desc')
    setAuditSortField('createdAt')
    setAuditSortOrder('desc')
  }

  function handleSignInSort(field: keyof SignInEvent) {
    if (signInSortField === field) {
      setSignInSortOrder(signInSortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setSignInSortField(field)
      setSignInSortOrder('asc')
    }
  }

  function handleAuditSort(field: keyof AuditEvent) {
    if (auditSortField === field) {
      setAuditSortOrder(auditSortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setAuditSortField(field)
      setAuditSortOrder('asc')
    }
  }

  const activeMatchingCount =
    tab === 'signins' ? signInRows.length : auditRows.length
  const signInCountLabel =
    bundleState === 'ready' ? String(signInRows.length) : 'Not reported'
  const auditCountLabel =
    bundleState === 'ready' ? String(auditRows.length) : 'Not reported'
  const activeSyncState =
    tab === 'signins'
      ? selectedBundle?.sync?.signIns
      : selectedBundle?.sync?.auditLogs
  const activeSyncStatus = String(activeSyncState?.status ?? '').toLowerCase()
  const activityEvidencePartial = hasIncompleteActivityEvidence(
    rawSignInEvents,
    rawAuditEvents,
  )

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-2xl font-semibold">Activity Logs</div>
          <div className="text-sm text-muted-foreground">
            Unified visibility into Sign-in and Audit events across managed
            tenants.
          </div>
        </div>

        <Badge variant="secondary" className="h-8 px-3 rounded-full">
          Retention: Not reported
        </Badge>
      </div>

      {/* Note banner */}
      <div className="rounded-lg border bg-blue-50/50 dark:bg-blue-950/30 px-4 py-3 text-sm text-blue-900 dark:text-blue-200 border-blue-200/60 dark:border-blue-900/50">
        <span className="font-medium">Collection note:</span> Logs are reported
        by Microsoft for the selected tenant. Availability and refresh timing
        vary by workload, permissions, and Microsoft retention policy.
      </div>

      {/* Filters Toolbar */}
      <div className="rounded-lg border bg-background p-3">
        <ActivityFilters
          tenants={tenants}
          users={userOptions}
          value={filters}
          advancedValue={advancedFilters}
          tab={tab}
          onChange={setFilters}
          onAdvancedChange={setAdvancedFilters}
          onReset={handleReset}
          options={filterOptions}
          matchingCount={activeMatchingCount}
          onExportCsv={handleExportCsv}
          isExporting={isExporting}
        />
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-6 border-b" role="tablist" aria-label="Activity log type">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'signins'}
          className={[
            'px-1 pb-2 text-sm font-medium transition-colors',
            tab === 'signins'
              ? 'text-blue-600 border-b-2 border-blue-600 font-semibold'
              : 'text-muted-foreground hover:text-foreground',
            !filters.tenantId ? 'opacity-50 cursor-not-allowed' : '',
          ].join(' ')}
          onClick={() => filters.tenantId && setTab('signins')}
          disabled={!filters.tenantId}
          title={!filters.tenantId ? 'Select a tenant first' : undefined}
        >
          Sign-in logs ({filters.tenantId ? signInCountLabel : 'Not reported'})
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={tab === 'audit'}
          className={[
            'px-1 pb-2 text-sm font-medium transition-colors',
            tab === 'audit'
              ? 'text-blue-600 border-b-2 border-blue-600 font-semibold'
              : 'text-muted-foreground hover:text-foreground',
            !filters.tenantId ? 'opacity-50 cursor-not-allowed' : '',
          ].join(' ')}
          onClick={() => filters.tenantId && setTab('audit')}
          disabled={!filters.tenantId}
          title={!filters.tenantId ? 'Select a tenant first' : undefined}
        >
          Audit logs ({filters.tenantId ? auditCountLabel : 'Not reported'})
        </button>
      </div>

      {/* Main Content Area */}
      {filters.tenantId && activeSyncStatus === 'failed' && (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="font-semibold">
            {tab === 'signins' ? 'Sign-in' : 'Directory audit'} log sync failed
          </div>
          <div className="mt-1 text-xs leading-5">
            HawkView could not refresh this dataset. Previously retained events,
            when available, remain visible. Review the tenant connection and
            permissions before retrying.
          </div>
        </div>
      )}
      {filters.tenantId &&
      ['running', 'pending', 'in_progress', 'syncing'].includes(activeSyncStatus) ? (
        <div
          className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100"
          role="status"
          aria-live="polite"
        >
          <div className="font-semibold">Sync in progress</div>
          <div className="mt-1 text-xs leading-5">
            HawkView is collecting the latest {tab === 'signins' ? 'sign-in' : 'directory audit'} events.
            Current results may be incomplete until this attempt finishes.
          </div>
        </div>
      ) : null}
      {filters.tenantId &&
      bundleState === 'ready' &&
      (activityEvidencePartial || ['partial', 'stale'].includes(activeSyncStatus)) ? (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
          role="status"
        >
          <div className="font-semibold">
            {activeSyncStatus === 'stale' ? 'Stale log evidence' : 'Partial log evidence'}
          </div>
          <div className="mt-1 text-xs leading-5">
            Some event fields or collection evidence were not reported. HawkView
            preserves those values as “Not reported” and does not infer success,
            identity, or timestamps.
          </div>
        </div>
      ) : null}
      {directoryState === 'loading' ? (
        <div className="rounded-lg border bg-background">
          <LoadingState message="Loading tenant directory…" />
        </div>
      ) : directoryState === 'error' ? (
        <div className="rounded-lg border bg-background">
          <ErrorState
            message="HawkView could not load the tenant directory. No activity status is being inferred."
            onRetry={() => setDirectoryReloadKey((value) => value + 1)}
          />
        </div>
      ) : tenants.length === 0 ? (
        <div className="rounded-lg border bg-background">
          <EmptyState
            icon={Building2}
            title="No managed tenants"
            description="Onboard a tenant before reviewing sign-in and directory audit evidence."
            actionLabel="Open tenant directory"
            href="/tenants"
          />
        </div>
      ) : !filters.tenantId ? (
        <div className="rounded-lg border bg-background p-10 text-center">
          <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-muted/30 flex items-center justify-center">
            <div className="h-5 w-5 rounded bg-muted" />
          </div>
          <div className="text-base font-semibold">Select a Tenant</div>
          <div className="mt-1 text-sm text-muted-foreground">
            Choose a tenant from the dropdown above to view their specific audit
            and sign-in logs.
          </div>
        </div>
      ) : bundleState === 'loading' ? (
        <div className="rounded-lg border bg-background">
          <LoadingState message="Loading reported activity evidence…" />
        </div>
      ) : bundleState === 'error' ? (
        <div className="rounded-lg border bg-background">
          <ErrorState
            message="HawkView could not load activity evidence for this tenant. No success state is being shown."
            onRetry={() => setBundleReloadKey((value) => value + 1)}
          />
        </div>
      ) : tab === 'signins' ? (
        <SignInLogsPage
          rows={signInRows}
          sortField={signInSortField}
          sortOrder={signInSortOrder}
          onSort={handleSignInSort}
        />
      ) : (
        <AuditLogsPage
          rows={auditRows}
          sortField={auditSortField}
          sortOrder={auditSortOrder}
          onSort={handleAuditSort}
        />
      )}
    </div>
  )
}
