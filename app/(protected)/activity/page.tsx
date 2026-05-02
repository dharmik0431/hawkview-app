'use client'

import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import {
  ActivityFilters,
  type ActivityFiltersValue,
} from './components/activity-filters'
import { SignInLogsPage } from './components/signin-logs-page'
import { AuditLogsPage } from './components/audit-logs-page'
import type { ActivityTab, SignInEvent } from './data/types'

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

export default function ActivityPage() {
  const [tab, setTab] = React.useState<ActivityTab>('signins')

  const [loaded, setLoaded] = React.useState(false)
  const [tenants, setTenants] = React.useState<
    Array<{ id: string; name: string }>
  >([])
  const [tenantMocks, setTenantMocks] = React.useState<Record<string, any>>({})

  const [filters, setFilters] = React.useState<ActivityFiltersValue>({
    tenantId: '', // <— required now
    userUpn: 'all',
    datePreset: '7d',
    dateFrom: '',
    dateTo: '',
    search: '',
  })

  // Load tenant mocks client-side to avoid hydration mismatch
  React.useEffect(() => {
    let alive = true
    ;(async () => {
      const mod = await import('../tenants/[id]/mock/tenants')
      if (!alive) return
      setTenants(
        (mod.TENANTS ?? []).map((t: any) => ({ id: t.id, name: t.name }))
      )
      setTenantMocks(mod.TENANT_MOCKS ?? {})
      setLoaded(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  const selectedBundle = React.useMemo(() => {
    if (!filters.tenantId) return null
    return tenantMocks[filters.tenantId] ?? null
  }, [tenantMocks, filters.tenantId])

  // Build user dropdown options from selected tenant log data
  const userOptions = React.useMemo(() => {
    const signIns = selectedBundle?.signIns ?? []
    const map = new Map<string, string>() // upn -> displayName
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

  const signInRows: SignInEvent[] = React.useMemo(() => {
    if (!loaded) return []
    if (!selectedBundle) return [] // tenant required

    const all = (selectedBundle.signIns ?? []) as any[]
    const q = filters.search.trim().toLowerCase()

    return all
      .map((s: any) => {
        const createdAt =
          s.createdAt ?? s.ts ?? s.time ?? new Date().toISOString()
        const city = s.city ?? s.location?.city
        const country = s.country ?? s.location?.country
        const location =
          s.location ?? (city && country ? `${city}, ${country}` : undefined)

        return {
          id: s.id ?? `${createdAt}-${s.userPrincipalName ?? Math.random()}`,
          createdAt,
          userDisplayName: s.userDisplayName ?? s.user ?? 'Unknown',
          userPrincipalName:
            s.userPrincipalName ?? s.upn ?? 'unknown@tenant.com',
          appDisplayName: s.appDisplayName ?? s.app ?? 'Unknown',
          status: (s.status ?? s.result ?? 'Success') as 'Success' | 'Failure',
          conditionalAccess: (s.conditionalAccess ??
            s.condAccess ??
            'Not Applied') as 'Applied' | 'Not Applied',
          ipAddress: s.ipAddress ?? s.ip ?? undefined,
          location,

          // ✅ added fields for the drawer
          clientAppUsed: s.clientAppUsed ?? s.clientApp ?? undefined,
          device: s.device ?? s.deviceName ?? undefined,
          os: s.os ?? s.operatingSystem ?? undefined,
          userAgent: s.userAgent ?? undefined,
          tenantName: selectedBundle?.name ?? undefined,
        } as SignInEvent
      })
      .filter((r) =>
        inPresetRange(
          r.createdAt,
          filters.datePreset,
          filters.dateFrom,
          filters.dateTo
        )
      )
      .filter((r) => {
        if (
          filters.userUpn !== 'all' &&
          r.userPrincipalName !== filters.userUpn
        ) {
          return false
        }
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
      .sort((a, b) => parseISO(b.createdAt) - parseISO(a.createdAt))
  }, [loaded, selectedBundle, filters])

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
          Retention: 60 days
        </Badge>
      </div>

      {/* Note banner */}
      <div className="rounded-lg border bg-blue-50/50 px-4 py-3 text-sm text-blue-900">
        <span className="font-medium">Note:</span> Logs displayed here are
        ingested from source tenants. It may take{' '}
        <span className="font-medium">15–20 minutes</span> for new sign-in or
        audit events to appear in this dashboard.
      </div>

      {/* Filters */}
      <div className="rounded-lg border bg-background p-3">
        <ActivityFilters
          tenants={tenants}
          users={userOptions}
          value={filters}
          onChange={setFilters}
          onReset={() =>
            setFilters({
              tenantId: '',
              userUpn: 'all',
              datePreset: '7d',
              dateFrom: '',
              dateTo: '',
              search: '',
            })
          }
        />
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-6 border-b">
        <button
          className={[
            'px-1 pb-2 text-sm font-medium',
            tab === 'signins'
              ? 'text-blue-600 border-b-2 border-blue-600'
              : 'text-muted-foreground hover:text-foreground',
          ].join(' ')}
          onClick={() => setTab('signins')}
          disabled={!filters.tenantId}
          title={!filters.tenantId ? 'Select a tenant first' : undefined}
        >
          Sign-in logs
        </button>

        <button
          className={[
            'px-1 pb-2 text-sm font-medium',
            tab === 'audit'
              ? 'text-blue-600 border-b-2 border-blue-600'
              : 'text-muted-foreground hover:text-foreground',
            !filters.tenantId ? 'opacity-50 cursor-not-allowed' : '',
          ].join(' ')}
          onClick={() => filters.tenantId && setTab('audit')}
          disabled={!filters.tenantId}
          title={!filters.tenantId ? 'Select a tenant first' : undefined}
        >
          Audit logs
        </button>
      </div>

      {/* Default empty state until tenant selected */}
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
        <SignInLogsPage rows={signInRows} />
      ) : (
        <AuditLogsPage />
      )}
    </div>
  )
}
