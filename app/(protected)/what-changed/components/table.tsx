'use client'

import * as React from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { WhatChangedFilters, type WhatChangedFiltersState } from './filters'
import { WhatChangedRow } from './row'
import { WhatChangedDrawer } from './drawer'
import { MOCK_CHANGES } from '../data/mock-changes'
import type { ChangeEvent } from '../data/change-types'

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
  const tenants = React.useMemo(() => uniqTenants(MOCK_CHANGES), [])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = React.useState(false)

  const [filters, setFilters] = React.useState<WhatChangedFiltersState>({
    tenant: 'all',
    severity: 'All',
    categories: [],
    search: '',
  })

  const filtered = React.useMemo(() => {
    const q = filters.search.trim().toLowerCase()

    return MOCK_CHANGES.slice()
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
  }, [filters])

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
          Unified timeline of high-signal changes across managed tenants.
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

      {/* Full-width timeline */}
      <div className="space-y-4">
        {grouped.length ? (
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
              No changes match your filters.
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
