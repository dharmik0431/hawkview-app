'use client'

import React, { useState, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  History,
  Calendar,
} from 'lucide-react'

export interface LicenseAuditEvent {
  id?: string
  rawId?: string
  timestamp?: string | number | Date
  date?: string | number | Date
  activity?:
    | 'Assigned'
    | 'Unassigned'
    | 'Product added'
    | 'Product removed'
    | string
  action?: string
  type?: string
  user?: string | { displayName?: string; email?: string; upn?: string }
  targetUser?: string
  license?: string | { name?: string; displayName?: string }
  skuName?: string
  performedBy?: string | { displayName?: string; name?: string; upn?: string }
  actor?: string | { displayName?: string; name?: string; upn?: string }
  status?: 'Successful' | 'Success' | 'Failed' | string
  result?: string
  isTenantLevel?: boolean
}

interface LicenseActivitySectionProps {
  bundle?: any
  events?: LicenseAuditEvent[]
}

type SortField = 'date' | 'activity' | 'user' | 'license' | 'performedBy'
type SortOrder = 'asc' | 'desc'

export default function LicenseActivitySection({
  bundle,
  events: eventsProp,
}: LicenseActivitySectionProps) {
  // Extract real audit events if present in bundle or props
  const rawEvents = useMemo(() => {
    if (Array.isArray(eventsProp)) return eventsProp
    if (Array.isArray(bundle?.licenseEvents)) return bundle.licenseEvents
    if (Array.isArray(bundle?.licenses?.events)) return bundle.licenses.events
    if (Array.isArray(bundle?.licenses?.activity))
      return bundle.licenses.activity
    if (Array.isArray(bundle?.licenses?.auditLogs))
      return bundle.licenses.auditLogs
    if (Array.isArray(bundle?.auditEvents)) return bundle.auditEvents
    if (Array.isArray(bundle?.auditLogs)) return bundle.auditLogs
    return null
  }, [eventsProp, bundle])

  const [searchQuery, setSearchQuery] = useState('')
  const [activityFilter, setActivityFilter] = useState<string>('all')
  const [dateFilter, setDateFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [sortField, setSortField] = useState<SortField>('date')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')

  // Helper to normalize event objects
  const parsedEvents = useMemo(() => {
    if (!rawEvents || rawEvents.length === 0) return []

    return rawEvents.map((evt: any, idx: number) => {
      const rawDate = evt.timestamp || evt.date || evt.createdAt || evt.time
      const parsedDate = rawDate ? new Date(rawDate) : new Date(0)
      const dateStr = !isNaN(parsedDate.getTime())
        ? parsedDate.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          })
        : 'Not synchronized'

      const rawAct = evt.activity || evt.action || evt.type || 'Assigned'
      let normalizedActivity = rawAct
      const actLower = String(rawAct).toLowerCase()
      if (actLower.includes('assign') && !actLower.includes('un')) {
        normalizedActivity = 'Assigned'
      } else if (
        actLower.includes('unassign') ||
        actLower.includes('remove_user')
      ) {
        normalizedActivity = 'Unassigned'
      } else if (
        actLower.includes('product_add') ||
        actLower.includes('added')
      ) {
        normalizedActivity = 'Product added'
      } else if (
        actLower.includes('product_remove') ||
        actLower.includes('removed')
      ) {
        normalizedActivity = 'Product removed'
      }

      const isTenantEvent =
        evt.isTenantLevel ||
        normalizedActivity === 'Product added' ||
        normalizedActivity === 'Product removed'

      // Target User info
      let userName = 'N/A'
      let userEmail = ''
      let userUpn = ''

      if (!isTenantEvent) {
        if (typeof evt.user === 'string' && evt.user.trim()) {
          userName = evt.user.trim()
        } else if (evt.user && typeof evt.user === 'object') {
          userName =
            evt.user.displayName || evt.user.name || evt.user.email || evt.user.upn || 'N/A'
          userEmail = evt.user.email || ''
          userUpn = evt.user.upn || ''
        } else if (evt.targetUser) {
          userName = evt.targetUser
        }
      }

      // License Name
      let licenseName = 'N/A'
      if (typeof evt.license === 'string' && evt.license.trim()) {
        licenseName = evt.license.trim()
      } else if (evt.license && typeof evt.license === 'object') {
        licenseName =
          evt.license.displayName || evt.license.name || 'N/A'
      } else if (evt.skuName) {
        licenseName = evt.skuName
      }

      // Performed By (Actor)
      let actorName = 'N/A'
      const rawActor = evt.performedBy || evt.actor || evt.initiatedBy
      if (typeof rawActor === 'string' && rawActor.trim()) {
        actorName = rawActor.trim()
      } else if (rawActor && typeof rawActor === 'object') {
        actorName =
          rawActor.displayName ||
          rawActor.name ||
          rawActor.upn ||
          rawActor.email ||
          'N/A'
      }

      // Status / Result
      const rawStatus = evt.status || evt.result || 'Successful'
      const isSuccess =
        String(rawStatus).toLowerCase().includes('success') ||
        String(rawStatus).toLowerCase() === 'ok'

      return {
        id: evt.id || evt.rawId || `evt-${idx}`,
        dateObj: parsedDate,
        dateDisplay: dateStr,
        activity: normalizedActivity,
        user: userName,
        userEmail,
        userUpn,
        license: licenseName,
        performedBy: actorName,
        status: isSuccess ? 'Successful' : String(rawStatus),
        isSuccess,
        isTenantEvent,
      }
    })
  }, [rawEvents])

  // Filter events
  const filteredEvents = useMemo(() => {
    if (parsedEvents.length === 0) return []

    const now = Date.now()

    return parsedEvents.filter((item: any) => {
      // Activity Filter
      if (activityFilter !== 'all' && item.activity !== activityFilter) {
        return false
      }

      // Date Filter
      if (dateFilter !== 'all') {
        const itemTime = item.dateObj.getTime()
        if (dateFilter === '24h' && now - itemTime > 24 * 60 * 60 * 1000)
          return false
        if (dateFilter === '7d' && now - itemTime > 7 * 24 * 60 * 60 * 1000)
          return false
        if (dateFilter === '30d' && now - itemTime > 30 * 24 * 60 * 60 * 1000)
          return false
      }

      // Result / Status Filter
      if (statusFilter === 'success' && !item.isSuccess) {
        return false
      }
      if (statusFilter === 'failure' && item.isSuccess) {
        return false
      }

      // Search Query (Search user, email, upn, activity, or license)
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim()
        const matchesUser =
          item.user.toLowerCase().includes(q) ||
          item.userEmail.toLowerCase().includes(q) ||
          item.userUpn.toLowerCase().includes(q)
        const matchesActor = item.performedBy.toLowerCase().includes(q)
        const matchesLicense = item.license.toLowerCase().includes(q)
        const matchesActivity = item.activity.toLowerCase().includes(q)
        if (
          !matchesUser &&
          !matchesActor &&
          !matchesLicense &&
          !matchesActivity
        ) {
          return false
        }
      }

      return true
    })
  }, [parsedEvents, activityFilter, dateFilter, statusFilter, searchQuery])

  // Sort events
  const sortedEvents = useMemo(() => {
    const list = [...filteredEvents]
    return list.sort((a, b) => {
      let cmp = 0
      if (sortField === 'date') {
        cmp = a.dateObj.getTime() - b.dateObj.getTime()
      } else if (sortField === 'activity') {
        cmp = a.activity.localeCompare(b.activity)
      } else if (sortField === 'user') {
        cmp = a.user.localeCompare(b.user)
      } else if (sortField === 'license') {
        cmp = a.license.localeCompare(b.license)
      } else if (sortField === 'performedBy') {
        cmp = a.performedBy.localeCompare(b.performedBy)
      }
      return sortOrder === 'asc' ? cmp : -cmp
    })
  }, [filteredEvents, sortField, sortOrder])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortOrder('desc') // default newest/descending
    }
  }

  // EMPTY STATE: If no real synchronized audit events exist in frontend response
  if (!rawEvents || rawEvents.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-12 text-center my-4 shadow-2xs">
        <div className="mx-auto h-10 w-10 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 mb-3">
          <History className="h-5 w-5" aria-hidden="true" />
        </div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          No license changes have been recorded yet.
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto leading-relaxed">
          License assignment history will appear here after audit-event
          synchronization is available.
        </p>
      </div>
    )
  }

  function SortableHeader({
    field,
    label,
  }: {
    field: SortField
    label: string
  }) {
    const active = sortField === field
    const ariaSort = active
      ? sortOrder === 'asc'
        ? 'ascending'
        : 'descending'
      : 'none'

    return (
      <th
        scope="col"
        aria-sort={ariaSort}
        className="py-3 px-3 font-semibold text-xs text-slate-500 dark:text-slate-400 text-left"
      >
        <button
          type="button"
          onClick={() => handleSort(field)}
          className={`inline-flex items-center gap-1.5 transition-colors hover:text-slate-900 dark:hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1 py-0.5 ${
            active ? 'text-blue-600 dark:text-blue-400 font-bold' : ''
          }`}
        >
          <span>{label}</span>
          {active ? (
            sortOrder === 'asc' ? (
              <ArrowUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <ArrowDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )
          ) : (
            <ArrowUpDown
              className="h-3.5 w-3.5 shrink-0 opacity-40 hover:opacity-100"
              aria-hidden="true"
            />
          )}
        </button>
      </th>
    )
  }

  const renderActivityBadge = (activity: string) => {
    switch (activity) {
      case 'Assigned':
        return (
          <Badge className="text-[10px] font-semibold px-2 py-0.5 border bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 border-blue-200 dark:border-blue-800/80 shadow-none">
            Assigned
          </Badge>
        )
      case 'Unassigned':
        return (
          <Badge className="text-[10px] font-semibold px-2 py-0.5 border bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 border-amber-200 dark:border-amber-800/80 shadow-none">
            Unassigned
          </Badge>
        )
      case 'Product added':
        return (
          <Badge className="text-[10px] font-semibold px-2 py-0.5 border bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/80 shadow-none">
            Product added
          </Badge>
        )
      case 'Product removed':
        return (
          <Badge className="text-[10px] font-semibold px-2 py-0.5 border bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 border-red-200 dark:border-red-800/80 shadow-none">
            Product removed
          </Badge>
        )
      default:
        return (
          <Badge className="text-[10px] font-semibold px-2 py-0.5 border bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700 shadow-none">
            {activity || 'N/A'}
          </Badge>
        )
    }
  }

  return (
    <Card className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs mt-4">
      <CardContent className="p-6 space-y-4">
        {/* Filters and Search Bar */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pb-2 border-b border-slate-100 dark:border-slate-800/80">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 flex-1 max-w-3xl">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[200px]">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400"
                aria-hidden="true"
              />
              <Input
                type="text"
                placeholder="Search user, administrator, or license…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 pr-7 h-9 text-xs rounded-xl border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 focus:bg-white dark:focus:bg-slate-900"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xs font-bold rounded"
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </div>

            {/* Activity Filter */}
            <select
              value={activityFilter}
              onChange={(e) => setActivityFilter(e.target.value)}
              className="h-9 px-3 text-xs rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 focus:bg-white dark:focus:bg-slate-900 text-slate-700 dark:text-slate-300 font-medium cursor-pointer shrink-0"
              aria-label="Filter by activity type"
            >
              <option value="all">All activities</option>
              <option value="Assigned">Assigned</option>
              <option value="Unassigned">Unassigned</option>
              <option value="Product added">Product added</option>
              <option value="Product removed">Product removed</option>
            </select>

            {/* Status / Result Filter */}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 px-3 text-xs rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 focus:bg-white dark:focus:bg-slate-900 text-slate-700 dark:text-slate-300 font-medium cursor-pointer shrink-0"
              aria-label="Filter by result status"
            >
              <option value="all">All statuses</option>
              <option value="success">Successful</option>
              <option value="failure">Failed</option>
            </select>

            {/* Date Range Filter */}
            <select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="h-9 px-3 text-xs rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 focus:bg-white dark:focus:bg-slate-900 text-slate-700 dark:text-slate-300 font-medium cursor-pointer shrink-0"
              aria-label="Filter by date range"
            >
              <option value="all">All time</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </div>

          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0 self-end sm:self-center">
            Showing {sortedEvents.length} of {parsedEvents.length} events
          </div>
        </div>

        {/* Audit Log Table */}
        {sortedEvents.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-500 dark:text-slate-400">
            No license audit events match your selected filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40">
                  <SortableHeader field="date" label="Date" />
                  <SortableHeader field="activity" label="Activity" />
                  <SortableHeader field="user" label="User" />
                  <SortableHeader field="license" label="License" />
                  <SortableHeader field="performedBy" label="Performed by" />
                  <th
                    scope="col"
                    className="py-3 px-3 font-semibold text-xs text-slate-500 dark:text-slate-400 text-right"
                  >
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {sortedEvents.map((evt) => (
                  <tr
                    key={evt.id}
                    className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-3 px-3 font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                      {evt.dateDisplay}
                    </td>
                    <td className="py-3 px-3 whitespace-nowrap">
                      {renderActivityBadge(evt.activity)}
                    </td>
                    <td className="py-3 px-3 font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap">
                      {evt.user}
                    </td>
                    <td className="py-3 px-3 font-medium text-slate-700 dark:text-slate-300 max-w-xs truncate">
                      {evt.license}
                    </td>
                    <td className="py-3 px-3 font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap">
                      {evt.performedBy}
                    </td>
                    <td className="py-3 px-3 text-right whitespace-nowrap">
                      <Badge
                        className={`text-[10px] font-semibold px-2 py-0.5 border shadow-none ${
                          evt.isSuccess
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/80'
                            : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 border-red-200 dark:border-red-800/80'
                        }`}
                      >
                        {evt.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
