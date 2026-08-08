'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import {
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  Search,
  RotateCcw,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'

import { useTenants } from '@/lib/api/hooks'
import { AlertDetailsModal } from '@/components/dashboard/alert-details-modal'

export type Severity = 'critical' | 'high' | 'medium'
type TabKey = 'queue' | 'matrix'

type AttentionItem = {
  key: string
  label: string
  severity: Severity
  why?: string
  detectedAt?: string
  actionLabel?: string
  actionUrl?: string
}

function topAttention(items: AttentionItem[]) {
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2 }
  return [...items]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .slice(0, 2)
}

function parseTime(v?: string) {
  if (!v) return 0
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : 0
}

function formatAge(iso?: string) {
  const t = parseTime(iso)
  if (!t) {
    return {
      display: '—',
      accessible: 'Detection time not provided',
    }
  }
  const diff = Date.now() - t
  const mins = Math.max(0, Math.round(diff / 60000))
  if (mins < 1) {
    return {
      display: '<1m',
      accessible: 'Unresolved for less than 1 minute.',
    }
  }
  if (mins < 60) {
    return {
      display: `${mins}m`,
      accessible: `Unresolved for ${mins} minute${mins === 1 ? '' : 's'}.`,
    }
  }
  const hrs = Math.round(mins / 60)
  if (hrs < 24) {
    return {
      display: `${hrs}h`,
      accessible: `Unresolved for ${hrs} hour${hrs === 1 ? '' : 's'}.`,
    }
  }
  const days = Math.round(hrs / 24)
  return {
    display: `${days}d`,
    accessible: `Unresolved for ${days} day${days === 1 ? '' : 's'}.`,
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function severityStripe(sev: Severity) {
  if (sev === 'critical') return 'bg-red-500'
  if (sev === 'high') return 'bg-amber-500'
  return 'bg-blue-500'
}

function SeverityBadge({ sev }: { sev: Severity }) {
  if (sev === 'critical') {
    return (
      <div className="flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-400">
        <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0" />
        <span>Critical</span>
      </div>
    )
  }
  if (sev === 'high') {
    return (
      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-400">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
        <span>High</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-400">
      <ShieldCheck className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
      <span>Medium</span>
    </div>
  )
}

function getKeyResult(q: QueueItem): string {
  const item = q.item
  const key = (item.key ?? '').toLowerCase()
  const label = (item.label ?? '').toLowerCase()
  const why = item.why ?? ''

  // 1. MFA Coverage
  if (key.includes('mfa') || label.includes('mfa')) {
    const match = item.label.match(/(\d+%)|\((\d+%)\)/) || why.match(/(\d+%)|\((\d+%)\)/)
    const pct = match ? (match[1] || match[2]) : (q.metricValue && q.metricValue !== '—' ? q.metricValue : null)
    return `MFA coverage: ${pct ?? 'Not provided'}`
  }

  // 2. Missing Permissions
  if (key.includes('permission') || label.includes('permission') || why.toLowerCase().includes('missing:')) {
    const match = why.match(/missing:\s*([^.]+)/i)
    if (match && match[1]) {
      return `Missing permission: ${match[1].trim()}`
    }
    return 'Missing permissions'
  }

  // 3. Changed application / Audit findings
  if (label.includes('application') || why.toLowerCase().includes('application') || label.includes('app registration')) {
    const match = why.match(/affected:\s*([^.]+)/i) || why.match(/application\s*:?\s*([^.]+)/i)
    if (match && match[1]) {
      return `Changed application: ${match[1].trim()}`
    }
    if (why.includes('HawkView Tenant Connector') || label.includes('HawkView Tenant Connector')) {
      return 'Changed application: HawkView Tenant Connector'
    }
    return 'Changed application'
  }

  // 4. Affected target in why text
  if (why.toLowerCase().includes('affected:')) {
    const match = why.match(/affected:\s*([^.]+)/i)
    if (match && match[1]) {
      return `Affected: ${match[1].trim()}`
    }
  }

  // 5. Risky Identities
  if (key.includes('risky') || label.includes('risky')) {
    if (q.metricValue && q.metricValue !== '—') {
      return `Risky users: ${q.metricValue}`
    }
    return 'Risky users: 1'
  }

  // 6. Connection / Auth required
  if (key.includes('connection') || label.includes('connection') || label.includes('reconnect')) {
    return 'Connection: Disconnected'
  }
  if (key.includes('authorization') || label.includes('authorization')) {
    return 'Authorization: Required'
  }

  // 7. Sync issue
  if (key.includes('sync') || label.includes('sync')) {
    return 'Sync status: Failed'
  }

  if (why && why.length > 0 && why.length <= 45 && !why.includes('http')) {
    return why
  }

  return 'Not provided'
}

function actionLabel(sev: Severity) {
  if (sev === 'critical') return 'Investigate'
  if (sev === 'high') return 'Review'
  return 'View'
}

function providerMark(provider: 'microsoft' | 'google') {
  if (provider === 'microsoft') {
    return (
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 border">
        <span className="grid grid-cols-2 gap-[2px]">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[#F25022]" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[#7FBA00]" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[#00A4EF]" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[#FFB900]" />
        </span>
      </span>
    )
  }

  return (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 border">
      <span className="h-3.5 w-3.5 rounded-full border-2 border-blue-500 border-t-red-500 border-r-yellow-500 border-b-green-500" />
    </span>
  )
}

function ScrollPanel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={[
        'h-[520px] overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900',
        'pr-2',
        '[&::-webkit-scrollbar]:w-2',
        '[&::-webkit-scrollbar-thumb]:rounded-full',
        '[&::-webkit-scrollbar-thumb]:bg-slate-300/70 dark:[&::-webkit-scrollbar-thumb]:bg-slate-700/70',
        'hover:[&::-webkit-scrollbar-thumb]:bg-slate-400/80 dark:hover:[&::-webkit-scrollbar-thumb]:bg-slate-600/80',
        '[&::-webkit-scrollbar-track]:bg-transparent',
      ].join(' ')}
    >
      <div className="p-3">{children}</div>
    </div>
  )
}

type TenantRow = {
  id: string
  name: string
  domain: string
  provider: 'microsoft' | 'google'
  healthScore: number
  attention: AttentionItem[]
  top: AttentionItem[]
  topSeverity?: Severity
  lastCriticalAt?: string
  mfaCoverage: number
  identityDetected: number
}

function buildTenants(source: any[]): TenantRow[] {
  return (source ?? []).map((t: any) => {
    const attention = (t.attention ?? []) as AttentionItem[]
    const top = topAttention(attention)

    const topSeverity =
      top.find((x) => x.severity === 'critical')?.severity ??
      top.find((x) => x.severity === 'high')?.severity ??
      top.find((x) => x.severity === 'medium')?.severity ??
      undefined

    const lastCriticalAt = attention
      .filter((a) => a.severity === 'critical' && a.detectedAt)
      .map((a) => a.detectedAt as string)
      .sort((a, b) => parseTime(b) - parseTime(a))[0]

    const healthScore = clamp(Number(t.healthScore ?? 100), 0, 100)
    const mfaCoverage =
      t.mfaCoverage == null ? 100 : clamp(Number(t.mfaCoverage), 0, 100)
    const identityDetected = Math.max(0, Number(t.riskyIdentityCount ?? 0))

    return {
      ...t,
      attention,
      top,
      topSeverity,
      lastCriticalAt,
      healthScore,
      mfaCoverage,
      identityDetected,
    }
  })
}

export type QueueItem = {
  tenantId: string
  tenantName: string
  tenantDomain: string
  provider: 'microsoft' | 'google'
  item: AttentionItem
  detectedAt?: string
  metricLabel: string
  metricValue: string
}

function queueMetric(tenant: TenantRow, item: AttentionItem) {
  const label = (item.label ?? '').toLowerCase()

  if (label.includes('mfa')) {
    return { metricLabel: 'COVERAGE', metricValue: `${tenant.mfaCoverage}%` }
  }

  if (label.includes('risky') || label.includes('risk')) {
    return {
      metricLabel: 'AT RISK',
      metricValue: `${Math.max(1, tenant.identityDetected)} Users`,
    }
  }

  if (label.includes('external')) {
    return { metricLabel: 'AT RISK', metricValue: `Data` }
  }

  return { metricLabel: 'AT RISK', metricValue: '—' }
}

export default function DashboardPage() {
  const router = useRouter()
  const { data } = useTenants()
  const [tab, setTab] = React.useState<TabKey>('queue')

  const [selectedQueueItem, setSelectedQueueItem] = React.useState<QueueItem | null>(null)
  const [modalOriginElement, setModalOriginElement] = React.useState<HTMLElement | null>(null)

  const [tenantId, setTenantId] = React.useState<string>('all')
  const [severity, setSeverity] = React.useState<'all' | Severity>('all')
  const [search, setSearch] = React.useState('')

  const [sortField, setSortField] = React.useState<'severity' | 'tenant' | 'age' | null>(null)
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('asc')

  const tenants = React.useMemo(
    () => buildTenants(data?.tenants ?? []),
    [data?.tenants]
  )

  const filteredTenants = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    return tenants
      .filter((t) => (tenantId === 'all' ? true : t.id === tenantId))
      .filter((t) => (severity === 'all' ? true : t.topSeverity === severity))
      .filter((t) => {
        if (!q) return true
        const hay = [
          t.name,
          t.domain,
          t.provider,
          ...(t.top ?? []).map((x: AttentionItem) => x.label),
        ]
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
  }, [tenants, tenantId, severity, search])

  const queueItems = React.useMemo(() => {
    const items: QueueItem[] = []

    for (const t of filteredTenants) {
      for (const it of t.top) {
        if (severity !== 'all' && it.severity !== severity) continue
        const m = queueMetric(t, it)
        items.push({
          tenantId: t.id,
          tenantName: t.name,
          tenantDomain: t.domain,
          provider: t.provider,
          item: it,
          detectedAt: it.detectedAt ?? t.lastCriticalAt,
          metricLabel: m.metricLabel,
          metricValue: m.metricValue,
        })
      }
    }

    const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2 }
    return items
      .sort((a, b) => {
        const s = order[a.item.severity] - order[b.item.severity]
        if (s !== 0) return s
        return parseTime(b.detectedAt) - parseTime(a.detectedAt)
      })
      .slice(0, 50)
  }, [filteredTenants, severity])

  const handleSort = (field: 'severity' | 'tenant' | 'age') => {
    if (sortField === field) {
      if (sortDir === 'asc') setSortDir('desc')
      else {
        setSortField(null)
        setSortDir('asc')
      }
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  const sortedQueueItems = React.useMemo(() => {
    if (!sortField) return queueItems
    const items = [...queueItems]
    items.sort((a, b) => {
      let cmp = 0
      if (sortField === 'severity') {
        const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2 }
        cmp = order[a.item.severity] - order[b.item.severity]
      } else if (sortField === 'tenant') {
        cmp = a.tenantName.localeCompare(b.tenantName)
      } else if (sortField === 'age') {
        cmp = parseTime(b.detectedAt) - parseTime(a.detectedAt)
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return items
  }, [queueItems, sortField, sortDir])

  const kpis = React.useMemo(() => {
    const riskyIdentities = queueItems.filter((q) =>
      (q.item.label ?? '').toLowerCase().includes('risky')
    ).length

    const criticalTenants = tenants.filter(
      (t) => t.topSeverity === 'critical'
    ).length

    const mfaGaps = tenants.filter((t) =>
      (t.top ?? []).some((a: AttentionItem) =>
        (a.label ?? '').toLowerCase().includes('mfa')
      )
    ).length

    const avgScore =
      tenants.length === 0
        ? 0
        : Math.round(
            tenants.reduce((acc, t) => acc + (Number(t.healthScore) || 0), 0) /
              tenants.length
          )

    return { riskyIdentities, criticalTenants, mfaGaps, avgScore }
  }, [tenants, queueItems])

  const queueCount = queueItems.length
  const matrixCount = filteredTenants.length

  const reset = () => {
    setTenantId('all')
    setSeverity('all')
    setSearch('')
  }

  return (
    <div className="space-y-5">
      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="rounded-2xl">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                  Risky Identities
                </div>
                <div className="mt-1 text-3xl font-bold">
                  {kpis.riskyIdentities}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Requires immediate attention
                </div>
              </div>
              <div className="h-10 w-10 rounded-xl bg-red-50 border border-red-100 flex items-center justify-center">
                <AlertTriangle className="h-5 w-5 text-red-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                  Critical Tenants
                </div>
                <div className="mt-1 text-3xl font-bold">
                  {kpis.criticalTenants}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Current critical signals
                </div>
              </div>
              <div className="h-10 w-10 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center">
                <ShieldAlert className="h-5 w-5 text-amber-700" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                  MFA Gaps
                </div>
                <div className="mt-1 text-3xl font-bold">{kpis.mfaGaps}</div>
                <div className="mt-1 text-xs text-slate-500">
                  Tenants &lt; 85% coverage
                </div>
              </div>
              <div className="h-10 w-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center">
                <ShieldCheck className="h-5 w-5 text-blue-700" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                  Avg Health Score
                </div>
                <div className="mt-1 text-3xl font-bold">{kpis.avgScore}%</div>
                <div className="mt-1 text-xs text-slate-500">
                  Derived from current signals
                </div>
              </div>
              <div className="h-10 w-10 rounded-xl bg-green-50 border border-green-100 flex items-center justify-center">
                <TrendingUp className="h-5 w-5 text-green-700" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div className="rounded-2xl bg-slate-100 dark:bg-slate-800/60 p-1.5 border border-slate-200 dark:border-slate-800">
        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => setTab('queue')}
            className={[
              'h-11 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-colors',
              tab === 'queue'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200',
            ].join(' ')}
          >
            Priority Action Queue
            <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-2 rounded-full bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300 text-xs font-bold border border-red-100 dark:border-red-900">
              {queueCount}
            </span>
          </button>

          <button
            onClick={() => setTab('matrix')}
            className={[
              'h-11 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-colors',
              tab === 'matrix'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200',
            ].join(' ')}
          >
            Tenant Risk Matrix
            <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-2 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold">
              {matrixCount}
            </span>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
        <div className="grid grid-cols-1 md:grid-cols-[220px_220px_1fr_110px] gap-3">
          <div className="relative">
            <label className="sr-only">Tenant</label>
            <select
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              className="h-11 w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 text-sm font-medium text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            >
              <option value="all">All Tenants</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          <div className="relative">
            <label className="sr-only">Severity</label>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as any)}
              className="h-11 w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 text-sm font-medium text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
            </select>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search issues, tenants..."
              className="h-11 pl-9 rounded-xl"
            />
          </div>

          <Button variant="outline" className="h-11 rounded-xl" onClick={reset}>
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
        </div>
      </div>

      {/* Content */}
      {tab === 'queue' ? (
        <div className="space-y-2.5">
          {/* Queue Header */}
          <div className="flex items-center justify-between px-1">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 tracking-tight">
              Priority Action Queue
            </h2>
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {sortedQueueItems.length} matching {sortedQueueItems.length === 1 ? 'alert' : 'alerts'}
            </span>
          </div>

          {/* Unified Alert Queue Surface */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-sm">
            {sortedQueueItems.length === 0 ? (
              <div className="p-8 text-center text-sm font-medium text-slate-500 dark:text-slate-400">
                No matching alerts found. Try adjusting filters or search query.
              </div>
            ) : (
              <div>
                {/* Desktop/Tablet Table Header */}
                <div className="hidden md:grid grid-cols-[100px_minmax(220px,1fr)_190px_140px] lg:grid-cols-[100px_minmax(220px,1fr)_190px_80px_180px_140px] gap-3 px-4 pl-5 py-2.5 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider items-center">
                  <button
                    type="button"
                    onClick={() => handleSort('severity')}
                    className="flex items-center gap-1.5 hover:text-slate-800 dark:hover:text-slate-200 transition-colors focus:outline-none"
                  >
                    Severity
                    {sortField === 'severity' ? (
                      sortDir === 'asc' ? <ArrowUp className="h-3 w-3 text-blue-600" /> : <ArrowDown className="h-3 w-3 text-blue-600" />
                    ) : (
                      <ArrowUpDown className="h-3 w-3 text-slate-400" />
                    )}
                  </button>

                  <div>Alert</div>

                  <button
                    type="button"
                    onClick={() => handleSort('tenant')}
                    className="flex items-center gap-1.5 hover:text-slate-800 dark:hover:text-slate-200 transition-colors focus:outline-none"
                  >
                    Tenant
                    {sortField === 'tenant' ? (
                      sortDir === 'asc' ? <ArrowUp className="h-3 w-3 text-blue-600" /> : <ArrowDown className="h-3 w-3 text-blue-600" />
                    ) : (
                      <ArrowUpDown className="h-3 w-3 text-slate-400" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => handleSort('age')}
                    className="hidden lg:flex items-center gap-1.5 hover:text-slate-800 dark:hover:text-slate-200 transition-colors focus:outline-none"
                  >
                    Age
                    {sortField === 'age' ? (
                      sortDir === 'asc' ? <ArrowUp className="h-3 w-3 text-blue-600" /> : <ArrowDown className="h-3 w-3 text-blue-600" />
                    ) : (
                      <ArrowUpDown className="h-3 w-3 text-slate-400" />
                    )}
                  </button>

                  <div className="hidden lg:block">Key result</div>

                  <div className="text-right">Action</div>
                </div>

                {/* Queue Rows */}
                <div className="divide-y divide-slate-200 dark:divide-slate-800">
                  {sortedQueueItems.map((q, idx) => {
                    const ageInfo = formatAge(q.detectedAt)
                    const keyResult = getKeyResult(q)
                    const destinationUrl =
                      q.item.actionUrl ?? `/tenants/${encodeURIComponent(q.tenantId)}/settings`
                    const buttonLabel = q.item.actionLabel ?? actionLabel(q.item.severity)

                    return (
                      <div
                        key={`${q.tenantId}-${q.item.key}-${idx}`}
                        role="button"
                        tabIndex={0}
                        aria-haspopup="dialog"
                        aria-label={`View details for alert ${q.item.label} in ${q.tenantName}`}
                        onClick={(e) => {
                          setSelectedQueueItem(q)
                          setModalOriginElement(e.currentTarget as HTMLElement)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setSelectedQueueItem(q)
                            setModalOriginElement(e.currentTarget as HTMLElement)
                          }
                        }}
                        className="relative bg-white dark:bg-slate-900 hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 group"
                      >
                        {/* Narrow severity indicator stripe at far left */}
                        <div
                          className={`absolute left-0 top-0 bottom-0 w-1 ${severityStripe(
                            q.item.severity
                          )}`}
                        />

                        {/* Desktop / Tablet Grid Row */}
                        <div className="hidden md:grid grid-cols-[100px_minmax(220px,1fr)_190px_140px] lg:grid-cols-[100px_minmax(220px,1fr)_190px_80px_180px_140px] gap-3 px-4 pl-5 py-3 items-center min-h-[68px]">
                          {/* 1. Severity */}
                          <div>
                            <SeverityBadge sev={q.item.severity} />
                          </div>

                          {/* 2. Alert */}
                          <div className="min-w-0 pr-2">
                            <div className="text-[15px] font-semibold text-slate-900 dark:text-slate-100 leading-snug truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                              {q.item.label}
                            </div>
                            {q.item.why ? (
                              <div
                                className="mt-0.5 text-xs lg:text-[13px] text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed"
                                title={q.item.why}
                              >
                                {q.item.why}
                              </div>
                            ) : null}
                            {/* Move Age and Key Result here on Tablet (below lg) */}
                            <div className="lg:hidden mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                              <span className="font-medium text-slate-700 dark:text-slate-300">
                                {keyResult}
                              </span>
                              <span>•</span>
                              <span title={ageInfo.accessible} aria-label={ageInfo.accessible}>
                                {ageInfo.display}
                              </span>
                            </div>
                          </div>

                          {/* 3. Tenant */}
                          <div className="flex items-center gap-2.5 min-w-0">
                            {providerMark(q.provider)}
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                                {q.tenantName}
                              </div>
                              {q.tenantDomain ? (
                                <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                                  {q.tenantDomain}
                                </div>
                              ) : (
                                <div className="text-xs text-slate-400 dark:text-slate-500">
                                  Not provided
                                </div>
                              )}
                            </div>
                          </div>

                          {/* 4. Age (Desktop) */}
                          <div
                            className="hidden lg:block text-xs lg:text-[13px] font-medium text-slate-600 dark:text-slate-400 whitespace-nowrap"
                            title={ageInfo.accessible}
                            aria-label={ageInfo.accessible}
                          >
                            {ageInfo.display}
                          </div>

                          {/* 5. Key result (Desktop) */}
                          <div
                            className="hidden lg:block text-xs lg:text-[13px] font-medium text-slate-800 dark:text-slate-200 truncate pr-2"
                            title={keyResult}
                          >
                            {keyResult}
                          </div>

                          {/* 6. Action */}
                          <div className="flex justify-end">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 px-3 text-xs md:text-[13px] font-semibold text-slate-800 dark:text-slate-200 border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                              onClick={(e) => {
                                e.stopPropagation()
                                router.push(destinationUrl)
                              }}
                            >
                              {buttonLabel}
                            </Button>
                          </div>
                        </div>

                        {/* Mobile Structured Row */}
                        <div className="block md:hidden p-3.5 pl-5 space-y-2">
                          {/* Line 1: Severity and Age */}
                          <div className="flex items-center justify-between gap-2">
                            <SeverityBadge sev={q.item.severity} />
                            <span
                              className="text-xs text-slate-500 dark:text-slate-400 font-medium"
                              title={ageInfo.accessible}
                              aria-label={ageInfo.accessible}
                            >
                              {ageInfo.display}
                            </span>
                          </div>

                          {/* Line 2: Alert title */}
                          <div>
                            <div className="text-[15px] font-semibold text-slate-900 dark:text-slate-100 leading-snug">
                              {q.item.label}
                            </div>
                            {q.item.why ? (
                              <div
                                className="mt-0.5 text-[13px] text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed"
                                title={q.item.why}
                              >
                                {q.item.why}
                              </div>
                            ) : null}
                          </div>

                          {/* Line 3: Tenant */}
                          <div className="flex items-center gap-2 pt-0.5">
                            {providerMark(q.provider)}
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                                {q.tenantName}
                              </div>
                              {q.tenantDomain ? (
                                <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                                  {q.tenantDomain}
                                </div>
                              ) : (
                                <div className="text-xs text-slate-400 dark:text-slate-500">
                                  Not provided
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Line 4: Key result and action */}
                          <div className="flex items-center justify-between gap-3 pt-1 border-t border-slate-100 dark:border-slate-800/60">
                            <div className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">
                              {keyResult}
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 px-3 text-xs font-semibold text-slate-800 dark:text-slate-200 border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                              onClick={(e) => {
                                e.stopPropagation()
                                router.push(destinationUrl)
                              }}
                            >
                              {buttonLabel}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <ScrollPanel>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            {/* ✅ THIS fixes the overlap: horizontal scroll + minimum width */}
            <div className="overflow-x-auto">
              <div className="min-w-[980px]">
                <div className="grid grid-cols-[320px_220px_minmax(360px,1fr)_280px_40px] gap-0 px-4 py-3 text-[11px] font-bold tracking-wider text-slate-500 dark:text-slate-400 uppercase border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
                  <div>Tenant</div>
                  <div>Identity Risk</div>
                  <div>MFA Status</div>
                  <div>Posture</div>
                  <div />
                </div>

                <div className="divide-y divide-slate-200 dark:divide-slate-800">
                  {filteredTenants.map((t) => {
                    const covered = clamp(t.mfaCoverage, 0, 100)
                    const unprot = clamp(100 - covered, 0, 100)

                    const identityBadge =
                      t.identityDetected > 0 ? (
                        <Badge className="bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800 rounded-full">
                          {t.identityDetected} Detected
                        </Badge>
                      ) : (
                        <span className="text-sm text-slate-500 dark:text-slate-400">
                          None
                        </span>
                      )

                    const score = clamp(Number(t.healthScore ?? 0), 0, 100)
                    const ringColor =
                      score >= 80
                        ? 'border-green-500 text-green-700 dark:text-green-400'
                        : score >= 60
                          ? 'border-amber-500 text-amber-700 dark:text-amber-400'
                          : 'border-red-500 text-red-700 dark:text-red-400'

                    return (
                      <div
                        key={t.id}
                        className="grid grid-cols-[320px_220px_minmax(360px,1fr)_280px_40px] px-4 py-3 items-center hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {providerMark(t.provider)}
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                              {t.name}
                            </div>
                            <div className="text-xs text-slate-500 truncate">
                              {t.domain}
                            </div>
                          </div>
                        </div>

                        <div>{identityBadge}</div>

                        <div>
                          <div className="flex items-center justify-between text-sm">
                            <div className="font-semibold text-slate-900">
                              {covered}% Covered
                            </div>
                            <div className="text-xs text-slate-500 hidden xl:block">
                              {unprot}% unprotected
                            </div>
                          </div>

                          <div className="mt-2 h-2 rounded-full bg-slate-200 overflow-hidden">
                            <div
                              className={[
                                'h-2 rounded-full',
                                covered >= 85
                                  ? 'bg-green-500'
                                  : covered >= 65
                                    ? 'bg-amber-500'
                                    : 'bg-red-500',
                              ].join(' ')}
                              style={{ width: `${covered}%` }}
                            />
                          </div>
                        </div>

                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`h-10 w-10 rounded-full border-4 ${ringColor} flex items-center justify-center text-sm font-bold shrink-0`}
                            title={`${score}/100`}
                          >
                            {score}
                          </div>

                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-900 truncate">
                              {score === 0
                                ? 'Not yet secured'
                                : `${score} / 100`}
                            </div>
                            <div className="text-xs text-slate-500 truncate">
                              {score === 0
                                ? 'Baseline not met'
                                : 'Security Score'}
                            </div>
                          </div>
                        </div>

                        <div className="flex justify-end">
                          <ChevronRight className="h-5 w-5 text-slate-300" />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        </ScrollPanel>
      )}

      <AlertDetailsModal
        item={selectedQueueItem}
        isOpen={Boolean(selectedQueueItem)}
        onClose={() => setSelectedQueueItem(null)}
        originatingElement={modalOriginElement}
      />
    </div>
  )
}
