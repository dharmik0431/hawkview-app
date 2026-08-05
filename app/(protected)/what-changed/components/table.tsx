'use client'

import * as React from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { WhatChangedFilters, type WhatChangedFiltersState } from './filters'
import { WhatChangedRow } from './row'
import { WhatChangedDrawer } from './drawer'
import type { ChangeEvent } from '../data/change-types'
import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api/client'

type ChangesResponse = {
  changes: ChangeEvent[]
  tenants: { id: string; name: string }[]
  summary: { total: number; changes: number; signIns: number; highRisk: number; actors: number }
}

function localDateTime(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function uniqTenants(events: ChangeEvent[]) {
  const map = new Map<string, { id: string; name: string }>()
  for (const e of events)
    map.set(e.tenantId, { id: e.tenantId, name: e.tenantName })
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
}

// UTC day buckets to avoid hydration issues
function dayKeyUTC(ts: string) {
  return new Date(ts).toISOString().slice(0, 10) // YYYY-MM-DD
}

function daysAgoUTC(dayKey: string) {
  const nowKey = new Date().toISOString().slice(0, 10)
  const now = new Date(nowKey + 'T00:00:00Z').getTime()
  const day = new Date(dayKey + 'T00:00:00Z').getTime()
  return Math.floor((now - day) / (1000 * 60 * 60 * 24))
}

function groupLabel(dayKey: string) {
  const d = daysAgoUTC(dayKey)
  if (d === 0) return 'Today'
  if (d === 1) return 'Yesterday'
  return 'Earlier'
}

export function WhatChangedView() {
  const initialRange = React.useMemo(() => {
    const to = new Date()
    return { from: localDateTime(new Date(to.getTime() - 24 * 60 * 60 * 1000)), to: localDateTime(to) }
  }, [])
  const [filters, setFilters] = React.useState<WhatChangedFiltersState>({
    tenant: 'all', severity: 'All', categories: [], search: '', ...initialRange,
  })
  const { data, isLoading, error } = useQuery<ChangesResponse>({
    queryKey: ['changes', filters.tenant, filters.from, filters.to],
    queryFn: ({ signal }) =>
      apiClient.get('/api/changes', {
        signal,
        params: {
          from: new Date(filters.from).toISOString(),
          to: new Date(filters.to).toISOString(),
          ...(filters.tenant !== 'all' ? { tenantId: filters.tenant } : {}),
        },
      }),
    retry: false,
    staleTime: 5 * 60 * 1000,
    enabled: Boolean(filters.from && filters.to),
  })
  const changes = React.useMemo(() => data?.changes ?? [], [data?.changes])
  const tenants = React.useMemo(() => data?.tenants ?? uniqTenants(changes), [data?.tenants, changes])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = React.useState(false)

  const filtered = React.useMemo(() => {
    const q = filters.search.trim().toLowerCase()

    return changes
      .slice()
      .sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
      .filter((e) =>
        filters.tenant === 'all' ? true : e.tenantId === filters.tenant
      )
      .filter((e) =>
        filters.severity === 'All' ? true : e.severity === filters.severity
      )
      .filter((e) =>
        filters.categories.length
          ? filters.categories.includes(e.category)
          : true
      )
      .filter((e) => {
        if (!q) return true
        const hay = [
          e.tenantName,
          e.title,
          e.summary,
          e.actor ?? '',
          e.target ?? '',
          e.category,
          e.source,
          e.ip ?? '',
          e.location?.city ?? '',
          e.location?.region ?? '',
          e.location?.country ?? '',
        ]
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
  }, [changes, filters])

  const selected = React.useMemo(
    () => filtered.find((x) => x.id === selectedId) ?? null,
    [filtered, selectedId]
  )

  // If filters change and selected disappears, close drawer
  React.useEffect(() => {
    if (selectedId && !filtered.some((x) => x.id === selectedId)) {
      setDrawerOpen(false)
      setSelectedId(null)
    }
  }, [filtered, selectedId])

  // Group timeline
  const grouped = React.useMemo(() => {
    const byDay = new Map<string, ChangeEvent[]>()
    for (const e of filtered) {
      const key = dayKeyUTC(e.ts)
      byDay.set(key, [...(byDay.get(key) ?? []), e])
    }

    const dayKeys = Array.from(byDay.keys()).sort((a, b) => (a > b ? -1 : 1)) // newest first

    return dayKeys.map((k) => ({
      label: groupLabel(k),
      dayKey: k,
      items: byDay.get(k) ?? [],
    }))
  }, [filtered])

  function openDrawerFor(id: string) {
    setSelectedId(id)
    setDrawerOpen(true)
  }

  function closeDrawer() {
    setDrawerOpen(false)
    setSelectedId(null)
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-2xl font-semibold">What Changed?</div>
        <div className="text-sm text-muted-foreground">
          Investigate an incident from an exact point in time and reconstruct who changed what.
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <WhatChangedFilters
            tenants={tenants}
            value={filters}
            onChange={setFilters}
          />
        </CardContent>
      </Card>

      {data?.summary ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[
            ['Evidence events', data.summary.total],
            ['Directory changes', data.summary.changes],
            ['Related sign-ins', data.summary.signIns],
            ['High risk', data.summary.highRisk],
            ['Actors identified', data.summary.actors],
          ].map(([label, value]) => (
            <Card key={String(label)}><CardContent className="p-4"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-2xl font-semibold">{value}</div></CardContent></Card>
          ))}
        </div>
      ) : null}

      {error ? <Card><CardContent className="p-6 text-sm text-red-600">{error instanceof Error ? error.message : 'The investigation could not be loaded.'}</CardContent></Card> : null}

      {/* Full-width timeline */}
      <div className="space-y-4">
        {isLoading ? (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">Building the incident timeline...</CardContent></Card>
        ) : grouped.length ? (
          grouped.map((section, idx) => (
            <div key={section.dayKey} className="space-y-3">
              {(idx === 0 || section.label !== grouped[idx - 1]?.label) && (
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {section.label}
                </div>
              )}

              {section.items.map((e) => (
                <WhatChangedRow
                  key={e.id}
                  e={e}
                  isActive={drawerOpen && e.id === selectedId}
                  onClick={() => openDrawerFor(e.id)}
                />
              ))}
            </div>
          ))
        ) : (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              No audit or sign-in evidence was stored for this time range. This does not prove that no change occurred.
            </CardContent>
          </Card>
        )}
      </div>

      {/* Slide-over drawer overlay (GAS style) */}
      <WhatChangedDrawer
        open={drawerOpen}
        event={selected}
        onClose={closeDrawer}
      />
    </div>
  )
}
