'use client'

import * as React from 'react'
import {
  Calendar as CalendarIcon,
  Clock,
  ChevronLeft,
  ChevronRight,
  Globe,
  AlertCircle,
  Check,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type QuickRange = '1h' | '6h' | '24h' | '3d' | '7d' | 'custom'

export type TimeWindowValue = {
  from: string // YYYY-MM-DDTHH:mm string or ISO string
  to: string   // YYYY-MM-DDTHH:mm string or ISO string
  quickRange: QuickRange
  useUtc: boolean
  is12Hour: boolean
}

interface TimeWindowPickerProps {
  value: TimeWindowValue
  onChange: (next: TimeWindowValue) => void
}

// Helpers for Date & Time conversions
function pad(n: number) {
  return n.toString().padStart(2, '0')
}

export function parseISOOrLocal(val: string): Date {
  if (!val) return new Date()
  const d = new Date(val)
  return isNaN(d.getTime()) ? new Date() : d
}

export function formatYMD(date: Date, useUtc = false): string {
  if (useUtc) {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function formatHM(date: Date, useUtc = false, is12Hour = true): { hour: number; minute: number; ampm: 'AM' | 'PM' } {
  const h = useUtc ? date.getUTCHours() : date.getHours()
  const m = useUtc ? date.getUTCMinutes() : date.getMinutes()

  if (is12Hour) {
    const ampm = h >= 12 ? 'PM' : 'AM'
    const hour12 = h % 12 === 0 ? 12 : h % 12
    return { hour: hour12, minute: m, ampm }
  }
  return { hour: h, minute: m, ampm: 'AM' }
}

export function buildDateTimeString(ymd: string, hour: number, minute: number, ampm: 'AM' | 'PM', is12Hour: boolean, useUtc: boolean): string {
  let h24 = hour
  if (is12Hour) {
    if (ampm === 'PM' && hour < 12) h24 = hour + 12
    if (ampm === 'AM' && hour === 12) h24 = 0
  }
  const timePart = `${pad(h24)}:${pad(minute)}`
  const localStr = `${ymd}T${timePart}`

  if (useUtc) {
    const d = new Date(`${ymd}T${timePart}:00Z`)
    return d.toISOString().slice(0, 16)
  }
  return localStr
}

export function getQuickRangeDates(range: QuickRange, useUtc = false): { from: string; to: string } {
  const now = new Date()
  const to = now
  let from = new Date(now)

  switch (range) {
    case '1h':
      from = new Date(now.getTime() - 60 * 60 * 1000)
      break
    case '6h':
      from = new Date(now.getTime() - 6 * 60 * 60 * 1000)
      break
    case '24h':
      from = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      break
    case '3d':
      from = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
      break
    case '7d':
      from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      break
    default:
      from = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  }

  const formatStr = (d: Date) => {
    if (useUtc) {
      return d.toISOString().slice(0, 16)
    }
    const offset = d.getTimezoneOffset() * 60_000
    return new Date(d.getTime() - offset).toISOString().slice(0, 16)
  }

  return { from: formatStr(from), to: formatStr(to) }
}

export function formatReadableRange(fromStr: string, toStr: string, useUtc: boolean): string {
  const fromD = parseISOOrLocal(fromStr)
  const toD = parseISOOrLocal(toStr)

  const opts: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: useUtc ? 'UTC' : undefined,
  }

  const fromFmt = new Intl.DateTimeFormat('en-US', opts).format(fromD)
  const toFmt = new Intl.DateTimeFormat('en-US', opts).format(toD)

  const diffMs = toD.getTime() - fromD.getTime()
  if (diffMs <= 0) return `${fromFmt} – ${toFmt}`

  const diffHours = Math.round(diffMs / (1000 * 60 * 60))
  let durationLabel = `${diffHours}h`
  if (diffHours >= 24 && diffHours % 24 === 0) {
    durationLabel = `${diffHours / 24}d`
  } else if (diffHours < 1) {
    const diffMins = Math.round(diffMs / (1000 * 60))
    durationLabel = `${diffMins}m`
  }

  return `${fromFmt} – ${toFmt} (${durationLabel})`
}

// Custom Date Picker Calendar Popover
function CustomDatePicker({
  valueYMD,
  onChangeYMD,
  minYMD,
  maxYMD,
  label,
  id,
}: {
  valueYMD: string
  onChangeYMD: (newYMD: string) => void
  minYMD?: string
  maxYMD?: string
  label: string
  id: string
}) {
  const [isOpen, setIsOpen] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)

  const initialDate = React.useMemo(() => {
    const parts = valueYMD.split('-')
    if (parts.length === 3) {
      return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
    }
    return new Date()
  }, [valueYMD])

  const [viewYear, setViewYear] = React.useState(initialDate.getFullYear())
  const [viewMonth, setViewMonth] = React.useState(initialDate.getMonth())

  React.useEffect(() => {
    const parts = valueYMD.split('-')
    if (parts.length === 3) {
      setViewYear(parseInt(parts[0]))
      setViewMonth(parseInt(parts[1]) - 1)
    }
  }, [valueYMD])

  // Close popover when clicking outside
  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const handlePrevMonth = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (viewMonth === 0) {
      setViewMonth(11)
      setViewYear((y) => y - 1)
    } else {
      setViewMonth((m) => m - 1)
    }
  }

  const handleNextMonth = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (viewMonth === 11) {
      setViewMonth(0)
      setViewYear((y) => y + 1)
    } else {
      setViewMonth((m) => m + 1)
    }
  }

  // Days matrix for current month view
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay()

  const todayStr = React.useMemo(() => {
    const t = new Date()
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
  }, [])

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ]

  const formattedDisplay = React.useMemo(() => {
    const parts = valueYMD.split('-')
    if (parts.length === 3) {
      const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(d)
    }
    return valueYMD
  }, [valueYMD])

  return (
    <div className="relative inline-block w-full" ref={containerRef}>
      <button
        type="button"
        id={id}
        aria-label={label}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium shadow-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isOpen && "border-primary ring-1 ring-primary"
        )}
      >
        <span className="flex items-center gap-1.5 truncate">
          <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="truncate">{formattedDisplay}</span>
        </span>
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label={`${label} calendar`}
          className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg animate-in fade-in-50 zoom-in-95"
        >
          {/* Month Header */}
          <div className="flex items-center justify-between gap-1 pb-2">
            <button
              type="button"
              onClick={handlePrevMonth}
              aria-label="Previous month"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs font-semibold">
              {monthNames[viewMonth]} {viewYear}
            </span>
            <button
              type="button"
              onClick={handleNextMonth}
              aria-label="Next month"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Days of week header */}
          <div className="grid grid-cols-7 text-center text-[10px] font-medium text-muted-foreground py-1">
            <span>Su</span>
            <span>Mo</span>
            <span>Tu</span>
            <span>We</span>
            <span>Th</span>
            <span>Fr</span>
            <span>Sa</span>
          </div>

          {/* Days Grid */}
          <div className="grid grid-cols-7 gap-1 pt-1 text-xs">
            {Array.from({ length: firstDayOfWeek }).map((_, i) => (
              <div key={`empty-${i}`} />
            ))}

            {Array.from({ length: daysInMonth }).map((_, i) => {
              const dayNum = i + 1
              const dayYMD = `${viewYear}-${pad(viewMonth + 1)}-${pad(dayNum)}`
              const isSelected = dayYMD === valueYMD
              const isToday = dayYMD === todayStr
              const isDisabled = Boolean((minYMD && dayYMD < minYMD) || (maxYMD && dayYMD > maxYMD))

              return (
                <button
                  key={dayYMD}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => {
                    onChangeYMD(dayYMD)
                    setIsOpen(false)
                  }}
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md transition-colors text-xs font-normal",
                    isSelected
                      ? "bg-primary text-primary-foreground font-semibold"
                      : isToday
                      ? "border border-primary font-medium text-primary"
                      : "hover:bg-accent hover:text-accent-foreground text-foreground",
                    isDisabled && "opacity-30 pointer-events-none text-muted-foreground"
                  )}
                >
                  {dayNum}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// Custom Time Picker Component
function TimePickerInput({
  dateObj,
  onChangeTime,
  is12Hour,
  useUtc,
  label,
  id,
}: {
  dateObj: Date
  onChangeTime: (hour: number, minute: number, ampm: 'AM' | 'PM') => void
  is12Hour: boolean
  useUtc: boolean
  label: string
  id: string
}) {
  const { hour, minute, ampm } = formatHM(dateObj, useUtc, is12Hour)

  const hoursList = is12Hour
    ? [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    : Array.from({ length: 24 }).map((_, i) => i)

  const minutesList = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]

  return (
    <div className="flex items-center gap-1">
      {/* Hour select */}
      <select
        id={`${id}-hour`}
        aria-label={`${label} hour`}
        value={hour}
        onChange={(e) => onChangeTime(parseInt(e.target.value), minute, ampm)}
        className="h-9 rounded-md border border-input bg-background px-1.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {hoursList.map((h) => (
          <option key={h} value={h}>
            {is12Hour ? h : pad(h)}
          </option>
        ))}
      </select>

      <span className="text-xs font-bold text-muted-foreground">:</span>

      {/* Minute select */}
      <select
        id={`${id}-minute`}
        aria-label={`${label} minute`}
        value={minutesList.includes(minute) ? minute : minute}
        onChange={(e) => onChangeTime(hour, parseInt(e.target.value), ampm)}
        className="h-9 rounded-md border border-input bg-background px-1.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {!minutesList.includes(minute) && (
          <option value={minute}>{pad(minute)}</option>
        )}
        {minutesList.map((m) => (
          <option key={m} value={m}>
            {pad(m)}
          </option>
        ))}
      </select>

      {/* AM/PM toggle when in 12h mode */}
      {is12Hour && (
        <select
          id={`${id}-ampm`}
          aria-label={`${label} AM/PM`}
          value={ampm}
          onChange={(e) => onChangeTime(hour, minute, e.target.value as 'AM' | 'PM')}
          className="h-9 rounded-md border border-input bg-background px-1.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </select>
      )}

      {/* Shortcuts */}
      <div className="flex items-center gap-0.5 ml-1">
        <button
          type="button"
          title="Start of day (00:00)"
          onClick={() => onChangeTime(is12Hour ? 12 : 0, 0, 'AM')}
          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground border border-border"
        >
          00:00
        </button>
        <button
          type="button"
          title="Current time"
          onClick={() => {
            const now = new Date()
            const { hour: nh, minute: nm, ampm: na } = formatHM(now, useUtc, is12Hour)
            onChangeTime(nh, nm, na)
          }}
          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground border border-border"
        >
          Now
        </button>
        <button
          type="button"
          title="End of day (23:59)"
          onClick={() => onChangeTime(is12Hour ? 11 : 23, 59, 'PM')}
          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground border border-border"
        >
          23:59
        </button>
      </div>
    </div>
  )
}

export function TimeWindowPicker({ value, onChange }: TimeWindowPickerProps) {
  const fromDateObj = parseISOOrLocal(value.from)
  const toDateObj = parseISOOrLocal(value.to)

  const fromYMD = formatYMD(fromDateObj, value.useUtc)
  const toYMD = formatYMD(toDateObj, value.useUtc)

  // Validation
  const isValidRange = toDateObj.getTime() >= fromDateObj.getTime()

  // Resolved timezone display
  const tzName = React.useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local Time'
    } catch {
      return 'Local Time'
    }
  }, [])

  const handleQuickRangeSelect = (range: QuickRange) => {
    if (range === 'custom') {
      onChange({ ...value, quickRange: 'custom' })
      return
    }
    const { from, to } = getQuickRangeDates(range, value.useUtc)
    onChange({
      ...value,
      from,
      to,
      quickRange: range,
    })
  }

  const handleFromDateChange = (newYMD: string) => {
    const { hour, minute, ampm } = formatHM(fromDateObj, value.useUtc, value.is12Hour)
    const newFrom = buildDateTimeString(newYMD, hour, minute, ampm, value.is12Hour, value.useUtc)
    onChange({
      ...value,
      from: newFrom,
      quickRange: 'custom',
    })
  }

  const handleFromTimeChange = (hour: number, minute: number, ampm: 'AM' | 'PM') => {
    const newFrom = buildDateTimeString(fromYMD, hour, minute, ampm, value.is12Hour, value.useUtc)
    onChange({
      ...value,
      from: newFrom,
      quickRange: 'custom',
    })
  }

  const handleToDateChange = (newYMD: string) => {
    const { hour, minute, ampm } = formatHM(toDateObj, value.useUtc, value.is12Hour)
    const newTo = buildDateTimeString(newYMD, hour, minute, ampm, value.is12Hour, value.useUtc)
    onChange({
      ...value,
      to: newTo,
      quickRange: 'custom',
    })
  }

  const handleToTimeChange = (hour: number, minute: number, ampm: 'AM' | 'PM') => {
    const newTo = buildDateTimeString(toYMD, hour, minute, ampm, value.is12Hour, value.useUtc)
    onChange({
      ...value,
      to: newTo,
      quickRange: 'custom',
    })
  }

  const toggleUtc = () => {
    const nextUtc = !value.useUtc
    const { from, to } = getQuickRangeDates(value.quickRange, nextUtc)
    onChange({
      ...value,
      useUtc: nextUtc,
      from: value.quickRange !== 'custom' ? from : value.from,
      to: value.quickRange !== 'custom' ? to : value.to,
    })
  }

  const toggle12Hour = () => {
    onChange({
      ...value,
      is12Hour: !value.is12Hour,
    })
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs space-y-3">
      {/* Top row: Section title, Quick ranges & Timezone indicator */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary shrink-0" />
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
            Investigation Window
          </span>
        </div>

        {/* Quick Range choices */}
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5 text-xs">
          {[
            { id: '1h', label: '1h' },
            { id: '6h', label: '6h' },
            { id: '24h', label: '24h' },
            { id: '3d', label: '3d' },
            { id: '7d', label: '7d' },
            { id: 'custom', label: 'Custom' },
          ].map((item) => {
            const active = value.quickRange === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleQuickRangeSelect(item.id as QuickRange)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-all",
                  active
                    ? "bg-background text-foreground shadow-xs border border-border/80 font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                )}
              >
                {item.label}
              </button>
            )
          })}
        </div>

        {/* Timezone & 12h/24h controls */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={toggleUtc}
            title="Toggle UTC / Local Time"
            className="flex items-center gap-1 rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-accent"
          >
            <Globe className="h-3 w-3" />
            <span>{value.useUtc ? 'UTC' : tzName}</span>
          </button>

          <button
            type="button"
            onClick={toggle12Hour}
            title="Toggle 12-hour / 24-hour format"
            className="rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-accent"
          >
            {value.is12Hour ? '12h' : '24h'}
          </button>
        </div>
      </div>

      {/* From and To Date/Time Controls */}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* From Section */}
        <div className="space-y-1.5">
          <label htmlFor="from-date-input" className="block text-xs font-semibold text-foreground/80">
            From (Incident start)
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-36 shrink-0">
              <CustomDatePicker
                id="from-date-input"
                label="From date"
                valueYMD={fromYMD}
                onChangeYMD={handleFromDateChange}
                maxYMD={toYMD}
              />
            </div>
            <div className="flex-1 min-w-[170px]">
              <TimePickerInput
                id="from-time-input"
                label="From time"
                dateObj={fromDateObj}
                onChangeTime={handleFromTimeChange}
                is12Hour={value.is12Hour}
                useUtc={value.useUtc}
              />
            </div>
          </div>
        </div>

        {/* To Section */}
        <div className="space-y-1.5">
          <label htmlFor="to-date-input" className="block text-xs font-semibold text-foreground/80">
            To (Investigate through)
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-36 shrink-0">
              <CustomDatePicker
                id="to-date-input"
                label="To date"
                valueYMD={toYMD}
                onChangeYMD={handleToDateChange}
                minYMD={fromYMD}
              />
            </div>
            <div className="flex-1 min-w-[170px]">
              <TimePickerInput
                id="to-time-input"
                label="To time"
                dateObj={toDateObj}
                onChangeTime={handleToTimeChange}
                is12Hour={value.is12Hour}
                useUtc={value.useUtc}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Validation or Selected Range Summary */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
        {!isValidRange ? (
          <div className="flex items-center gap-1.5 font-medium text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
            <span>Invalid range: &quot;To&quot; date and time cannot be earlier than &quot;From&quot;.</span>
          </div>
        ) : (
          <div className="text-muted-foreground flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-emerald-600" />
            <span className="font-medium text-foreground">
              {formatReadableRange(value.from, value.to, value.useUtc)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
