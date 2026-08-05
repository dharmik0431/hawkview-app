'use client'

import * as React from 'react'
import {
  Search,
  Filter,
  RotateCcw,
  X,
  Building2,
  Shield,
  User,
  Server,
  MapPin,
  Clock,
  Calendar as CalendarIcon,
  AlertCircle,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ChangeCategory, ChangeSeverity, ChangeSource } from '../data/change-types'
import {
  TimeWindowValue,
  QuickRange,
  getQuickRangeDates,
  parseISOOrLocal,
} from './time-window-picker'

const CATEGORIES: ChangeCategory[] = [
  'Roles',
  'MFA',
  'Conditional Access',
  'Apps',
  'Licenses',
  'Users',
  'Groups',
  'Devices',
  'Passwords',
  'Sign-ins',
]

const SEVERITIES: ChangeSeverity[] = ['High', 'Medium', 'Low']
const SOURCES: ChangeSource[] = ['Entra', 'M365', 'Unknown']

export type ToolbarFilterState = {
  tenant: string // "all" or tenantId
  search: string
  severity: 'All' | ChangeSeverity
  categories: ChangeCategory[]
  source: 'All' | ChangeSource
  actorFilter: string
  targetFilter: string
  locationFilter: string
}

interface InvestigationToolbarProps {
  tenants: { id: string; name: string }[]
  value: ToolbarFilterState
  onChange: (next: ToolbarFilterState) => void
  timeWindow: TimeWindowValue
  onChangeTimeWindow: (next: TimeWindowValue) => void
  onReset: () => void
}

function formatDateInput(d: Date): string {
  const year = d.getFullYear()
  const month = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatTimeInput(d: Date): string {
  const hours = d.getHours().toString().padStart(2, '0')
  const minutes = d.getMinutes().toString().padStart(2, '0')
  return `${hours}:${minutes}`
}

function getRangeLabel(range: QuickRange): string {
  switch (range) {
    case '1h':
      return 'Last hour'
    case '6h':
      return 'Last 6 hours'
    case '24h':
      return 'Last 24 hours'
    case '3d':
      return 'Last 3 days'
    case '7d':
      return 'Last 7 days'
    case 'custom':
      return 'Custom range'
  }
}

export function InvestigationToolbar({
  tenants,
  value,
  onChange,
  timeWindow,
  onChangeTimeWindow,
  onReset,
}: InvestigationToolbarProps) {
  const [showFiltersPanel, setShowFiltersPanel] = React.useState(false)
  const [showCustomModal, setShowCustomModal] = React.useState(false)

  // Custom modal inputs
  const [customFromDate, setCustomFromDate] = React.useState('')
  const [customFromTime, setCustomFromTime] = React.useState('')
  const [customToDate, setCustomToDate] = React.useState('')
  const [customToTime, setCustomToTime] = React.useState('')

  // Detected timezone string
  const timeZoneName = React.useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
      return 'UTC'
    }
  }, [])

  // Calculate active filters count (excluding default values)
  const activeCount = React.useMemo(() => {
    let count = 0
    if (value.tenant !== 'all') count++
    if (value.severity !== 'All') count++
    if (value.categories.length > 0) count += value.categories.length
    if (value.source !== 'All') count++
    if (value.actorFilter.trim()) count++
    if (value.targetFilter.trim()) count++
    if (value.locationFilter.trim()) count++
    return count
  }, [value])

  const activeTenantName = React.useMemo(() => {
    if (value.tenant === 'all') return null
    return tenants.find((t) => t.id === value.tenant)?.name ?? value.tenant
  }, [value.tenant, tenants])

  // Pre-fill custom modal when opened
  const openCustomModal = React.useCallback(() => {
    const fromD = parseISOOrLocal(timeWindow.from)
    const toD = parseISOOrLocal(timeWindow.to)

    setCustomFromDate(formatDateInput(fromD))
    setCustomFromTime(formatTimeInput(fromD))
    setCustomToDate(formatDateInput(toD))
    setCustomToTime(formatTimeInput(toD))

    setShowCustomModal(true)
  }, [timeWindow.from, timeWindow.to])

  // Handle Quick Range selection
  const handleRangeSelect = (range: QuickRange) => {
    if (range === 'custom') {
      openCustomModal()
      return
    }

    const { from, to } = getQuickRangeDates(range, timeWindow.useUtc)
    onChangeTimeWindow({
      ...timeWindow,
      quickRange: range,
      from,
      to,
    })
  }

  // Validate custom date range
  const customFromDateTime = React.useMemo(() => {
    if (!customFromDate || !customFromTime) return null
    return new Date(`${customFromDate}T${customFromTime}`)
  }, [customFromDate, customFromTime])

  const customToDateTime = React.useMemo(() => {
    if (!customToDate || !customToTime) return null
    return new Date(`${customToDate}T${customToTime}`)
  }, [customToDate, customToTime])

  const isCustomValid = React.useMemo(() => {
    if (!customFromDateTime || !customToDateTime) return false
    return customToDateTime.getTime() >= customFromDateTime.getTime()
  }, [customFromDateTime, customToDateTime])

  const handleApplyCustom = () => {
    if (!isCustomValid || !customFromDateTime || !customToDateTime) return

    onChangeTimeWindow({
      ...timeWindow,
      quickRange: 'custom',
      from: customFromDateTime.toISOString(),
      to: customToDateTime.toISOString(),
    })
    setShowCustomModal(false)
  }

  return (
    <div className="space-y-3">
      {/* Primary Toolbar Row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Tenant Selector */}
        <div className="relative shrink-0">
          <select
            aria-label="Filter by tenant"
            className="h-9 rounded-md border border-input bg-background pl-8 pr-3 text-xs font-medium shadow-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={value.tenant}
            onChange={(e) => onChange({ ...value, tenant: e.target.value })}
          >
            <option value="all">All tenants</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <Building2 className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        </div>

        {/* Search Field */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            aria-label="Search events"
            placeholder="Search actor, target, policy, app, IP..."
            className="h-9 pl-8 text-xs"
            value={value.search}
            onChange={(e) => onChange({ ...value, search: e.target.value })}
          />
          {value.search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onChange({ ...value, search: '' })}
              className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Time Range Selector */}
        <div className="relative shrink-0 flex items-center">
          <select
            aria-label="Select investigation time range"
            className="h-9 rounded-md border border-input bg-background pl-8 pr-3 text-xs font-medium shadow-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={timeWindow.quickRange}
            onChange={(e) => handleRangeSelect(e.target.value as QuickRange)}
          >
            <option value="1h">Last hour</option>
            <option value="6h">Last 6 hours</option>
            <option value="24h">Last 24 hours</option>
            <option value="3d">Last 3 days</option>
            <option value="7d">Last 7 days</option>
            <option value="custom">Custom range...</option>
          </select>
          <Clock className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />

          {/* Button to reopen custom dialog if custom is active */}
          {timeWindow.quickRange === 'custom' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={openCustomModal}
              className="ml-1 h-9 px-2 text-xs text-muted-foreground hover:text-foreground"
              title="Edit custom time range"
            >
              <CalendarIcon className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {/* More Filters Button */}
        <Button
          type="button"
          variant={showFiltersPanel || activeCount > 0 ? 'secondary' : 'outline'}
          size="sm"
          className="h-9 gap-1.5 text-xs font-medium"
          onClick={() => setShowFiltersPanel((v) => !v)}
        >
          <Filter className="h-3.5 w-3.5" />
          <span>More filters</span>
          {activeCount > 0 && (
            <span className="ml-0.5 rounded-full bg-primary px-1.5 py-0.2 text-[10px] font-bold text-primary-foreground">
              {activeCount}
            </span>
          )}
        </Button>

        {/* Reset Button */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-9 gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={onReset}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          <span>Reset</span>
        </Button>
      </div>

      {/* Expanded "More filters" panel */}
      {showFiltersPanel && (
        <div className="rounded-xl border border-border bg-card p-4 shadow-xs space-y-4 animate-in fade-in-50 zoom-in-95">
          <div className="flex items-center justify-between border-b border-border/60 pb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
              Filter Investigation Events
            </span>
            <button
              type="button"
              onClick={() => setShowFiltersPanel(false)}
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              Done
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {/* Severity / Result */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <Shield className="h-3.5 w-3.5" /> Severity / Result
              </label>
              <select
                className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs"
                value={value.severity}
                onChange={(e) => onChange({ ...value, severity: e.target.value as any })}
              >
                <option value="All">All Severities</option>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            {/* Source */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <Server className="h-3.5 w-3.5" /> Event Source
              </label>
              <select
                className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs"
                value={value.source}
                onChange={(e) => onChange({ ...value, source: e.target.value as any })}
              >
                <option value="All">All Sources</option>
                {SOURCES.map((src) => (
                  <option key={src} value={src}>{src}</option>
                ))}
              </select>
            </div>

            {/* Actor Filter */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <User className="h-3.5 w-3.5" /> Specific Actor
              </label>
              <Input
                placeholder="e.g. admin@tenant.com"
                className="h-8 text-xs"
                value={value.actorFilter}
                onChange={(e) => onChange({ ...value, actorFilter: e.target.value })}
              />
            </div>

            {/* Affected Resource */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Affected Resource / Target
              </label>
              <Input
                placeholder="e.g. Policy name, User ID, App"
                className="h-8 text-xs"
                value={value.targetFilter}
                onChange={(e) => onChange({ ...value, targetFilter: e.target.value })}
              />
            </div>

            {/* Location / IP */}
            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" /> Location / IP Address
              </label>
              <Input
                placeholder="e.g. City, Country, or IP address (192.168...)"
                className="h-8 text-xs"
                value={value.locationFilter}
                onChange={(e) => onChange({ ...value, locationFilter: e.target.value })}
              />
            </div>
          </div>

          {/* Event Categories Pills */}
          <div className="space-y-2 border-t border-border/60 pt-3">
            <span className="text-xs font-medium text-muted-foreground">Categories</span>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((c) => {
                const active = value.categories.includes(c)
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      const next = active
                        ? value.categories.filter((x) => x !== c)
                        : [...value.categories, c]
                      onChange({ ...value, categories: next })
                    }}
                    className="focus:outline-none focus:ring-1 focus:ring-ring rounded-full"
                  >
                    <Badge
                      variant={active ? 'default' : 'outline'}
                      className={cn(
                        'cursor-pointer text-xs transition-colors',
                        active ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-accent'
                      )}
                    >
                      {c}
                    </Badge>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Active Filter Chips */}
      {(activeCount > 0 || value.search.trim() !== '') && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-xs font-medium text-muted-foreground">Active filters:</span>

          {activeTenantName && (
            <Badge variant="secondary" className="gap-1 text-[11px] font-normal">
              Tenant: {activeTenantName}
              <button
                type="button"
                onClick={() => onChange({ ...value, tenant: 'all' })}
                className="hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}

          {value.search.trim() !== '' && (
            <Badge variant="secondary" className="gap-1 text-[11px] font-normal">
              Search: &quot;{value.search}&quot;
              <button
                type="button"
                onClick={() => onChange({ ...value, search: '' })}
                className="hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}

          {value.severity !== 'All' && (
            <Badge variant="secondary" className="gap-1 text-[11px] font-normal">
              Severity: {value.severity}
              <button
                type="button"
                onClick={() => onChange({ ...value, severity: 'All' })}
                className="hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}

          {value.source !== 'All' && (
            <Badge variant="secondary" className="gap-1 text-[11px] font-normal">
              Source: {value.source}
              <button
                type="button"
                onClick={() => onChange({ ...value, source: 'All' })}
                className="hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}

          {value.actorFilter.trim() !== '' && (
            <Badge variant="secondary" className="gap-1 text-[11px] font-normal">
              Actor: {value.actorFilter}
              <button
                type="button"
                onClick={() => onChange({ ...value, actorFilter: '' })}
                className="hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}

          {value.targetFilter.trim() !== '' && (
            <Badge variant="secondary" className="gap-1 text-[11px] font-normal">
              Target: {value.targetFilter}
              <button
                type="button"
                onClick={() => onChange({ ...value, targetFilter: '' })}
                className="hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}

          {value.locationFilter.trim() !== '' && (
            <Badge variant="secondary" className="gap-1 text-[11px] font-normal">
              Location: {value.locationFilter}
              <button
                type="button"
                onClick={() => onChange({ ...value, locationFilter: '' })}
                className="hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}

          {value.categories.map((cat) => (
            <Badge key={cat} variant="secondary" className="gap-1 text-[11px] font-normal">
              Category: {cat}
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...value,
                    categories: value.categories.filter((c) => c !== cat),
                  })
                }
                className="hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={onReset}
          >
            Clear all
          </Button>
        </div>
      )}

      {/* Simple Custom Range Popover Dialog */}
      {showCustomModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs animate-in fade-in-50"
          role="dialog"
          aria-modal="true"
          aria-label="Custom time range popover"
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                <CalendarIcon className="h-4 w-4 text-primary" />
                <span>Custom Time Range</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowCustomModal(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              {/* From Date & Time */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-foreground">From</label>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="date"
                    aria-label="From date"
                    className="h-8 text-xs"
                    value={customFromDate}
                    onChange={(e) => setCustomFromDate(e.target.value)}
                  />
                  <Input
                    type="time"
                    aria-label="From time"
                    className="h-8 text-xs"
                    value={customFromTime}
                    onChange={(e) => setCustomFromTime(e.target.value)}
                  />
                </div>
              </div>

              {/* To Date & Time */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-foreground">To</label>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="date"
                    aria-label="To date"
                    className="h-8 text-xs"
                    value={customToDate}
                    onChange={(e) => setCustomToDate(e.target.value)}
                  />
                  <Input
                    type="time"
                    aria-label="To time"
                    className="h-8 text-xs"
                    value={customToTime}
                    onChange={(e) => setCustomToTime(e.target.value)}
                  />
                </div>
              </div>

              {/* Timezone supporting text */}
              <div className="text-[11px] text-muted-foreground">
                Detected time zone: <span className="font-medium text-foreground">{timeZoneName}</span>
              </div>

              {/* Validation Warning */}
              {!isCustomValid && (
                <div className="flex items-center gap-1.5 text-xs text-destructive font-medium pt-1">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>Invalid range: &quot;To&quot; date and time cannot be earlier than &quot;From&quot;.</span>
                </div>
              )}
            </div>

            {/* Footer Buttons */}
            <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setShowCustomModal(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-8 text-xs"
                disabled={!isCustomValid}
                onClick={handleApplyCustom}
              >
                Apply
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
