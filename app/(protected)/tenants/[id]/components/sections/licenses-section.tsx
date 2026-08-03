'use client'

import React, { useState, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  KeyRound,
  Search,
  ChevronDown,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  CheckCircle2,
  AlertTriangle,
  Info,
} from 'lucide-react'

export type LicenseStatus =
  | 'Available'
  | 'Near capacity'
  | 'Fully utilized'
  | 'Unavailable'
  | 'Not synchronized'

type SortField =
  | 'product'
  | 'assigned'
  | 'available'
  | 'total'
  | 'utilization'
  | 'status'
type SortOrder = 'asc' | 'desc'

function getRowStatus(row: any, syncCompleted: boolean): LicenseStatus {
  if (!syncCompleted) return 'Not synchronized'
  if (
    row.disabled ||
    row.status === 'bad' ||
    row.status === 'suspended' ||
    row.status === 'Unavailable'
  ) {
    return 'Unavailable'
  }

  const usedVal = row.used ?? row.assigned ?? row.consumedUnits
  const totalVal = row.total ?? row.enabled ?? row.prepaidUnits

  if (
    usedVal === undefined ||
    usedVal === null ||
    totalVal === undefined ||
    totalVal === null
  ) {
    return 'Not synchronized'
  }

  const used = Number(usedVal)
  const total = Number(totalVal)

  if (isNaN(total) || isNaN(used) || total <= 0) {
    return 'Not synchronized'
  }

  const pct = (used / total) * 100
  if (pct >= 100) return 'Fully utilized'
  if (pct >= 80) return 'Near capacity'
  return 'Available'
}

interface LicensesSectionProps {
  isMicrosoft?: boolean
  licenseRows?: any[]
  users?: any[]
  syncCompleted?: boolean
}

export default function LicensesSection({
  isMicrosoft = true,
  licenseRows,
  users = [],
  syncCompleted: syncCompletedProp,
}: LicensesSectionProps) {
  const syncCompleted =
    syncCompletedProp !== undefined
      ? syncCompletedProp
      : Array.isArray(licenseRows)

  const rows = useMemo(() => {
    return Array.isArray(licenseRows) ? licenseRows : []
  }, [licenseRows])

  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [sortField, setSortField] = useState<SortField>('product')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})

  // Compute Summary Metrics
  const summaryMetrics = useMemo(() => {
    if (!syncCompleted) {
      return {
        productsCountText: 'Not synchronized',
        assignedText: 'Not synchronized',
        availableText: 'Not synchronized',
        utilizationText: 'Not synchronized',
      }
    }

    if (rows.length === 0) {
      return {
        productsCountText: '0',
        assignedText: '0',
        availableText: '0',
        utilizationText: '0%',
      }
    }

    let totalAssigned = 0
    let totalCapacity = 0
    let totalAvailable = 0
    let hasValidCapacity = false

    rows.forEach((r) => {
      const u = Number(r.used ?? r.assigned ?? r.consumedUnits)
      const t = Number(r.total ?? r.enabled ?? r.prepaidUnits)

      if (!isNaN(u) && u >= 0) {
        totalAssigned += u
      }
      if (!isNaN(t) && t > 0) {
        hasValidCapacity = true
        totalCapacity += t
        if (!isNaN(u)) {
          totalAvailable += Math.max(0, t - u)
        }
      }
    })

    const utilizationPct =
      hasValidCapacity && totalCapacity > 0
        ? `${Math.round((totalAssigned / totalCapacity) * 100)}%`
        : 'Not synchronized'

    return {
      productsCountText: String(rows.length),
      assignedText: totalAssigned.toLocaleString(),
      availableText: hasValidCapacity
        ? totalAvailable.toLocaleString()
        : 'Not synchronized',
      utilizationText: utilizationPct,
    }
  }, [syncCompleted, rows])

  // Filtered rows
  const filteredRows = useMemo(() => {
    if (!syncCompleted || rows.length === 0) return []

    return rows.filter((row) => {
      const name = String(
        row.name ||
          row.friendlyName ||
          row.displayName ||
          row.skuPartNumber ||
          row.skuId ||
          ''
      )
      const matchesSearch =
        !searchQuery.trim() ||
        name.toLowerCase().includes(searchQuery.toLowerCase().trim())

      const rowStatus = getRowStatus(row, syncCompleted)
      const matchesStatus = statusFilter === 'all' || rowStatus === statusFilter

      return matchesSearch && matchesStatus
    })
  }, [rows, searchQuery, statusFilter, syncCompleted])

  // Sorted rows
  const sortedRows = useMemo(() => {
    const list = [...filteredRows]
    return list.sort((a, b) => {
      const aUsedVal = a.used ?? a.assigned ?? a.consumedUnits
      const aTotalVal = a.total ?? a.enabled ?? a.prepaidUnits
      const bUsedVal = b.used ?? b.assigned ?? b.consumedUnits
      const bTotalVal = b.total ?? b.enabled ?? b.prepaidUnits

      const aValid =
        syncCompleted &&
        aTotalVal !== undefined &&
        aTotalVal !== null &&
        !isNaN(Number(aTotalVal)) &&
        Number(aTotalVal) > 0

      const bValid =
        syncCompleted &&
        bTotalVal !== undefined &&
        bTotalVal !== null &&
        !isNaN(Number(bTotalVal)) &&
        Number(bTotalVal) > 0

      // Missing or unsynchronized values sort last
      if (!aValid && !bValid) return 0
      if (!aValid) return 1
      if (!bValid) return -1

      const aName = String(
        a.name ||
          a.friendlyName ||
          a.displayName ||
          a.skuPartNumber ||
          a.skuId ||
          ''
      )
      const bName = String(
        b.name ||
          b.friendlyName ||
          b.displayName ||
          b.skuPartNumber ||
          b.skuId ||
          ''
      )

      const aUsed = Number(aUsedVal ?? 0)
      const bUsed = Number(bUsedVal ?? 0)

      const aTotal = Number(aTotalVal ?? 0)
      const bTotal = Number(bTotalVal ?? 0)

      const aAvail = Math.max(0, aTotal - aUsed)
      const bAvail = Math.max(0, bTotal - bUsed)

      const aPct = aTotal > 0 ? (aUsed / aTotal) * 100 : 0
      const bPct = bTotal > 0 ? (bUsed / bTotal) * 100 : 0

      const aStatus = getRowStatus(a, syncCompleted)
      const bStatus = getRowStatus(b, syncCompleted)

      let cmp = 0
      if (sortField === 'product') {
        cmp = aName.localeCompare(bName)
      } else if (sortField === 'assigned') {
        cmp = aUsed - bUsed
      } else if (sortField === 'available') {
        cmp = aAvail - bAvail
      } else if (sortField === 'total') {
        cmp = aTotal - bTotal
      } else if (sortField === 'utilization') {
        cmp = aPct - bPct
      } else if (sortField === 'status') {
        cmp = aStatus.localeCompare(bStatus)
      }

      return sortOrder === 'asc' ? cmp : -cmp
    })
  }, [filteredRows, sortField, sortOrder, syncCompleted])

  // Extract User Assignments
  const userAssignments = useMemo(() => {
    if (!Array.isArray(users) || users.length === 0) return []
    const list: Array<{
      user: string
      email?: string
      product: string
      status: string
    }> = []

    users.forEach((u) => {
      const name =
        u.displayName ||
        u.name ||
        u.email ||
        u.userPrincipalName ||
        'Unknown User'
      const userLics = Array.isArray(u.licenses)
        ? u.licenses
        : Array.isArray(u.assignedLicenses)
          ? u.assignedLicenses
          : []

      userLics.forEach((lic: any) => {
        const prodName =
          typeof lic === 'string'
            ? lic
            : lic.name || lic.skuPartNumber || String(lic)
        list.push({
          user: name,
          email: u.email || u.userPrincipalName,
          product: prodName,
          status: 'Active',
        })
      })
    })

    return list
  }, [users])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortOrder('asc')
    }
  }

  const toggleRowExpanded = (id: string) => {
    setExpandedRows((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const renderStatusBadge = (status: LicenseStatus) => {
    switch (status) {
      case 'Available':
        return (
          <Badge className="text-[10px] font-semibold px-2 py-0.5 border bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/80 shadow-none">
            Available
          </Badge>
        )
      case 'Near capacity':
        return (
          <Badge className="text-[10px] font-semibold px-2 py-0.5 border bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 border-amber-200 dark:border-amber-800/80 shadow-none">
            Near capacity
          </Badge>
        )
      case 'Fully utilized':
        return (
          <Badge className="text-[10px] font-semibold px-2 py-0.5 border bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 border-blue-200 dark:border-blue-800/80 shadow-none">
            Fully utilized
          </Badge>
        )
      case 'Unavailable':
        return (
          <Badge className="text-[10px] font-semibold px-2 py-0.5 border bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 border-red-200 dark:border-red-800/80 shadow-none">
            Unavailable
          </Badge>
        )
      case 'Not synchronized':
      default:
        return (
          <Badge className="text-[10px] font-semibold px-2 py-0.5 border bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700 shadow-none">
            Not synchronized
          </Badge>
        )
    }
  }

  function SortableHeader({
    field,
    label,
    alignRight = false,
  }: {
    field: SortField
    label: string
    alignRight?: boolean
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
        className={`py-3 px-3 font-semibold text-xs text-slate-500 dark:text-slate-400 ${
          alignRight ? 'text-right' : 'text-left'
        }`}
      >
        <button
          type="button"
          onClick={() => handleSort(field)}
          className={`inline-flex items-center gap-1.5 transition-colors hover:text-slate-900 dark:hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1 py-0.5 ${
            alignRight ? 'justify-end w-full' : ''
          } ${active ? 'text-blue-600 dark:text-blue-400 font-bold' : ''}`}
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

  return (
    <div className="space-y-6 mt-4">
      {/* 1. Page Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Subscribed products
          </div>
          <div className="mt-1.5 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {summaryMetrics.productsCountText}
          </div>
        </div>

        <div className="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Assigned licenses
          </div>
          <div className="mt-1.5 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {summaryMetrics.assignedText}
          </div>
        </div>

        <div className="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Available licenses
          </div>
          <div className="mt-1.5 text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
            {summaryMetrics.availableText}
          </div>
        </div>

        <div className="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Utilization rate
          </div>
          <div className="mt-1.5 text-2xl font-bold tracking-tight text-blue-600 dark:text-blue-400">
            {summaryMetrics.utilizationText}
          </div>
        </div>
      </div>

      {/* 2. License Inventory Container */}
      <Card className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
        <CardContent className="p-6">
          {/* Card Title & Description Header */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-100 dark:border-slate-800/80">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-blue-50 dark:bg-blue-950/50 border border-blue-200/60 dark:border-blue-900/50 flex items-center justify-center shrink-0">
                <KeyRound
                  className="h-4.5 w-4.5 text-blue-600 dark:text-blue-400"
                  aria-hidden="true"
                />
              </div>
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  License inventory
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Assignment and availability across subscribed Microsoft
                  products.
                </p>
              </div>
            </div>
          </div>

          {/* Search & Status Filter Controls (Only shown if synchronized) */}
          {syncCompleted && rows.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 my-5">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 flex-1 max-w-xl">
                {/* Search Input */}
                <div className="relative flex-1">
                  <Search
                    className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400"
                    aria-hidden="true"
                  />
                  <Input
                    type="text"
                    placeholder="Search by product name…"
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

                {/* Status Filter */}
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="h-9 px-3 text-xs rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 focus:bg-white dark:focus:bg-slate-900 text-slate-700 dark:text-slate-300 font-medium cursor-pointer"
                  aria-label="Filter by status"
                >
                  <option value="all">All statuses</option>
                  <option value="Available">Available</option>
                  <option value="Near capacity">Near capacity</option>
                  <option value="Fully utilized">Fully utilized</option>
                  <option value="Unavailable">Unavailable</option>
                  <option value="Not synchronized">Not synchronized</option>
                </select>
              </div>

              {/* Result Count */}
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0">
                Showing {filteredRows.length} of {rows.length} products
              </div>
            </div>
          )}

          {/* Empty States Handling */}
          {!syncCompleted ? (
            <div className="my-8 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20 p-8 text-center">
              <Info
                className="h-6 w-6 text-slate-400 dark:text-slate-500 mx-auto mb-2"
                aria-hidden="true"
              />
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                License information has not been synchronized yet.
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
                Use the Refresh button at the top of the page to synchronize
                Microsoft 365 tenant license data.
              </p>
            </div>
          ) : rows.length === 0 ? (
            <div className="my-8 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20 p-8 text-center">
              <Info
                className="h-6 w-6 text-slate-400 dark:text-slate-500 mx-auto mb-2"
                aria-hidden="true"
              />
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                No subscribed Microsoft products were found.
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
                No active license subscriptions were returned for this tenant.
              </p>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="my-8 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/20 p-8 text-center">
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                No products match your search or status filter.
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Try clearing your search term or selecting &quot;All
                statuses&quot;.
              </p>
            </div>
          ) : (
            /* Main License Inventory Table */
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40">
                    <SortableHeader field="product" label="Product" />
                    <SortableHeader
                      field="assigned"
                      label="Assigned"
                      alignRight
                    />
                    <SortableHeader
                      field="available"
                      label="Available"
                      alignRight
                    />
                    <SortableHeader field="total" label="Total" alignRight />
                    <SortableHeader field="utilization" label="Utilization" />
                    <SortableHeader field="status" label="Status" alignRight />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {sortedRows.map((row, index) => {
                    const rowId =
                      row.id || row.skuPartNumber || row.name || `row-${index}`
                    const servicePlans = Array.isArray(row.servicePlans)
                      ? row.servicePlans
                      : Array.isArray(row.plans)
                        ? row.plans
                        : Array.isArray(row.details)
                          ? row.details
                          : []
                    const hasPlans = servicePlans.length > 0
                    const isExpanded = !!expandedRows[rowId]

                    const usedVal =
                      row.used ?? row.assigned ?? row.consumedUnits
                    const totalVal =
                      row.total ?? row.enabled ?? row.prepaidUnits

                    const isDataValid =
                      usedVal !== undefined &&
                      usedVal !== null &&
                      totalVal !== undefined &&
                      totalVal !== null &&
                      !isNaN(Number(usedVal)) &&
                      !isNaN(Number(totalVal)) &&
                      Number(totalVal) > 0

                    const used = isDataValid ? Number(usedVal) : 0
                    const total = isDataValid ? Number(totalVal) : 0
                    const available = isDataValid
                      ? Math.max(0, total - used)
                      : 0

                    const pct = isDataValid
                      ? Math.round((used / total) * 100)
                      : 0
                    const status = getRowStatus(row, syncCompleted)

                    const productName =
                      row.name ||
                      row.friendlyName ||
                      row.displayName ||
                      row.skuPartNumber ||
                      row.skuId ||
                      'Unknown Product'

                    return (
                      <React.Fragment key={rowId}>
                        <tr className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors">
                          {/* Product Column */}
                          <td className="py-3 px-3 font-medium text-slate-900 dark:text-slate-100 max-w-sm">
                            <div className="flex items-center gap-2">
                              {hasPlans ? (
                                <button
                                  type="button"
                                  onClick={() => toggleRowExpanded(rowId)}
                                  className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors"
                                  title={
                                    isExpanded
                                      ? 'Collapse service plans'
                                      : 'Expand service plans'
                                  }
                                  aria-label={
                                    isExpanded
                                      ? `Collapse service plans for ${productName}`
                                      : `Expand service plans for ${productName}`
                                  }
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="h-4 w-4 shrink-0" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4 shrink-0" />
                                  )}
                                </button>
                              ) : (
                                <span className="w-6 shrink-0" />
                              )}
                              <span className="leading-snug">
                                {productName}
                              </span>
                            </div>
                          </td>

                          {/* Assigned Column */}
                          <td className="py-3 px-3 text-right font-medium text-slate-800 dark:text-slate-200">
                            {isDataValid
                              ? used.toLocaleString()
                              : 'Not synchronized'}
                          </td>

                          {/* Available Column */}
                          <td className="py-3 px-3 text-right font-medium text-emerald-600 dark:text-emerald-400">
                            {isDataValid
                              ? available.toLocaleString()
                              : 'Not synchronized'}
                          </td>

                          {/* Total Column */}
                          <td className="py-3 px-3 text-right text-slate-500 dark:text-slate-400 font-normal">
                            {isDataValid
                              ? total.toLocaleString()
                              : 'Not synchronized'}
                          </td>

                          {/* Utilization Column */}
                          <td className="py-3 px-3">
                            {isDataValid ? (
                              <div className="flex items-center gap-2.5 min-w-[120px]">
                                <span className="w-8 text-right font-semibold text-slate-700 dark:text-slate-300 shrink-0">
                                  {pct}%
                                </span>
                                <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                                  <div
                                    className={`h-full rounded-full transition-all duration-300 ${
                                      status === 'Fully utilized'
                                        ? 'bg-blue-500'
                                        : status === 'Near capacity'
                                          ? 'bg-amber-500'
                                          : status === 'Unavailable'
                                            ? 'bg-red-500'
                                            : 'bg-emerald-500'
                                    }`}
                                    style={{
                                      width: `${Math.min(100, Math.max(0, pct))}%`,
                                    }}
                                  />
                                </div>
                              </div>
                            ) : (
                              <span className="text-slate-400 dark:text-slate-500">
                                Not synchronized
                              </span>
                            )}
                          </td>

                          {/* Status Column */}
                          <td className="py-3 px-3 text-right">
                            {renderStatusBadge(status)}
                          </td>
                        </tr>

                        {/* Expandable Service Plans Details */}
                        {hasPlans && isExpanded && (
                          <tr className="bg-slate-50/70 dark:bg-slate-800/30">
                            <td
                              colSpan={6}
                              className="py-3 px-4 pl-10 border-b border-slate-100 dark:border-slate-800/80"
                            >
                              <div className="space-y-2">
                                <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                                  Service plans ({servicePlans.length})
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                                  {servicePlans.map(
                                    (plan: any, idx: number) => {
                                      const planName =
                                        plan.name ||
                                        plan.servicePlanName ||
                                        plan.displayName ||
                                        `Service Plan ${idx + 1}`
                                      const planStatus =
                                        plan.status ||
                                        plan.provisioningStatus ||
                                        'Success'

                                      const isSuccess =
                                        planStatus.toLowerCase() ===
                                          'success' ||
                                        planStatus.toLowerCase() === 'active' ||
                                        planStatus.toLowerCase() === 'enabled'

                                      return (
                                        <div
                                          key={planName + idx}
                                          className="flex items-center justify-between p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 text-xs shadow-2xs"
                                        >
                                          <span className="font-medium text-slate-800 dark:text-slate-200 truncate pr-2">
                                            {planName}
                                          </span>
                                          <span
                                            className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border shrink-0 ${
                                              isSuccess
                                                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
                                                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                                            }`}
                                          >
                                            {planStatus}
                                          </span>
                                        </div>
                                      )
                                    }
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. Secondary Section: Assignments by user (ONLY rendered if user license data exists) */}
      {userAssignments.length > 0 && (
        <Card className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <CardContent className="p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-slate-100 dark:border-slate-800/80">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  Assignments by user
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Current user seat allocations synchronized from Entra ID.
                </p>
              </div>
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {userAssignments.length} user assignment
                {userAssignments.length === 1 ? '' : 's'}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400 font-semibold">
                    <th className="py-2.5 px-3">User</th>
                    <th className="py-2.5 px-3">Product</th>
                    <th className="py-2.5 px-3 text-right">
                      Assignment status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {userAssignments.map((assignment, idx) => (
                    <tr
                      key={assignment.user + assignment.product + idx}
                      className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                    >
                      <td className="py-2.5 px-3 font-medium text-slate-900 dark:text-slate-100">
                        <div>{assignment.user}</div>
                        {assignment.email &&
                          assignment.email !== assignment.user && (
                            <div className="text-[11px] text-slate-400 dark:text-slate-500 font-normal">
                              {assignment.email}
                            </div>
                          )}
                      </td>
                      <td className="py-2.5 px-3 font-medium text-slate-700 dark:text-slate-300">
                        {assignment.product}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <Badge className="text-[10px] font-semibold px-2 py-0.5 border bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 border-blue-200 dark:border-blue-800/80 shadow-none">
                          {assignment.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
