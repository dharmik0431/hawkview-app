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
  X,
  ShieldCheck,
  Globe,
  User,
  Layers,
} from 'lucide-react'

export type LicenseStatus =
  | 'Available'
  | 'Near capacity'
  | 'Fully utilized'
  | 'Unavailable'
  | 'Awaiting collection'

type SortField =
  | 'product'
  | 'assigned'
  | 'available'
  | 'total'
  | 'utilization'
  | 'status'
type SortOrder = 'asc' | 'desc'

function getRowStatus(row: any, syncCompleted: boolean): LicenseStatus {
  if (!syncCompleted) return 'Awaiting collection'
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
    return 'Awaiting collection'
  }

  const used = Number(usedVal)
  const total = Number(totalVal)

  if (isNaN(total) || isNaN(used) || total <= 0) {
    return 'Awaiting collection'
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
  tenant?: any
  bundle?: any
  domains?: string[] | any[]
}

export default function LicensesSection({
  isMicrosoft = true,
  licenseRows,
  users = [],
  syncCompleted: syncCompletedProp,
  tenant,
  bundle,
  domains = [],
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
  const [selectedLicenseRow, setSelectedLicenseRow] = useState<any | null>(null)
  const [drawerUserSearch, setDrawerUserSearch] = useState('')

  // 1. Operational Summary Metrics
  // (a) Subscribed Products count (active subscribed Microsoft products)
  const subscribedProductsCount = useMemo(() => {
    if (!syncCompleted || rows.length === 0) return null
    // Count active subscribed product rows
    const activeRows = rows.filter(
      (r) => getRowStatus(r, syncCompleted) !== 'Unavailable'
    )
    return activeRows.length
  }, [rows, syncCompleted])

  // (b) Security Defaults (On, Off, or Awaiting collection)
  const securityDefaultsState = useMemo<'On' | 'Off' | 'Awaiting collection'>(() => {
    if (!syncCompleted) return 'Awaiting collection'
    const sd =
      bundle?.securityDefaults ??
      tenant?.securityDefaults ??
      bundle?.entra?.securityDefaults ??
      bundle?.security?.securityDefaults
    if (sd === undefined || sd === null) return 'Awaiting collection'
    if (typeof sd === 'boolean') return sd ? 'On' : 'Off'
    if (typeof sd === 'string') {
      const lower = sd.trim().toLowerCase()
      if (lower === 'on' || lower === 'enabled' || lower === 'true') return 'On'
      if (lower === 'off' || lower === 'disabled' || lower === 'false') return 'Off'
    }
    if (typeof sd === 'object') {
      if (
        sd.enabled === true ||
        sd.state === 'ENABLED' ||
        sd.state === 'ON' ||
        sd.status === 'enabled'
      )
        return 'On'
      if (
        sd.enabled === false ||
        sd.state === 'DISABLED' ||
        sd.state === 'OFF' ||
        sd.status === 'disabled'
      )
        return 'Off'
    }
    return 'Awaiting collection'
  }, [bundle, tenant, syncCompleted])

  // (c) Tenant Domains (verified count & total count)
  const domainMetrics = useMemo(() => {
    const domainList: any[] =
      Array.isArray(domains) && domains.length > 0
        ? domains
        : Array.isArray(bundle?.domains) && bundle.domains.length > 0
          ? bundle.domains
          : Array.isArray(tenant?.domains) && tenant.domains.length > 0
            ? tenant.domains
            : tenant?.domain
              ? [tenant.domain]
              : []

    if (!syncCompleted && domainList.length === 0) {
      return {
        text: 'Awaiting collection',
        verified: 0,
        total: 0,
        isSynced: false,
      }
    }

    const total = domainList.length
    let verified = 0

    domainList.forEach((d: any) => {
      if (typeof d === 'object' && d !== null) {
        if (
          d.isVerified === true ||
          d.verified === true ||
          d.status === 'verified' ||
          d.isInitial === true
        ) {
          verified++
        } else if (d.isVerified === false || d.verified === false) {
          // unverified
        } else {
          verified++
        }
      } else if (typeof d === 'string') {
        const dLower = d.toLowerCase()
        const dnsEntry =
          bundle?.dns?.byDomain?.[dLower] || bundle?.dns?.byDomain?.[d]
        if (dnsEntry) {
          if (dnsEntry.status === 'healthy' || dnsEntry.isVerified === true) {
            verified++
          } else if (
            dnsEntry.status === 'failed' ||
            dnsEntry.isVerified === false
          ) {
            // not verified
          } else {
            verified++
          }
        } else {
          verified++
        }
      }
    })

    return {
      text: `${verified} verified of ${total}`,
      verified,
      total,
      isSynced: true,
    }
  }, [domains, bundle, tenant, syncCompleted])

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
      const matchesStatus =
        statusFilter === 'all' || rowStatus === statusFilter

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

      if (!aValid && !bValid) return 0
      if (!aValid) return 1
      if (!bValid) return -1

      const aName = String(
        a.friendlyName ||
          a.name ||
          a.displayName ||
          a.skuPartNumber ||
          a.skuId ||
          ''
      )
      const bName = String(
        b.friendlyName ||
          b.name ||
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

  // Extract assigned users for selected drawer license
  const assignedUsersForDrawer = useMemo(() => {
    if (!selectedLicenseRow || !Array.isArray(users) || users.length === 0)
      return []

    const skuId = selectedLicenseRow.skuId
    const skuPartNumber = selectedLicenseRow.skuPartNumber
    const prodName = String(
      selectedLicenseRow.friendlyName ||
        selectedLicenseRow.name ||
        selectedLicenseRow.displayName ||
        skuPartNumber ||
        ''
    ).toLowerCase()

    const list: Array<{
      id: string
      name: string
      email: string
      status: string
    }> = []

    users.forEach((u: any) => {
      const userName =
        u.displayName ||
        u.name ||
        u.email ||
        u.userPrincipalName ||
        'Unknown User'
      const userEmail = u.email || u.userPrincipalName || ''

      const userLics = Array.isArray(u.licenses)
        ? u.licenses
        : Array.isArray(u.assignedLicenses)
          ? u.assignedLicenses
          : []

      const isAssigned = userLics.some((lic: any) => {
        if (typeof lic === 'string') {
          const lLower = lic.toLowerCase()
          return (
            lLower === prodName ||
            (skuPartNumber && lLower === skuPartNumber.toLowerCase()) ||
            (skuId && lLower === skuId.toLowerCase()) ||
            prodName.includes(lLower) ||
            lLower.includes(prodName)
          )
        } else if (lic && typeof lic === 'object') {
          const lName = String(
            lic.name || lic.displayName || lic.skuPartNumber || lic.skuId || ''
          ).toLowerCase()
          return (
            lName === prodName ||
            (skuPartNumber && lName === skuPartNumber.toLowerCase()) ||
            (skuId &&
              (lic.skuId === skuId || lName === skuId.toLowerCase()))
          )
        }
        return false
      })

      if (isAssigned) {
        list.push({
          id: u.id || userEmail || userName,
          name: userName,
          email: userEmail,
          status: 'Active',
        })
      }
    })

    return list
  }, [selectedLicenseRow, users])

  // Filter assigned users in drawer by search query
  const filteredDrawerUsers = useMemo(() => {
    if (!drawerUserSearch.trim()) return assignedUsersForDrawer
    const q = drawerUserSearch.toLowerCase().trim()
    return assignedUsersForDrawer.filter(
      (u) =>
        u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    )
  }, [assignedUsersForDrawer, drawerUserSearch])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortOrder('asc')
    }
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
      case 'Awaiting collection':
      default:
        return (
          <Badge className="text-[10px] font-semibold px-2 py-0.5 border bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700 shadow-none">
            Awaiting collection
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
      {/* 1. Page Summary Strip: 3 Operational Values */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Card 1: Subscribed Products */}
        <div className="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Subscribed Products
            </div>
            <KeyRound className="h-4 w-4 text-slate-400" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {subscribedProductsCount !== null
              ? String(subscribedProductsCount)
              : 'Awaiting collection'}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {subscribedProductsCount !== null
              ? `${subscribedProductsCount} active product subscription${
                  subscribedProductsCount === 1 ? '' : 's'
                }`
              : 'Awaiting product data synchronization'}
          </div>
        </div>

        {/* Card 2: Security Defaults */}
        <div className="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Security Defaults
            </div>
            <ShieldCheck className="h-4 w-4 text-slate-400" />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
              {securityDefaultsState}
            </span>
            {securityDefaultsState === 'On' && (
              <Badge className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800 text-[10px]">
                Active
              </Badge>
            )}
            {securityDefaultsState === 'Off' && (
              <Badge className="bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300 border-amber-200 dark:border-amber-800 text-[10px]">
                Disabled
              </Badge>
            )}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Synchronized security defaults setting
          </div>
        </div>

        {/* Card 3: Tenant Domains */}
        <div className="p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Tenant Domains
            </div>
            <Globe className="h-4 w-4 text-slate-400" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {domainMetrics.isSynced ? domainMetrics.text : 'Awaiting collection'}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {domainMetrics.isSynced
              ? `${domainMetrics.total} total synchronized domain${
                  domainMetrics.total === 1 ? '' : 's'
                }`
              : 'Awaiting domain synchronization'}
          </div>
        </div>
      </div>

      {/* 2. License Inventory Container */}
      <Card className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
        <CardContent className="p-6">
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-100 dark:border-slate-800/80">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-blue-50 dark:bg-blue-950/50 border border-blue-200/60 dark:border-blue-900/50 flex items-center justify-center shrink-0">
                <KeyRound
                  className="h-4.5 w-4.5 text-blue-600 dark:text-blue-400"
                  aria-hidden="true"
                />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  License Inventory
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Subscribed Microsoft product licenses and unit utilization.
                  Click any row to inspect details.
                </p>
              </div>
            </div>

            {/* Filter and Search controls */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <div className="relative min-w-[200px]">
                <Search
                  className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400"
                  aria-hidden="true"
                />
                <Input
                  type="text"
                  placeholder="Filter product name…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 pr-7 h-9 text-xs rounded-xl border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 focus:bg-white dark:focus:bg-slate-900"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xs font-bold rounded"
                  >
                    ×
                  </button>
                )}
              </div>

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="h-9 px-3 text-xs rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 focus:bg-white dark:focus:bg-slate-900 text-slate-700 dark:text-slate-300 font-medium cursor-pointer"
              >
                <option value="all">All statuses</option>
                <option value="Available">Available</option>
                <option value="Near capacity">Near capacity</option>
                <option value="Fully utilized">Fully utilized</option>
                <option value="Unavailable">Unavailable</option>
                <option value="Awaiting collection">Awaiting collection</option>
              </select>
            </div>
          </div>

          {/* Table */}
          {!syncCompleted || rows.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-500 dark:text-slate-400">
              {!syncCompleted
                ? 'License synchronization is not completed for this tenant.'
                : 'No subscribed license products found.'}
            </div>
          ) : sortedRows.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-500 dark:text-slate-400">
              No license products match your search and filter criteria.
            </div>
          ) : (
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40">
                    <SortableHeader field="product" label="Product" />
                    <SortableHeader field="assigned" label="Assigned" alignRight />
                    <SortableHeader field="available" label="Available" alignRight />
                    <SortableHeader field="total" label="Total" alignRight />
                    <SortableHeader field="utilization" label="Utilization" />
                    <SortableHeader field="status" label="Status" alignRight />
                    <th scope="col" className="w-8 py-3 px-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {sortedRows.map((row, idx) => {
                    const rowId = row.skuId || row.id || `row-${idx}`
                    const productName =
                      row.friendlyName ||
                      row.name ||
                      row.displayName ||
                      row.skuPartNumber ||
                      row.skuId ||
                      'Unknown Product'

                    const usedVal = row.used ?? row.assigned ?? row.consumedUnits
                    const totalVal = row.total ?? row.enabled ?? row.prepaidUnits

                    const isDataValid =
                      syncCompleted &&
                      usedVal !== undefined &&
                      usedVal !== null &&
                      totalVal !== undefined &&
                      totalVal !== null &&
                      !isNaN(Number(totalVal)) &&
                      Number(totalVal) > 0

                    const used = Number(usedVal ?? 0)
                    const total = Number(totalVal ?? 0)
                    const available = Math.max(0, total - used)
                    const pct = total > 0 ? Math.round((used / total) * 100) : 0
                    const status = getRowStatus(row, syncCompleted)

                    return (
                      <tr
                        key={rowId}
                        onClick={() => {
                          setSelectedLicenseRow(row)
                          setDrawerUserSearch('')
                        }}
                        className="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors cursor-pointer group"
                      >
                        {/* Product Column */}
                        <td className="py-3 px-3 font-semibold text-slate-900 dark:text-slate-100">
                          <div className="flex items-center gap-2">
                            <span className="leading-snug">{productName}</span>
                          </div>
                        </td>

                        {/* Assigned Column */}
                        <td className="py-3 px-3 text-right font-medium text-slate-800 dark:text-slate-200">
                          {isDataValid
                            ? used.toLocaleString()
                            : 'Awaiting collection'}
                        </td>

                        {/* Available Column */}
                        <td className="py-3 px-3 text-right font-medium text-emerald-600 dark:text-emerald-400">
                          {isDataValid
                            ? available.toLocaleString()
                            : 'Awaiting collection'}
                        </td>

                        {/* Total Column */}
                        <td className="py-3 px-3 text-right text-slate-500 dark:text-slate-400 font-normal">
                          {isDataValid
                            ? total.toLocaleString()
                            : 'Awaiting collection'}
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
                                    width: `${Math.min(
                                      100,
                                      Math.max(0, pct)
                                    )}%`,
                                  }}
                                />
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-400 dark:text-slate-500">
                              Awaiting collection
                            </span>
                          )}
                        </td>

                        {/* Status Column */}
                        <td className="py-3 px-3 text-right">
                          {renderStatusBadge(status)}
                        </td>

                        {/* Chevron Affordance */}
                        <td className="py-3 px-2 text-right">
                          <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-200 transition-colors shrink-0" />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. Right-Side License Details Drawer */}
      {selectedLicenseRow && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs animate-in fade-in-0 duration-200">
          <div
            className="fixed inset-0"
            onClick={() => setSelectedLicenseRow(null)}
          />
          <div className="relative z-10 w-full max-w-[540px] sm:w-[540px] bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col h-full overflow-hidden animate-in slide-in-from-right duration-200">
            {/* Drawer Header */}
            <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-4 bg-slate-50/50 dark:bg-slate-800/30">
              <div className="min-w-0 pr-2">
                <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 truncate">
                  {selectedLicenseRow.friendlyName ||
                    selectedLicenseRow.name ||
                    selectedLicenseRow.displayName ||
                    selectedLicenseRow.skuPartNumber ||
                    'License Details'}
                </h2>
                <div className="mt-1.5 flex items-center gap-2">
                  {renderStatusBadge(
                    getRowStatus(selectedLicenseRow, syncCompleted)
                  )}
                  {selectedLicenseRow.skuPartNumber && (
                    <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                      {selectedLicenseRow.skuPartNumber}
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedLicenseRow(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                aria-label="Close details drawer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Drawer Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Section 1: License Summary Card */}
              {(() => {
                const usedVal =
                  selectedLicenseRow.used ??
                  selectedLicenseRow.assigned ??
                  selectedLicenseRow.consumedUnits
                const totalVal =
                  selectedLicenseRow.total ??
                  selectedLicenseRow.enabled ??
                  selectedLicenseRow.prepaidUnits

                const isDataValid =
                  syncCompleted &&
                  usedVal !== undefined &&
                  usedVal !== null &&
                  totalVal !== undefined &&
                  totalVal !== null &&
                  !isNaN(Number(totalVal)) &&
                  Number(totalVal) > 0

                const used = Number(usedVal ?? 0)
                const total = Number(totalVal ?? 0)
                const available = Math.max(0, total - used)
                const pct = total > 0 ? Math.round((used / total) * 100) : 0

                return (
                  <Card className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
                    <CardContent className="p-4 space-y-4">
                      <div className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        License Summary
                      </div>

                      <div className="grid grid-cols-3 gap-3 text-center">
                        <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800">
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                            Total
                          </div>
                          <div className="text-lg font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                            {isDataValid
                              ? total.toLocaleString()
                              : 'Awaiting collection'}
                          </div>
                        </div>

                        <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800">
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                            Assigned
                          </div>
                          <div className="text-lg font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                            {isDataValid
                              ? used.toLocaleString()
                              : 'Awaiting collection'}
                          </div>
                        </div>

                        <div className="p-3 rounded-lg bg-emerald-50/60 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/50">
                          <div className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
                            Available
                          </div>
                          <div className="text-lg font-bold text-emerald-700 dark:text-emerald-400 mt-0.5">
                            {isDataValid
                              ? available.toLocaleString()
                              : 'Awaiting collection'}
                          </div>
                        </div>
                      </div>

                      {isDataValid && (
                        <div className="space-y-1.5 pt-1">
                          <div className="flex justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
                            <span>Utilization</span>
                            <span>{pct}%</span>
                          </div>
                          <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                            <div
                              className="h-full bg-blue-600 dark:bg-blue-500 rounded-full transition-all duration-300"
                              style={{ width: `${Math.min(100, pct)}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )
              })()}

              {/* Section 2: Service Plans Section */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <Layers className="h-3.5 w-3.5" />
                  <span>Service Plans</span>
                  {selectedLicenseRow.servicePlans && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.2 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                      {selectedLicenseRow.servicePlans.length}
                    </span>
                  )}
                </div>

                {Array.isArray(selectedLicenseRow.servicePlans) &&
                selectedLicenseRow.servicePlans.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                    {selectedLicenseRow.servicePlans.map(
                      (plan: any, idx: number) => {
                        const planName =
                          plan.name ||
                          plan.servicePlanName ||
                          plan.displayName ||
                          `Service Plan ${idx + 1}`
                        const planStatus =
                          plan.status || plan.provisioningStatus || 'Success'
                        const isSuccess =
                          planStatus.toLowerCase() === 'success' ||
                          planStatus.toLowerCase() === 'active' ||
                          planStatus.toLowerCase() === 'enabled'

                        return (
                          <div
                            key={planName + idx}
                            className="flex items-center justify-between p-2.5 rounded-lg bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-800 text-xs"
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
                ) : (
                  <div className="text-xs text-slate-500 dark:text-slate-400 italic py-2">
                    No individual service plans listed for this product.
                  </div>
                )}
              </div>

              {/* Section 3: Assigned Users Section */}
              <div className="space-y-3 pt-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    <User className="h-3.5 w-3.5" />
                    <span>Assigned Users</span>
                    <Badge className="text-[10px] font-bold px-2 py-0.5 bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300 border-blue-200 dark:border-blue-800">
                      {filteredDrawerUsers.length}
                    </Badge>
                  </div>
                </div>

                {/* Drawer search filter */}
                {assignedUsersForDrawer.length > 0 && (
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                    <Input
                      type="text"
                      placeholder="Search assigned users by name or email…"
                      value={drawerUserSearch}
                      onChange={(e) => setDrawerUserSearch(e.target.value)}
                      className="pl-8 pr-7 h-8 text-xs rounded-lg border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50"
                    />
                    {drawerUserSearch && (
                      <button
                        type="button"
                        onClick={() => setDrawerUserSearch('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs font-bold"
                      >
                        ×
                      </button>
                    )}
                  </div>
                )}

                {/* Users List Table */}
                {!syncCompleted ? (
                  <div className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
                    User assignment data is awaiting collection.
                  </div>
                ) : filteredDrawerUsers.length === 0 ? (
                  <div className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
                    {drawerUserSearch.trim()
                      ? 'No assigned users match your search.'
                      : 'No users are currently assigned to this license.'}
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-slate-200/80 dark:border-slate-800 rounded-xl">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400 font-semibold">
                          <th className="py-2 px-3">User</th>
                          <th className="py-2 px-3 text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                        {filteredDrawerUsers.map((user) => (
                          <tr key={user.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                            <td className="py-2 px-3">
                              <div className="font-medium text-slate-900 dark:text-slate-100">
                                {user.name}
                              </div>
                              {user.email && user.email !== user.name && (
                                <div className="text-[11px] text-slate-500 dark:text-slate-400 font-normal">
                                  {user.email}
                                </div>
                              )}
                            </td>
                            <td className="py-2 px-3 text-right">
                              <Badge className="text-[10px] font-semibold px-2 py-0.5 border bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 border-blue-200 dark:border-blue-800/80 shadow-none">
                                {user.status}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
