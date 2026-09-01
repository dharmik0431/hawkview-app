'use client'

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { History, ShieldAlert, AlertCircle, RefreshCw, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api/client'
import {
  TimeWindowValue,
  getQuickRangeDates,
  parseISOOrLocal,
} from './time-window-picker'
import { InvestigationToolbar, ToolbarFilterState } from './investigation-toolbar'
import { SummaryStrip, SummaryCategoryKey } from './summary-strip'
import { WhatChangedRow } from './row'
import { WhatChangedDrawer } from './drawer'
import { type ChangeEvent, isAppRelatedEvent, normalizeChangesResponse } from '../data/change-types'
import { classifyEvent } from '../data/event-classifier'
import { Button } from '@/components/ui/button'

type ChangesResponse = {
  changes: ChangeEvent[]
  tenants: { id: string; name: string }[]
  validPayload: boolean
  partialPayload: boolean
  discardedCount: number
  summary?: { total: number; changes: number; signIns: number; highRisk: number; apps: number }
}

function uniqTenants(events: ChangeEvent[]) {
  const map = new Map<string, { id: string; name: string }>()
  for (const e of events) {
    if (e.tenantId) {
      map.set(e.tenantId, { id: e.tenantId, name: e.tenantName || e.tenantId })
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
}

function dateKey(ts: string, useUtc = false) {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return 'unknown-date'
  if (useUtc) {
    return d.toISOString().slice(0, 10)
  }
  const year = d.getFullYear()
  const month = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatGroupLabel(key: string, useUtc = false) {
  const now = new Date()
  const todayKey = dateKey(now.toISOString(), useUtc)

  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const yesterdayKey = dateKey(yesterday.toISOString(), useUtc)

  if (key === todayKey) return 'Today'
  if (key === yesterdayKey) return 'Yesterday'

  const parts = key.split('-')
  if (parts.length === 3) {
    const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(d)
  }
  return key
}

function getCategoryHeadingLabel(key: SummaryCategoryKey): string {
  switch (key) {
    case 'all':
      return 'Evidence events'
    case 'changes':
      return 'Directory changes'
    case 'signIns':
      return 'Related sign-ins'
    case 'highRisk':
      return 'High-risk events'
    case 'apps':
      return 'App-related changes'
  }
}

export function WhatChangedView() {
  const searchParams = useSearchParams()
  const linkedTenantId = searchParams.get('tenantId')
  const linkedFrom = searchParams.get('from')

  // Time Window State (Default 24h)
  const initialRange = React.useMemo(() => {
    const fallback = getQuickRangeDates('24h', false)
    if (!linkedFrom) return fallback
    const parsed = new Date(linkedFrom)
    if (Number.isNaN(parsed.getTime())) return fallback
    return { from: parsed.toISOString(), to: new Date().toISOString() }
  }, [linkedFrom])
  const [timeWindow, setTimeWindow] = React.useState<TimeWindowValue>({
    from: initialRange.from,
    to: initialRange.to,
    quickRange: linkedFrom ? 'custom' : '24h',
    useUtc: false,
    is12Hour: true,
  })

  // Toolbar Filters State
  const [toolbarFilters, setToolbarFilters] = React.useState<ToolbarFilterState>({
    tenant: linkedTenantId || 'all',
    search: '',
    severity: 'All',
    categories: [],
    source: 'All',
    actorFilter: '',
    targetFilter: '',
    locationFilter: '',
  })

  // Clickable Summary Category State (Default 'all')
  const [selectedCategory, setSelectedCategory] = React.useState<SummaryCategoryKey>('all')

  // Selected event & drawer
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = React.useState(false)

  // Validate time range
  const isValidTimeRange = React.useMemo(() => {
    const fromD = parseISOOrLocal(timeWindow.from)
    const toD = parseISOOrLocal(timeWindow.to)
    return toD.getTime() >= fromD.getTime()
  }, [timeWindow.from, timeWindow.to])

  // Data Query
  const { data, isLoading, error, refetch } = useQuery<ChangesResponse>({
    queryKey: ['changes', toolbarFilters.tenant, timeWindow.from, timeWindow.to],
    queryFn: async ({ signal }) => {
      const fromIso = parseISOOrLocal(timeWindow.from).toISOString()
      const toIso = parseISOOrLocal(timeWindow.to).toISOString()
      const response = await apiClient.get('/api/changes', {
        signal,
        params: {
          from: fromIso,
          to: toIso,
          ...(toolbarFilters.tenant !== 'all' ? { tenantId: toolbarFilters.tenant } : {}),
        },
      })
      return normalizeChangesResponse(response)
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
    enabled: Boolean(timeWindow.from && timeWindow.to && isValidTimeRange),
  })

  const rawChanges = React.useMemo(() => data?.changes ?? [], [data?.changes])
  const tenants = React.useMemo(() => data?.tenants ?? uniqTenants(rawChanges), [data?.tenants, rawChanges])

  // Base client-side filtering across search, severity, source, categories, actor, target, location
  const baseFilteredChanges = React.useMemo(() => {
    const q = toolbarFilters.search.trim().toLowerCase()
    const actorQ = toolbarFilters.actorFilter.trim().toLowerCase()
    const targetQ = toolbarFilters.targetFilter.trim().toLowerCase()
    const locQ = toolbarFilters.locationFilter.trim().toLowerCase()

    return rawChanges
      .slice()
      .sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
      .filter((e) => (toolbarFilters.tenant === 'all' ? true : e.tenantId === toolbarFilters.tenant))
      .filter((e) => (toolbarFilters.severity === 'All' ? true : e.severity === toolbarFilters.severity))
      .filter((e) => (toolbarFilters.source === 'All' ? true : e.source === toolbarFilters.source))
      .filter((e) => (toolbarFilters.categories.length ? toolbarFilters.categories.includes(e.category) : true))
      .filter((e) => (!actorQ ? true : (e.actor ?? '').toLowerCase().includes(actorQ)))
      .filter((e) => (!targetQ ? true : (e.target ?? '').toLowerCase().includes(targetQ)))
      .filter((e) => {
        if (!locQ) return true
        const locHay = [
          e.ip ?? '',
          e.location?.city ?? '',
          e.location?.region ?? '',
          e.location?.country ?? '',
        ].join(' ').toLowerCase()
        return locHay.includes(locQ)
      })
      .filter((e) => {
        if (!q) return true
        const mainHay = [
          e.tenantName ?? '',
          e.title ?? '',
          e.summary ?? '',
          e.actor ?? '',
          e.target ?? '',
          e.category ?? '',
          e.source ?? '',
          e.ip ?? '',
          e.location?.city ?? '',
          e.location?.region ?? '',
          e.location?.country ?? '',
        ].join(' ').toLowerCase()
        return mainHay.includes(q)
      })
  }, [rawChanges, toolbarFilters])

  // Calculate summary counts dynamically from base filtered changes
  const summaryCounts = React.useMemo(() => {
    let total = baseFilteredChanges.length
    let changes = 0
    let signIns = 0
    let highRisk = 0
    let apps = 0

    for (const e of baseFilteredChanges) {
      const isSignIn = e.eventType === 'sign-in' || e.category === 'Sign-ins'
      if (isSignIn) {
        signIns++
      } else if (e.eventType === 'change') {
        changes++
      }

      if (classifyEvent(e).isHighRisk) {
        highRisk++
      }

      if (isAppRelatedEvent(e)) {
        apps++
      }
    }

    return { total, changes, signIns, highRisk, apps }
  }, [baseFilteredChanges])

  // Final filtering by selected summary category
  const finalFilteredChanges = React.useMemo(() => {
    if (selectedCategory === 'all') return baseFilteredChanges

    return baseFilteredChanges.filter((e) => {
      const isSignIn = e.eventType === 'sign-in' || e.category === 'Sign-ins'

      if (selectedCategory === 'changes') {
        return e.eventType === 'change'
      }
      if (selectedCategory === 'signIns') {
        return isSignIn
      }
      if (selectedCategory === 'highRisk') {
        return classifyEvent(e).isHighRisk
      }
      if (selectedCategory === 'apps') {
        return isAppRelatedEvent(e)
      }
      return true
    })
  }, [baseFilteredChanges, selectedCategory])

  // Reset all filters, time range, and category
  const handleResetFilters = React.useCallback(() => {
    const range24h = getQuickRangeDates('24h', false)
    setTimeWindow({
      from: range24h.from,
      to: range24h.to,
      quickRange: '24h',
      useUtc: false,
      is12Hour: true,
    })

    setToolbarFilters({
      tenant: 'all',
      search: '',
      severity: 'All',
      categories: [],
      source: 'All',
      actorFilter: '',
      targetFilter: '',
      locationFilter: '',
    })

    setSelectedCategory('all')
  }, [])

  // Group timeline by date
  const groupedTimeline = React.useMemo(() => {
    const map = new Map<string, ChangeEvent[]>()
    for (const e of finalFilteredChanges) {
      const key = dateKey(e.ts, timeWindow.useUtc)
      map.set(key, [...(map.get(key) ?? []), e])
    }

    const keys = Array.from(map.keys()).sort((a, b) => (a > b ? -1 : 1)) // newest first

    return keys.map((k) => ({
      key: k,
      label: formatGroupLabel(k, timeWindow.useUtc),
      items: map.get(k) ?? [],
    }))
  }, [finalFilteredChanges, timeWindow.useUtc])

  const selectedEvent = React.useMemo(
    () => finalFilteredChanges.find((x) => (x.rowKey ?? x.id) === selectedId) ?? null,
    [finalFilteredChanges, selectedId]
  )

  // Close drawer if selected event no longer matches filters
  React.useEffect(() => {
    if (selectedId && !finalFilteredChanges.some((x) => (x.rowKey ?? x.id) === selectedId)) {
      setDrawerOpen(false)
      setSelectedId(null)
    }
  }, [finalFilteredChanges, selectedId])

  const handleOpenDrawer = (id: string) => {
    setSelectedId(id)
    setDrawerOpen(true)
  }

  const handleCloseDrawer = () => {
    setDrawerOpen(false)
    setSelectedId(null)
  }

  return (
    <div className="flex flex-col gap-5 max-w-7xl mx-auto w-full pb-8">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/60 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <div className="rounded-lg bg-primary/10 p-2 text-primary">
              <History className="h-5 w-5" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              What Changed?
            </h1>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Reconstruct activity around an incident and identify who changed what.
          </p>
        </div>
      </div>

      {/* Investigation Toolbar */}
      <InvestigationToolbar
        tenants={tenants}
        value={toolbarFilters}
        onChange={setToolbarFilters}
        timeWindow={timeWindow}
        onChangeTimeWindow={setTimeWindow}
        onReset={handleResetFilters}
      />

      {isLoading && (
        <div role="status" aria-live="polite" className="rounded-xl border border-border bg-card p-8 text-center space-y-3">
          <div className="inline-flex items-center justify-center rounded-full bg-primary/10 p-3 text-primary animate-spin">
            <RefreshCw className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="text-sm font-medium text-foreground">Reconstructing the selected time window…</div>
          <p className="text-xs text-muted-foreground max-w-sm mx-auto">
            Gathering retained administrative evidence from HawkView.
          </p>
        </div>
      )}

      {/* Clickable Investigation Summary Strip */}
      {!isLoading && !error && data?.validPayload && (
        <SummaryStrip
          summary={summaryCounts}
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
        />
      )}

      {/* Error state */}
      {error && (
        <div role="alert" className="rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-xs text-destructive flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>
              The investigation activity could not be loaded. Please retry.
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            className="h-7 text-xs gap-1"
          >
            <RefreshCw className="h-3 w-3" />
            <span>Retry</span>
          </Button>
        </div>
      )}

      {!isLoading && !error && data && (!data.validPayload || data.partialPayload || data.discardedCount > 0) && (
        <div role="status" aria-live="polite" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          {!data.validPayload
            ? 'Change evidence is unavailable because the service response could not be verified.'
            : data.discardedCount > 0
            ? `Some evidence could not be displayed (${data.discardedCount} malformed ${data.discardedCount === 1 ? 'record' : 'records'}).`
            : 'Change evidence is partially available because response metadata could not be verified.'}
        </div>
      )}

      {/* Timeline List Section */}
      {!error && data?.validPayload && <div className="space-y-4 pt-1">
        {/* Selected Category Heading */}
        {!isLoading && (
          <div className="flex items-center justify-between border-b border-border/60 pb-2">
            <h2 className="text-sm font-bold text-foreground tracking-tight">
              {getCategoryHeadingLabel(selectedCategory)} — {finalFilteredChanges.length}
            </h2>

            {selectedCategory !== 'all' && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelectedCategory('all')}
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
              >
                <X className="h-3.5 w-3.5" />
                <span>Clear category</span>
              </Button>
            )}
          </div>
        )}

        {groupedTimeline.length ? (
          /* Timeline Sections */
          groupedTimeline.map((group) => (
            <div key={group.key} className="space-y-2">
              {/* Date Group Header */}
              <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-xs py-1.5 border-b border-border/40">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-primary shrink-0" />
                  {group.label}
                  <span className="text-[11px] font-normal text-muted-foreground/80">
                    ({group.items.length} {group.items.length === 1 ? 'event' : 'events'})
                  </span>
                </span>
              </div>

              {/* Event Rows */}
              <div className="pt-1">
                {group.items.map((e) => (
                  <WhatChangedRow
                    key={e.rowKey ?? e.id}
                    e={e}
                    isActive={drawerOpen && (e.rowKey ?? e.id) === selectedId}
                    useUtc={timeWindow.useUtc}
                    onClick={() => handleOpenDrawer(e.rowKey ?? e.id)}
                  />
                ))}
              </div>
            </div>
          ))
        ) : (
          /* Empty State */
          <div className="rounded-xl border border-border bg-card p-8 sm:p-12 text-center space-y-3">
            <div className="inline-flex items-center justify-center rounded-full bg-muted p-3 text-muted-foreground mx-auto">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <div className="text-sm font-semibold text-foreground">
              {rawChanges.length === 0 && !data.partialPayload && data.discardedCount === 0
                ? 'No administrative changes were reported for this range.'
                : rawChanges.length === 0
                  ? 'No verified administrative changes can be displayed.'
                  : 'No events match the selected filters.'}
            </div>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              {rawChanges.length === 0 && !data.partialPayload && data.discardedCount === 0
                ? 'HawkView received an authoritative empty result for the selected time range.'
                : rawChanges.length === 0
                  ? 'Some response evidence was unavailable or malformed, so this is not a verified zero.'
                  : 'Try another category or clear the active filters.'}
            </p>
            <div className="pt-2 flex flex-wrap justify-center gap-2">
              {selectedCategory !== 'all' && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedCategory('all')}
                  className="text-xs"
                >
                  View Evidence Events ({summaryCounts.total})
                </Button>
              )}
              {rawChanges.length > 0 && <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const r7d = getQuickRangeDates('7d', timeWindow.useUtc)
                  setTimeWindow((prev) => ({
                    ...prev,
                    quickRange: '7d',
                    from: r7d.from,
                    to: r7d.to,
                  }))
                }}
                className="text-xs"
              >
                Expand to Last 7 Days
              </Button>}
              {rawChanges.length > 0 && <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleResetFilters}
                className="text-xs"
              >
                Clear Filters
              </Button>}
            </div>
          </div>
        )}
      </div>}

      {/* Details Slide-over Drawer */}
      <WhatChangedDrawer
        open={drawerOpen}
        event={selectedEvent}
        onClose={handleCloseDrawer}
      />
    </div>
  )
}
