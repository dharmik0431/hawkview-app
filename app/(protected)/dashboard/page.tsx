'use client'

import * as React from 'react'
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
} from 'lucide-react'

import { TENANTS, TENANT_MOCKS } from '../tenants/[id]/mock/tenants'
import { computeTenantAttention } from '@/lib/attention/computeTenantAttention'

type Severity = 'critical' | 'high' | 'medium'
type TabKey = 'queue' | 'matrix'

type AttentionItem = {
  key: string
  label: string
  severity: Severity
  why?: string
  detectedAt?: string
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

function unresolvedFor(iso?: string) {
  const t = parseTime(iso)
  if (!t) return '—'
  const diff = Date.now() - t
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'Unresolved for <1m'
  if (mins < 60) return `Unresolved for ${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `Unresolved for ${hrs}h`
  const days = Math.round(hrs / 24)
  return `Unresolved for ${days}d`
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function severityChip(sev: Severity) {
  if (sev === 'critical') return 'bg-red-50 text-red-700 border border-red-200'
  if (sev === 'high')
    return 'bg-amber-50 text-amber-800 border border-amber-200'
  return 'bg-blue-50 text-blue-700 border border-blue-200'
}

function severityStripe(sev: Severity) {
  if (sev === 'critical') return 'bg-red-500'
  if (sev === 'high') return 'bg-amber-500'
  return 'bg-blue-500'
}

function severityLabel(sev: Severity) {
  if (sev === 'critical') return 'CRITICAL'
  if (sev === 'high') return 'HIGH'
  return 'MEDIUM'
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
        'h-[520px] overflow-y-auto rounded-xl border bg-white',
        'pr-2',
        '[&::-webkit-scrollbar]:w-2',
        '[&::-webkit-scrollbar-thumb]:rounded-full',
        '[&::-webkit-scrollbar-thumb]:bg-slate-300/70',
        'hover:[&::-webkit-scrollbar-thumb]:bg-slate-400/80',
        '[&::-webkit-scrollbar-track]:bg-transparent',
      ].join(' ')}
    >
      <div className="p-3">{children}</div>
    </div>
  )
}

type TenantRow = (typeof TENANTS)[number] & {
  attention: AttentionItem[]
  top: AttentionItem[]
  topSeverity?: Severity
  lastCriticalAt?: string
  mfaCoverage: number
  identityDetected: number
}

function buildTenants(): TenantRow[] {
  return (TENANTS ?? []).map((t: any) => {
    const bundle = (TENANT_MOCKS as any)?.[t.id]
    const attention = (computeTenantAttention(bundle) ?? []) as AttentionItem[]
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

    // placeholder until real MFA coverage exists: use secureScore
    const mfaCoverage = clamp(Number(t.secureScore ?? 0), 0, 100)

    const identityDetected = attention.filter(
      (a) => a.severity === 'critical' || a.severity === 'high'
    ).length

    return {
      ...t,
      attention,
      top,
      topSeverity,
      lastCriticalAt,
      mfaCoverage,
      identityDetected,
    }
  })
}

type QueueItem = {
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
  const [tab, setTab] = React.useState<TabKey>('queue')

  const [tenantId, setTenantId] = React.useState<string>('all')
  const [severity, setSeverity] = React.useState<'all' | Severity>('all')
  const [search, setSearch] = React.useState('')

  const tenants = React.useMemo(() => buildTenants(), [])

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

  const kpis = React.useMemo(() => {
    const riskyIdentities = queueItems.filter((q) =>
      (q.item.label ?? '').toLowerCase().includes('risky')
    ).length

    const criticalTenants = tenants.filter(
      (t) => t.topSeverity === 'critical'
    ).length

    const mfaGaps = tenants.filter((t) =>
      (t.top ?? []).some((a: AttentionItem) => (a.label ?? '').toLowerCase().includes('mfa'))
    ).length

    const avgScore =
      tenants.length === 0
        ? 0
        : Math.round(
            tenants.reduce((acc, t) => acc + (Number(t.secureScore) || 0), 0) /
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
                  {kpis.riskyIdentities || 13}
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
                  {kpis.criticalTenants || 3}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Security baseline failed
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
                <div className="mt-1 text-3xl font-bold">
                  {kpis.mfaGaps || 5}
                </div>
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
                  Avg Security Score
                </div>
                <div className="mt-1 text-3xl font-bold">
                  {kpis.avgScore || 65}%
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  +2% from last week
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
      <div className="rounded-2xl bg-slate-100 p-1.5 border">
        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => setTab('queue')}
            className={[
              'h-11 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-colors',
              tab === 'queue'
                ? 'bg-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900',
            ].join(' ')}
          >
            Priority Action Queue
            <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-2 rounded-full bg-red-50 text-red-700 text-xs font-bold border border-red-100">
              {queueCount || 13}
            </span>
          </button>

          <button
            onClick={() => setTab('matrix')}
            className={[
              'h-11 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-colors',
              tab === 'matrix'
                ? 'bg-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900',
            ].join(' ')}
          >
            Tenant Risk Matrix
            <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-2 rounded-full bg-slate-200 text-slate-700 text-xs font-bold">
              {matrixCount || 6}
            </span>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-2xl border bg-white p-3">
        <div className="grid grid-cols-1 md:grid-cols-[220px_220px_1fr_110px] gap-3">
          <div className="relative">
            <label className="sr-only">Tenant</label>
            <select
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              className="h-11 w-full rounded-xl border bg-white px-3 text-sm font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
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
              className="h-11 w-full rounded-xl border bg-white px-3 text-sm font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
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
        <ScrollPanel>
          <div className="space-y-2">
            {queueItems.length === 0 ? (
              <div className="rounded-xl border bg-slate-50 p-8 text-center text-sm text-slate-600">
                No items found. Try adjusting filters.
              </div>
            ) : (
              queueItems.map((q, idx) => (
                <div
                  key={`${q.tenantId}-${q.item.key}-${idx}`}
                  className="relative rounded-xl border bg-white overflow-hidden"
                >
                  <div
                    className={`absolute left-0 top-0 bottom-0 w-1.5 ${severityStripe(
                      q.item.severity
                    )}`}
                  />

                  {/* denser row */}
                  <div className="px-4 py-3 pl-5 grid grid-cols-1 md:grid-cols-[1fr_280px_160px] gap-3 items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex items-center h-6 px-2 rounded-md text-[11px] font-bold tracking-wide ${severityChip(
                            q.item.severity
                          )}`}
                        >
                          {severityLabel(q.item.severity)}
                        </span>

                        <span className="text-xs text-slate-500">
                          {unresolvedFor(q.detectedAt)}
                        </span>
                      </div>

                      <div className="mt-1 font-semibold text-slate-900">
                        {q.item.label}
                      </div>

                      {q.item.why ? (
                        <div className="mt-0.5 text-sm text-slate-600 line-clamp-1">
                          {q.item.why}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-3 md:justify-end">
                      {providerMark(q.provider)}
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900 truncate">
                          {q.tenantName}
                        </div>
                        <div className="text-xs text-slate-500 truncate">
                          ID: {q.tenantId}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between md:justify-end gap-3">
                      <div className="text-right">
                        <div className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
                          {q.metricLabel}
                        </div>
                        <div className="text-lg font-bold text-slate-900">
                          {q.metricValue}
                        </div>
                      </div>

                      <Button
                        variant="outline"
                        className="h-9 rounded-lg"
                        onClick={(e) => {
                          e.preventDefault()
                        }}
                      >
                        {actionLabel(q.item.severity)}
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollPanel>
      ) : (
        <ScrollPanel>
          <div className="rounded-xl border bg-white overflow-hidden">
            {/* ✅ THIS fixes the overlap: horizontal scroll + minimum width */}
            <div className="overflow-x-auto">
              <div className="min-w-[980px]">
                <div className="grid grid-cols-[320px_220px_minmax(360px,1fr)_280px_40px] gap-0 px-4 py-3 text-[11px] font-bold tracking-wider text-slate-500 uppercase border-b bg-slate-50">
                  <div>Tenant</div>
                  <div>Identity Risk</div>
                  <div>MFA Status</div>
                  <div>Posture</div>
                  <div />
                </div>

                <div className="divide-y">
                  {filteredTenants.map((t) => {
                    const covered = clamp(t.mfaCoverage, 0, 100)
                    const unprot = clamp(100 - covered, 0, 100)

                    const identityBadge =
                      t.identityDetected > 0 ? (
                        <Badge className="bg-red-50 text-red-700 border border-red-200 rounded-full">
                          {t.identityDetected} Detected
                        </Badge>
                      ) : (
                        <span className="text-sm text-slate-500">None</span>
                      )

                    const score = clamp(Number(t.secureScore ?? 0), 0, 100)
                    const ringColor =
                      score >= 80
                        ? 'border-green-500 text-green-700'
                        : score >= 60
                          ? 'border-amber-500 text-amber-700'
                          : 'border-red-500 text-red-700'

                    return (
                      <div
                        key={t.id}
                        className="grid grid-cols-[320px_220px_minmax(360px,1fr)_280px_40px] px-4 py-3 items-center hover:bg-slate-50 transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {providerMark(t.provider)}
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-900 truncate">
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
    </div>
  )
}
