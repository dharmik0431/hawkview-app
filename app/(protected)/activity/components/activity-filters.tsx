'use client'

import * as React from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export type ActivityFiltersValue = {
  tenantId: string // '' when none selected
  userUpn: string // 'all' or user principal name
  datePreset: '7d' | '30d' | '60d' | '90d' | '180d' | 'custom'
  dateFrom: string // YYYY-MM-DD (only used for custom)
  dateTo: string // YYYY-MM-DD (only used for custom)
  search: string
}

export function ActivityFilters({
  tenants,
  users,
  value,
  onChange,
  onReset,
}: {
  tenants: Array<{ id: string; name: string }>
  users: Array<{ upn: string; label: string }>
  value: ActivityFiltersValue
  onChange: (v: ActivityFiltersValue) => void
  onReset: () => void
}) {
  const tenantSelected = !!value.tenantId
  const isCustom = value.datePreset === 'custom'

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Tenant */}
      <select
        className="h-10 rounded-md border bg-background px-3 text-sm min-w-[220px]"
        value={value.tenantId}
        onChange={(e) => {
          // Reset user filter when tenant changes
          onChange({
            ...value,
            tenantId: e.target.value,
            userUpn: 'all',
            search: '',
          })
        }}
      >
        <option value="">Select a Tenant…</option>
        {tenants.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>

      {/* Users (disabled until tenant chosen) */}
      <select
        className="h-10 rounded-md border bg-background px-3 text-sm min-w-[180px]"
        value={value.userUpn}
        disabled={!tenantSelected}
        onChange={(e) => onChange({ ...value, userUpn: e.target.value })}
      >
        <option value="all">All Users</option>
        {users.map((u) => (
          <option key={u.upn} value={u.upn}>
            {u.label}
          </option>
        ))}
      </select>

      {/* Date range */}
      <select
        className="h-10 rounded-md border bg-background px-3 text-sm min-w-[150px]"
        value={value.datePreset}
        onChange={(e) =>
          onChange({ ...value, datePreset: e.target.value as any })
        }
      >
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
        <option value="60d">Last 60 days</option>
        <option value="90d">Last 90 days</option>
        <option value="180d">Last 180 days</option>
        <option value="custom">Custom Range</option>
      </select>

      {/* Custom range fields */}
      {isCustom && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={value.dateFrom}
            onChange={(e) => onChange({ ...value, dateFrom: e.target.value })}
          />
          <span className="text-sm text-muted-foreground">to</span>
          <input
            type="date"
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={value.dateTo}
            onChange={(e) => onChange({ ...value, dateTo: e.target.value })}
          />
        </div>
      )}

      {/* Search */}
      <div className="flex-1 min-w-[260px]">
        <Input
          value={value.search}
          onChange={(e) => onChange({ ...value, search: e.target.value })}
          placeholder={
            tenantSelected
              ? 'Search user, app, IP…'
              : 'Select a tenant to search…'
          }
          disabled={!tenantSelected}
        />
      </div>

      <Button variant="secondary" onClick={onReset}>
        Reset
      </Button>
    </div>
  )
}
