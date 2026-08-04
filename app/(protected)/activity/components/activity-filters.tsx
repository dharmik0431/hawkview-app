'use client'

import * as React from 'react'
import { Filter, Download, X, Loader2, RotateCcw } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AdvancedFilterPanel,
  type AdvancedFiltersState,
  type FilterOptions,
} from './advanced-filter-panel'
import type { ActivityTab } from '../data/types'

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
  advancedValue,
  tab,
  onChange,
  onAdvancedChange,
  onReset,
  options,
  matchingCount,
  onExportCsv,
  isExporting,
}: {
  tenants: Array<{ id: string; name: string }>
  users: Array<{ upn: string; label: string }>
  value: ActivityFiltersValue
  advancedValue: AdvancedFiltersState
  tab: ActivityTab
  onChange: (v: ActivityFiltersValue) => void
  onAdvancedChange: (v: AdvancedFiltersState) => void
  onReset: () => void
  options: FilterOptions
  matchingCount: number
  onExportCsv: () => void
  isExporting: boolean
}) {
  const [filterPanelOpen, setFilterPanelOpen] = React.useState(false)

  const tenantSelected = !!value.tenantId
  const isCustom = value.datePreset === 'custom'

  // Calculate active advanced filter count for active tab
  const activeAdvancedCount = React.useMemo(() => {
    if (!tenantSelected) return 0
    let count = 0
    if (tab === 'signins') {
      if (advancedValue.signInStatus !== 'all') count++
      if (advancedValue.signInCA !== 'all') count++
      if (advancedValue.signInApp !== 'all') count++
      if (advancedValue.signInLocation !== 'all') count++
      if (advancedValue.signInIP !== 'all') count++
      if (advancedValue.signInClientApp !== 'all') count++
      if (advancedValue.signInOS !== 'all') count++
      if (advancedValue.signInRiskLevel !== 'all') count++
    } else {
      if (advancedValue.auditResult !== 'all') count++
      if (advancedValue.auditActivity !== 'all') count++
      if (advancedValue.auditCategory !== 'all') count++
      if (advancedValue.auditService !== 'all') count++
      if (advancedValue.auditActor !== 'all') count++
      if (advancedValue.auditTargetType !== 'all') count++
    }
    return count
  }, [tenantSelected, tab, advancedValue])

  // Build active chips
  const chips = React.useMemo(() => {
    if (!tenantSelected) return []
    const list: Array<{ id: string; label: string; onClear: () => void }> = []

    if (value.userUpn !== 'all') {
      const uLabel =
        users.find((u) => u.upn === value.userUpn)?.label || value.userUpn
      list.push({
        id: 'user',
        label: `User: ${uLabel.split(' (')[0]}`,
        onClear: () => onChange({ ...value, userUpn: 'all' }),
      })
    }

    if (value.search.trim()) {
      list.push({
        id: 'search',
        label: `Search: "${value.search.trim()}"`,
        onClear: () => onChange({ ...value, search: '' }),
      })
    }

    if (tab === 'signins') {
      if (advancedValue.signInStatus !== 'all') {
        list.push({
          id: 'signInStatus',
          label: `Status: ${advancedValue.signInStatus}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, signInStatus: 'all' }),
        })
      }
      if (advancedValue.signInCA !== 'all') {
        list.push({
          id: 'signInCA',
          label: `CA: ${advancedValue.signInCA}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, signInCA: 'all' }),
        })
      }
      if (advancedValue.signInApp !== 'all') {
        list.push({
          id: 'signInApp',
          label: `App: ${advancedValue.signInApp}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, signInApp: 'all' }),
        })
      }
      if (advancedValue.signInLocation !== 'all') {
        list.push({
          id: 'signInLocation',
          label: `Location: ${advancedValue.signInLocation}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, signInLocation: 'all' }),
        })
      }
      if (advancedValue.signInIP !== 'all') {
        list.push({
          id: 'signInIP',
          label: `IP: ${advancedValue.signInIP}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, signInIP: 'all' }),
        })
      }
      if (advancedValue.signInClientApp !== 'all') {
        list.push({
          id: 'signInClientApp',
          label: `Client: ${advancedValue.signInClientApp}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, signInClientApp: 'all' }),
        })
      }
      if (advancedValue.signInOS !== 'all') {
        list.push({
          id: 'signInOS',
          label: `OS: ${advancedValue.signInOS}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, signInOS: 'all' }),
        })
      }
      if (advancedValue.signInRiskLevel !== 'all') {
        list.push({
          id: 'signInRiskLevel',
          label: `Risk: ${advancedValue.signInRiskLevel}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, signInRiskLevel: 'all' }),
        })
      }
    } else {
      if (advancedValue.auditResult !== 'all') {
        list.push({
          id: 'auditResult',
          label: `Result: ${advancedValue.auditResult}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, auditResult: 'all' }),
        })
      }
      if (advancedValue.auditActivity !== 'all') {
        list.push({
          id: 'auditActivity',
          label: `Activity: ${advancedValue.auditActivity}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, auditActivity: 'all' }),
        })
      }
      if (advancedValue.auditCategory !== 'all') {
        list.push({
          id: 'auditCategory',
          label: `Category: ${advancedValue.auditCategory}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, auditCategory: 'all' }),
        })
      }
      if (advancedValue.auditService !== 'all') {
        list.push({
          id: 'auditService',
          label: `Service: ${advancedValue.auditService}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, auditService: 'all' }),
        })
      }
      if (advancedValue.auditActor !== 'all') {
        list.push({
          id: 'auditActor',
          label: `Actor: ${advancedValue.auditActor}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, auditActor: 'all' }),
        })
      }
      if (advancedValue.auditTargetType !== 'all') {
        list.push({
          id: 'auditTargetType',
          label: `Target Type: ${advancedValue.auditTargetType}`,
          onClear: () =>
            onAdvancedChange({ ...advancedValue, auditTargetType: 'all' }),
        })
      }
    }

    return list
  }, [
    tenantSelected,
    value,
    advancedValue,
    tab,
    users,
    onChange,
    onAdvancedChange,
  ])

  function handleClearAllFilters() {
    onChange({ ...value, userUpn: 'all', search: '' })
    if (tab === 'signins') {
      onAdvancedChange({
        ...advancedValue,
        signInStatus: 'all',
        signInCA: 'all',
        signInApp: 'all',
        signInLocation: 'all',
        signInIP: 'all',
        signInClientApp: 'all',
        signInOS: 'all',
        signInRiskLevel: 'all',
      })
    } else {
      onAdvancedChange({
        ...advancedValue,
        auditResult: 'all',
        auditActivity: 'all',
        auditCategory: 'all',
        auditService: 'all',
        auditActor: 'all',
        auditTargetType: 'all',
      })
    }
  }

  function handleClearTabAdvancedFilters() {
    if (tab === 'signins') {
      onAdvancedChange({
        ...advancedValue,
        signInStatus: 'all',
        signInCA: 'all',
        signInApp: 'all',
        signInLocation: 'all',
        signInIP: 'all',
        signInClientApp: 'all',
        signInOS: 'all',
        signInRiskLevel: 'all',
      })
    } else {
      onAdvancedChange({
        ...advancedValue,
        auditResult: 'all',
        auditActivity: 'all',
        auditCategory: 'all',
        auditService: 'all',
        auditActor: 'all',
        auditTargetType: 'all',
      })
    }
  }

  return (
    <div className="space-y-3">
      {/* Primary Control Bar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Tenant dropdown */}
        <select
          className="h-10 rounded-md border bg-background px-3 text-sm min-w-[200px]"
          value={value.tenantId}
          onChange={(e) => {
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

        {/* Users dropdown */}
        <select
          className="h-10 rounded-md border bg-background px-3 text-sm min-w-[160px]"
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

        {/* Date range dropdown */}
        <select
          className="h-10 rounded-md border bg-background px-3 text-sm min-w-[140px]"
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

        {/* Custom date range inputs */}
        {isCustom && (
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              className="h-10 rounded-md border bg-background px-2.5 text-xs"
              value={value.dateFrom}
              onChange={(e) => onChange({ ...value, dateFrom: e.target.value })}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="date"
              className="h-10 rounded-md border bg-background px-2.5 text-xs"
              value={value.dateTo}
              onChange={(e) => onChange({ ...value, dateTo: e.target.value })}
            />
          </div>
        )}

        {/* Search input */}
        <div className="flex-1 min-w-[200px]">
          <Input
            value={value.search}
            onChange={(e) => onChange({ ...value, search: e.target.value })}
            placeholder={
              tenantSelected
                ? 'Search user, app, IP, action…'
                : 'Select a tenant to search…'
            }
            disabled={!tenantSelected}
          />
        </div>

        {/* Action Buttons: Filters, Export CSV, Reset */}
        <div className="flex items-center gap-2">
          {/* Filters Toggle Button */}
          <div className="relative">
            <Button
              type="button"
              variant={activeAdvancedCount > 0 ? 'default' : 'outline'}
              disabled={!tenantSelected}
              onClick={() => setFilterPanelOpen((prev) => !prev)}
              className="h-10 gap-2 text-xs font-medium"
            >
              <Filter className="h-4 w-4" />
              <span>Filters</span>
              {activeAdvancedCount > 0 ? (
                <Badge
                  variant="secondary"
                  className="ml-0.5 h-5 px-1.5 min-w-[20px] rounded-full text-[10px] bg-background text-foreground"
                >
                  {activeAdvancedCount}
                </Badge>
              ) : null}
            </Button>

            {/* Advanced Filters Popover Panel */}
            <AdvancedFilterPanel
              tab={tab}
              open={filterPanelOpen}
              onClose={() => setFilterPanelOpen(false)}
              value={advancedValue}
              onChange={onAdvancedChange}
              onClearTabFilters={handleClearTabAdvancedFilters}
              options={options}
            />
          </div>

          {/* Export CSV Button */}
          <Button
            type="button"
            variant="outline"
            disabled={!tenantSelected || matchingCount === 0 || isExporting}
            onClick={onExportCsv}
            className="h-10 gap-2 text-xs font-medium"
            title={
              !tenantSelected
                ? 'Select a tenant to export'
                : matchingCount === 0
                  ? 'No matching events to export'
                  : 'Export matching events to CSV'
            }
          >
            {isExporting ? (
              <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            <span>Export CSV</span>
          </Button>

          {/* Reset Button */}
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setFilterPanelOpen(false)
              onReset()
            }}
            className="h-10 text-xs font-medium"
            title="Reset search, filters, tenant and date defaults"
          >
            Reset
          </Button>
        </div>
      </div>

      {/* Active Filter Chips */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
          <span className="text-muted-foreground font-medium mr-1">
            Active filters ({chips.length}):
          </span>
          {chips.map((chip) => (
            <span
              key={chip.id}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 text-xs font-medium"
            >
              <span>{chip.label}</span>
              <button
                type="button"
                onClick={chip.onClear}
                className="text-slate-400 hover:text-slate-900 dark:hover:text-white rounded p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                aria-label={`Remove filter ${chip.label}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClearAllFilters}
            className="h-7 text-xs text-muted-foreground hover:text-foreground gap-1 px-2"
          >
            <RotateCcw className="h-3 w-3" />
            Clear all filters
          </Button>
        </div>
      )}
    </div>
  )
}
