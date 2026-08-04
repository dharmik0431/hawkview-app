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
import { apiClient } from '@/lib/api/client'
import { triggerNotification } from '@/components/providers/notification-provider'
import { exportSignInsToCsv, exportAuditLogsToCsv } from './utils/csv-exporter'

function parseISO(iso: string) {
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
  createdAt: string,
  preset: ActivityFiltersValue['datePreset'],
  from: string,
  to: string
) {
  const t = parseISO(createdAt)
  if (!t) return false

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

  const [loaded, setLoaded] = React.useState(false)
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
    apiClient
      .get<any>('/api/tenants')
      .then((data) => {
        if (!alive) return
        setTenants(
          (data.tenants ?? []).map((t: any) => ({ id: t.id, name: t.name }))
        )
        setLoaded(true)
      })
      .catch(() => {
        if (alive) setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [])

  // Load tenant detail bundle
  React.useEffect(() => {
    let alive = true
    if (!filters.tenantId) {
      setSelectedBundle(null)
      return () => {
        alive = false
      }
    }

    apiClient
      .get<any>(`/api/tenants/${encodeURIComponent(filters.tenantId)}`)
      .then((data) => {
        if (!alive) return
        setSelectedBundle(data.bundle ?? null)
      })
      .catch(() => {
        if (alive) setSelectedBundle(null)
      })

    return () => {
      if (!alive) return
      alive = false
    }
  }, [filters.tenantId])

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
    if (!loaded || !selectedBundle) return []
    const all = (selectedBundle.signIns ?? []) as any[]

    return all.map((s: any) => {
      const createdAt =
        s.createdAt ?? s.ts ?? s.time ?? new Date().toISOString()
      const city = s.city ?? s.location?.city
      const country = s.country ?? s.location?.country
      const location =
        s.location ?? (city && country ? `${city}, ${country}` : undefined)

      const statusRaw = String(s.status ?? s.result ?? 'Success').toLowerCase()
      const isSuccess =
        statusRaw === 'success' || statusRaw === 'ok' || statusRaw === '0'

      const caRaw = String(
        s.conditionalAccess ?? s.condAccess ?? s.appliedConditionalAccess ?? ''
      ).toLowerCase()
      const isCaApplied =
        ['success', 'failure', 'applied', 'true'].includes(caRaw) ||
        Boolean(s.appliedConditionalAccessPolicies?.length)

      return {
        id: String(
          s.id ?? `${createdAt}-${s.userPrincipalName ?? Math.random()}`
        ),
        createdAt,
        userDisplayName:
          s.userDisplayName ?? s.user ?? s.displayName ?? 'Unknown',
        userPrincipalName:
          s.userPrincipalName ??
          s.upn ??
          s.userPrincipal ??
          'unknown@tenant.com',
        userId: s.userId ?? s.id ?? undefined,

        appDisplayName: s.appDisplayName ?? s.app ?? 'Unknown',
        appId: s.appId ?? s.appIdGuid ?? undefined,

        status: isSuccess ? 'Success' : 'Failure',
        failureReason:
          s.failureReason ?? s.errorDetail ?? s.statusReason ?? undefined,
        errorCode: s.errorCode
          ? String(s.errorCode)
          : s.errorNumber
            ? String(s.errorNumber)
            : undefined,
        additionalDetails: s.additionalDetails ?? undefined,

        conditionalAccess: isCaApplied ? 'Applied' : 'Not Applied',
        appliedCaPolicies: Array.isArray(s.appliedConditionalAccessPolicies)
          ? s.appliedConditionalAccessPolicies.map((p: any) =>
              typeof p === 'string' ? p : (p?.displayName ?? p?.name)
            )
          : undefined,
        authMethod: s.authMethod ?? s.authenticationRequirement ?? undefined,

        ipAddress: s.ipAddress ?? s.ip ?? undefined,
        location,
        country,
        city,

        clientAppUsed: s.clientAppUsed ?? s.client ?? s.clientApp ?? undefined,
        device:
          s.device ?? s.deviceName ?? s.deviceDetail?.displayName ?? undefined,
        os:
          s.os ??
          s.operatingSystem ??
          s.deviceDetail?.operatingSystem ??
          undefined,
        browser: s.browser ?? s.deviceDetail?.browser ?? undefined,
        managedState:
          s.managedState ??
          (s.deviceDetail?.isCompliant
            ? 'Compliant'
            : s.deviceDetail?.isManaged
              ? 'Managed'
              : undefined),
        userAgent: s.userAgent ?? undefined,
        tenantName:
          selectedBundle?.tenant?.name ?? selectedBundle?.name ?? undefined,
        tenantId: selectedBundle?.tenant?.id ?? selectedBundle?.id ?? undefined,
        correlationId: s.correlationId ?? undefined,
        requestId: s.requestId ?? undefined,
        riskLevel: s.riskLevel ?? s.riskState ?? s.risk ?? undefined,
        raw: s,
      } as SignInEvent
    })
  }, [loaded, selectedBundle])

  // Map raw audit events
  const rawAuditEvents = React.useMemo<AuditEvent[]>(() => {
    if (!loaded || !selectedBundle) return []
    const all = (selectedBundle.auditLogs ?? []) as any[]

    return all.map((event: any) => {
      const initiatedBy = event.initiatedBy ?? {}
      const actorName =
        initiatedBy?.user?.displayName ??
        event.actorDisplayName ??
        event.actor ??
        event.user ??
        initiatedBy?.app?.displayName
      const actorUpn =
        initiatedBy?.user?.userPrincipalName ??
        initiatedBy?.app?.servicePrincipalName ??
        (typeof event.actor === 'string' && event.actor.includes('@')
          ? event.actor
          : undefined)
      const actorType = initiatedBy?.user
        ? 'User'
        : initiatedBy?.app
          ? 'Application'
          : (event.actorType ?? 'System')
      const actorId =
        initiatedBy?.user?.id ??
        initiatedBy?.app?.id ??
        event.actorId ??
        undefined

      const targets = Array.isArray(event.targetResources)
        ? event.targetResources
        : []
      const primaryTarget = targets[0]
      const targetName =
        targets.length > 0
          ? targets
              .map(
                (target: any) =>
                  target?.displayName ?? target?.userPrincipalName ?? target?.id
              )
              .filter(Boolean)
              .join(', ')
          : (event.target ?? undefined)

      return {
        id: String(event.id ?? Math.random()),
        createdAt:
          event.createdAt ?? event.time ?? event.ts ?? new Date().toISOString(),
        activity:
          event.activity ??
          event.activityDisplayName ??
          event.action ??
          'Directory activity',
        category: event.category ?? undefined,
        operationType: event.operationType ?? undefined,
        result: event.result ?? event.status ?? 'Success',
        resultReason: event.resultReason ?? event.statusReason ?? undefined,
        correlationId: event.correlationId ?? undefined,
        service: event.service ?? event.loggedByService ?? undefined,
        actor: actorName ?? actorUpn ?? 'System',
        actorPrincipalName: actorUpn,
        actorType,
        actorId,
        target: targetName,
        targetType:
          primaryTarget?.type ?? primaryTarget?.groupType ?? undefined,
        targetId: primaryTarget?.id ?? undefined,
        targetResources: targets,
        modifiedProperties: Array.isArray(primaryTarget?.modifiedProperties)
          ? primaryTarget.modifiedProperties
          : Array.isArray(event.modifiedProperties)
            ? event.modifiedProperties
            : undefined,
        tenantName:
          selectedBundle?.tenant?.name ?? selectedBundle?.name ?? undefined,
        tenantId: selectedBundle?.tenant?.id ?? selectedBundle?.id ?? undefined,
        raw: event,
      } as AuditEvent
    })
  }, [loaded, selectedBundle])

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
    const statuses =
      rawStatuses.length > 0 ? rawStatuses : ['Success', 'Failure']

    const rawCA = uniqueVals(rawSignInEvents.map((s) => s.conditionalAccess))
    const caResults = rawCA.length > 0 ? rawCA : ['Applied', 'Not Applied']

    const apps = uniqueVals(rawSignInEvents.map((s) => s.appDisplayName))
    const locations = uniqueVals(rawSignInEvents.map((s) => s.location))
    const ips = uniqueVals(rawSignInEvents.map((s) => s.ipAddress))
    const clientApps = uniqueVals(rawSignInEvents.map((s) => s.clientAppUsed))
    const osList = uniqueVals(rawSignInEvents.map((s) => s.os))
    const riskLevels = uniqueVals(rawSignInEvents.map((s) => s.riskLevel))

    // Audit options
    const rawResults = uniqueVals(rawAuditEvents.map((a) => a.result))
    const results = rawResults.length > 0 ? rawResults : ['Success', 'Failure']

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
    if (!loaded || !selectedBundle) return []
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
    loaded,
    selectedBundle,
    rawSignInEvents,
    filters,
    advancedFilters,
    signInSortField,
    signInSortOrder,
  ])

  // Processed and sorted Audit rows
  const auditRows = React.useMemo<AuditEvent[]>(() => {
    if (!loaded || !selectedBundle) return []
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
    loaded,
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

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-2xl font-semibold">Audit Logs</div>
          <div className="text-sm text-muted-foreground">
            Unified visibility into Sign-in and Audit events across managed
            tenants.
          </div>
        </div>

        <Badge variant="secondary" className="h-8 px-3 rounded-full">
          Retention: 6 months
        </Badge>
      </div>

      {/* Note banner */}
      <div className="rounded-lg border bg-blue-50/50 dark:bg-blue-950/30 px-4 py-3 text-sm text-blue-900 dark:text-blue-200 border-blue-200/60 dark:border-blue-900/50">
        <span className="font-medium">Note:</span> Logs displayed here are
        ingested from source tenants. It may take{' '}
        <span className="font-medium">15–20 minutes</span> for new sign-in or
        audit events to appear in this dashboard.
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
      <div className="flex items-center gap-6 border-b">
        <button
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
          Sign-in logs ({filters.tenantId ? signInRows.length : 0})
        </button>

        <button
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
          Audit logs ({filters.tenantId ? auditRows.length : 0})
        </button>
      </div>

      {/* Main Content Area */}
      {!loaded ? (
        <div className="rounded-lg border bg-background p-6 text-sm text-muted-foreground">
          Loading…
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
