'use client'

import React, { useMemo, useState } from 'react'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

import { Activity, HardDrive, Search, Shield, User } from 'lucide-react'

type SharePointSiteType = 'Team site' | 'Communication site' | 'OneDrive'

type SharingLevel =
  | 'Anyone'
  | 'NewAndExistingGuests'
  | 'ExistingGuests'
  | 'OrganizationOnly'
  | 'Off'
  | 'Unknown'

function normalizeSharingLevel(v: any): SharingLevel {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()

  if (!s || s.includes('not synchronized')) return 'Unknown'
  if (
    s === 'off' ||
    s === 'disabled' ||
    s === 'none' ||
    s === 'false' ||
    s.includes('disabled') ||
    s.includes('off')
  )
    return 'Off'

  if (s.includes('anyone')) return 'Anyone'
  if (
    (s.includes('new') && s.includes('existing')) ||
    s.includes('newandexisting')
  )
    return 'NewAndExistingGuests'
  if (s.includes('existing')) return 'ExistingGuests'
  if (
    s.includes('org') ||
    s.includes('organization') ||
    s.includes('internal') ||
    s.includes('orgonly') ||
    s.includes('onlypeopleinyourorganization')
  )
    return 'OrganizationOnly'

  return 'Off'
}

function sharingRank(level: SharingLevel) {
  if (level === 'Anyone') return 4
  if (level === 'NewAndExistingGuests') return 3
  if (level === 'ExistingGuests') return 2
  if (level === 'OrganizationOnly') return 1
  if (level === 'Unknown') return -1
  return 0
}

function sharingLabel(level: SharingLevel) {
  if (level === 'Anyone') return 'Anyone'
  if (level === 'NewAndExistingGuests') return 'New & existing guests'
  if (level === 'ExistingGuests') return 'Existing guests'
  if (level === 'OrganizationOnly') return 'Only people in your organization'
  if (level === 'Unknown') return 'Not synchronized'
  return 'Off'
}

type SharePointSectionProps = {
  bundle: any
}

export default function SharePointPage({ bundle }: SharePointSectionProps) {
  const [siteQuery, setSiteQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | SharePointSiteType>(
    'all'
  )
  const [sharingFilter, setSharingFilter] = useState<'all' | 'on' | 'off'>(
    'all'
  )

  const [sortKey, setSortKey] = useState<
    'name' | 'storageUsedGB' | 'lastActivity' | 'guestsCount'
  >('storageUsedGB')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // ✅ Pull SharePoint section from multiple possible bundle locations
  const sp =
    bundle?.sharepoint ??
    bundle?.sharePoint ??
    bundle?.m365?.sharepoint ??
    bundle?.m365?.sharePoint ??
    bundle?.office365?.sharepoint ??
    bundle?.office365?.sharePoint ??
    bundle?.microsoft365?.sharepoint ??
    bundle?.microsoft365?.sharePoint ??
    {}

  // Overview may be: sp.overview OR sp.settings OR flat sp
  const rawOverview = sp?.overview ?? sp?.settings ?? sp ?? {}

  const SP_OVERVIEW = {
    totalSites:
      rawOverview.totalSites ??
      rawOverview.sitesTotal ??
      rawOverview.total ??
      0,
    totalStorageQuotaGB:
      rawOverview.totalStorageQuotaGB === null
        ? null
        : (rawOverview.totalStorageQuotaGB ??
          rawOverview.storageQuotaGB ??
          rawOverview.totalQuotaGB ??
          null),
    oneDriveStorageLimitGB:
      rawOverview.oneDriveStorageLimitGB === null
        ? null
        : (rawOverview.oneDriveStorageLimitGB ??
          rawOverview.onedriveStorageLimitGB ??
          rawOverview.oneDriveLimitGB ??
          null),
    siteStorageLimitsMode:
      rawOverview.siteStorageLimitsMode ??
      rawOverview.storageLimitsMode ??
      rawOverview.limitsMode ??
      'Automatic',

    sharingSharePoint: normalizeSharingLevel(
      rawOverview.sharingSharePoint ??
        rawOverview.sharePointSharing ??
        rawOverview.sharePointSharingLevel ??
        rawOverview.sharingSP ??
        rawOverview.sharingLevelSharePoint ??
        rawOverview.sharepointSharing ??
        rawOverview.sharepointSharingLevel
    ),

    sharingOneDrive: normalizeSharingLevel(
      rawOverview.sharingOneDrive ??
        rawOverview.oneDriveSharing ??
        rawOverview.oneDriveSharingLevel ??
        rawOverview.sharingOD ??
        rawOverview.sharingLevelOneDrive ??
        rawOverview.onedriveSharing ??
        rawOverview.onedriveSharingLevel
    ),
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const SP_SITES = useMemo(
    () =>
      Array.isArray(sp?.sites)
        ? sp.sites
        : Array.isArray(rawOverview?.sites)
          ? rawOverview.sites
          : [],
    [bundle]
  )

  const SP_DELETED_SITES = Array.isArray(sp?.deletedSites)
    ? sp.deletedSites
    : Array.isArray(sp?.recentlyDeletedSites)
      ? sp.recentlyDeletedSites
      : Array.isArray(rawOverview?.deletedSites)
        ? rawOverview.deletedSites
        : []

  function toggleSort(k: typeof sortKey) {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(k)
      setSortDir('desc')
    }
  }

  const filteredSites = useMemo(() => {
    const q = siteQuery.trim().toLowerCase()

    const rows = SP_SITES.filter((s: any) => {
      if (typeFilter !== 'all' && s.type !== typeFilter) return false
      if (sharingFilter === 'on' && !s.externalSharing) return false
      if (sharingFilter === 'off' && s.externalSharing) return false

      if (!q) return true
      const hay = `${s.name} ${s.url} ${s.type}`.toLowerCase()
      return hay.includes(q)
    })

    const sorted = [...rows].sort((a: any, b: any) => {
      const dir = sortDir === 'asc' ? 1 : -1
      if (sortKey === 'name')
        return String(a.name).localeCompare(String(b.name)) * dir
      if (sortKey === 'storageUsedGB')
        return ((a.storageUsedGB ?? 0) - (b.storageUsedGB ?? 0)) * dir
      if (sortKey === 'guestsCount')
        return ((a.guestsCount ?? 0) - (b.guestsCount ?? 0)) * dir
      return (
        (String(a.lastActivity ?? '').length -
          String(b.lastActivity ?? '').length) *
        dir
      )
    })

    return sorted
  }, [siteQuery, typeFilter, sharingFilter, sortKey, sortDir, SP_SITES])

  function SharingScale({
    title,
    level,
  }: {
    title: string
    level: SharingLevel
  }) {
    const rank = sharingRank(level)
    const risk =
      rank < 0
        ? 'Unknown'
        : rank >= 4
          ? 'High'
          : rank === 3
            ? 'Medium'
            : rank === 2
              ? 'Low'
              : rank >= 1
                ? 'Low'
                : 'Off'

    const riskPill =
      rank < 0
        ? 'bg-slate-50 text-slate-600 border border-slate-200'
        : rank >= 4
          ? 'bg-red-50 text-red-700 border border-red-200'
          : rank === 3
            ? 'bg-orange-50 text-orange-700 border border-orange-200'
            : rank === 2
              ? 'bg-blue-50 text-blue-700 border border-blue-200'
              : 'bg-green-50 text-green-700 border border-green-200'

    return (
      <div className="rounded-2xl border bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-900">{title}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Content can be shared with:{' '}
              <span className="font-semibold text-slate-800">
                {sharingLabel(level)}
              </span>
            </div>
          </div>

          <Badge className={riskPill}>{risk} risk</Badge>
        </div>

        <div className="mt-4">
          <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden border">
            <div
              className={
                rank >= 4
                  ? 'h-full bg-red-500'
                  : rank === 3
                    ? 'h-full bg-orange-500'
                    : rank === 2
                      ? 'h-full bg-blue-500'
                      : rank >= 1
                        ? 'h-full bg-green-500'
                        : 'h-full bg-slate-300'
              }
              style={{ width: `${rank === 0 ? 0 : (rank / 4) * 100}%` }}
            />
          </div>

          <div className="mt-3 grid grid-cols-4 gap-2 text-[11px] text-muted-foreground">
            <div className={rank === 4 ? 'text-slate-900 font-semibold' : ''}>
              Anyone
            </div>
            <div className={rank === 3 ? 'text-slate-900 font-semibold' : ''}>
              New+Existing
            </div>
            <div className={rank === 2 ? 'text-slate-900 font-semibold' : ''}>
              Existing
            </div>
            <div className={rank === 1 ? 'text-slate-900 font-semibold' : ''}>
              Org only
            </div>
          </div>
        </div>
      </div>
    )
  }

  const totals = useMemo(() => {
    const totalUsed = SP_SITES.reduce(
      (a: number, s: any) => a + (s.storageUsedGB ?? 0),
      0
    )
    const externalOn = SP_SITES.filter((s: any) => !!s.externalSharing).length
    const orphaned = SP_SITES.filter(
      (s: any) =>
        typeof s.owners === 'number' && s.owners < 2 && s.type !== 'OneDrive'
    ).length
    return { totalUsed, externalOn, orphaned }
  }, [SP_SITES])

  return (
    <div className="mt-6 space-y-6">
      {/* Top stats */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Total Sites
                </div>
                <div className="mt-1 text-2xl font-bold">
                  {SP_OVERVIEW.totalSites}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Sites + OneDrive
                </div>
              </div>
              <div className="h-10 w-10 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center">
                <HardDrive className="h-5 w-5 text-blue-700" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Total Storage Quota
                </div>
                <div className="mt-1 text-2xl font-bold">
                  {typeof SP_OVERVIEW.totalStorageQuotaGB === 'number'
                    ? `${SP_OVERVIEW.totalStorageQuotaGB} GB`
                    : 'Not synchronized'}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Tenant quota
                </div>
              </div>
              <div className="h-10 w-10 rounded-2xl bg-emerald-50 border border-emerald-100 flex items-center justify-center">
                <Activity className="h-5 w-5 text-emerald-700" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  OneDrive Limit
                </div>
                <div className="mt-1 text-2xl font-bold">
                  {typeof SP_OVERVIEW.oneDriveStorageLimitGB === 'number'
                    ? `${SP_OVERVIEW.oneDriveStorageLimitGB} GB`
                    : 'Not synchronized'}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Per user
                </div>
              </div>
              <div className="h-10 w-10 rounded-2xl bg-purple-50 border border-purple-100 flex items-center justify-center">
                <User className="h-5 w-5 text-purple-700" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  External Sharing On
                </div>
                <div className="mt-1 text-2xl font-bold">
                  {SP_SITES.some(
                    (site: any) => typeof site.externalSharing === 'boolean'
                  )
                    ? totals.externalOn
                    : 'Not synchronized'}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Sites allowing external links
                </div>
              </div>
              <div className="h-10 w-10 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center">
                <Shield className="h-5 w-5 text-amber-700" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Storage limits mode */}
      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="font-semibold">Site storage limits</div>
              <div className="text-sm text-muted-foreground">
                Use automatic or manual site storage limits (read-only view)
              </div>
            </div>
            <Badge
              className={
                SP_OVERVIEW.siteStorageLimitsMode === 'Automatic'
                  ? 'bg-blue-50 text-blue-700 border border-blue-200'
                  : 'bg-purple-50 text-purple-700 border border-purple-200'
              }
            >
              {SP_OVERVIEW.siteStorageLimitsMode}
            </Badge>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="rounded-2xl border bg-gradient-to-r from-blue-50 to-white p-4">
              <div className="text-xs text-muted-foreground">Total used</div>
              <div className="text-lg font-bold text-slate-900">
                {Math.round(totals.totalUsed)} GB
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Across sites + OneDrive
              </div>
            </div>

            <div className="rounded-2xl border bg-gradient-to-r from-emerald-50 to-white p-4">
              <div className="text-xs text-muted-foreground">
                Orphaned sites
              </div>
              <div className="text-lg font-bold text-slate-900">
                {SP_SITES.some(
                  (site: any) => typeof site.owners === 'number'
                )
                  ? totals.orphaned
                  : 'Not synchronized'}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Less than 2 owners (governance risk)
              </div>
            </div>

            <div className="rounded-2xl border bg-gradient-to-r from-amber-50 to-white p-4">
              <div className="text-xs text-muted-foreground">Deleted sites</div>
              <div className="text-lg font-bold text-slate-900">
                {sp?.deletedSitesSynchronized === true
                  ? SP_DELETED_SITES.length
                  : 'Not synchronized'}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Recoverable items
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Sharing settings */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <SharingScale
          title="SharePoint sharing"
          level={SP_OVERVIEW.sharingSharePoint}
        />
        <SharingScale
          title="OneDrive sharing"
          level={SP_OVERVIEW.sharingOneDrive}
        />
      </div>

      {/* Sites table */}
      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-6 py-5 border-b flex-wrap gap-3">
            <div>
              <div className="text-lg font-semibold">Sites</div>
              <div className="text-sm text-muted-foreground">
                Search, filter, sort. Focus on sharing + storage + activity.
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative w-full max-w-[320px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={siteQuery}
                  onChange={(e) => setSiteQuery(e.target.value)}
                  placeholder="Search sites, URLs..."
                  className="pl-10"
                />
              </div>

              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as any)}
                className="rounded-xl border px-3 py-2 text-sm bg-white"
              >
                <option value="all">All types</option>
                <option value="Team site">Team site</option>
                <option value="Communication site">Communication site</option>
                <option value="OneDrive">OneDrive</option>
              </select>

              <select
                value={sharingFilter}
                onChange={(e) => setSharingFilter(e.target.value as any)}
                className="rounded-xl border px-3 py-2 text-sm bg-white"
              >
                <option value="all">Sharing: All</option>
                <option value="on">Sharing: On</option>
                <option value="off">Sharing: Off</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="max-h-[520px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-muted-foreground bg-muted/30 sticky top-0">
                  <tr>
                    <th className="text-left px-6 py-3">
                      <button
                        type="button"
                        className="font-semibold hover:underline"
                        onClick={() => toggleSort('name')}
                      >
                        Site
                      </button>
                    </th>
                    <th className="text-left px-6 py-3">Type</th>
                    <th className="text-left px-6 py-3">Sharing</th>
                    <th className="text-left px-6 py-3">
                      <button
                        type="button"
                        className="font-semibold hover:underline"
                        onClick={() => toggleSort('guestsCount')}
                      >
                        Guests
                      </button>
                    </th>
                    <th className="text-left px-6 py-3">
                      <button
                        type="button"
                        className="font-semibold hover:underline"
                        onClick={() => toggleSort('storageUsedGB')}
                      >
                        Storage
                      </button>
                    </th>
                    <th className="text-left px-6 py-3">
                      <button
                        type="button"
                        className="font-semibold hover:underline"
                        onClick={() => toggleSort('lastActivity')}
                      >
                        Last activity
                      </button>
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {filteredSites.map((s: any) => {
                    const pct = Math.min(
                      100,
                      Math.round(
                        ((s.storageUsedGB ?? 0) / (s.storageQuotaGB ?? 1)) * 100
                      )
                    )
                    const pctColor =
                      pct >= 90
                        ? 'bg-red-500'
                        : pct >= 75
                          ? 'bg-orange-500'
                          : pct >= 50
                            ? 'bg-blue-500'
                            : 'bg-green-500'

                    return (
                      <tr
                        key={s.id}
                        className="border-b hover:bg-white hover:shadow-sm transition"
                      >
                        <td className="px-6 py-4">
                          <div className="font-semibold text-slate-900">
                            {s.name}
                          </div>
                          <div className="text-xs text-muted-foreground break-all">
                            {s.url}
                          </div>

                          <div className="mt-2 flex flex-wrap gap-2">
                            {typeof s.owners === 'number' &&
                            s.owners < 2 &&
                            s.type !== 'OneDrive' ? (
                              <Badge className="bg-red-50 text-red-700 border border-red-200">
                                Owner risk
                              </Badge>
                            ) : null}

                            {s.externalSharing === true ? (
                              <Badge className="bg-orange-50 text-orange-700 border border-orange-200">
                                External sharing
                              </Badge>
                            ) : s.externalSharing === false ? (
                              <Badge className="bg-green-50 text-green-700 border border-green-200">
                                Internal only
                              </Badge>
                            ) : (
                              <Badge className="bg-slate-50 text-slate-600 border border-slate-200">
                                Sharing not synchronized
                              </Badge>
                            )}

                            {s.sensitivityLabel ? (
                              <Badge className="bg-slate-50 text-slate-700 border border-slate-200">
                                Label: {s.sensitivityLabel}
                              </Badge>
                            ) : null}
                          </div>
                        </td>

                        <td className="px-6 py-4 text-muted-foreground">
                          {s.type}
                        </td>

                        <td className="px-6 py-4">
                          <Badge
                            className={
                              s.externalSharing === true
                                ? 'bg-orange-50 text-orange-700 border border-orange-200'
                                : s.externalSharing === false
                                  ? 'bg-green-50 text-green-700 border border-green-200'
                                  : 'bg-slate-50 text-slate-600 border border-slate-200'
                            }
                          >
                            {s.externalSharing === true
                              ? 'On'
                              : s.externalSharing === false
                                ? 'Off'
                                : 'Not synchronized'}
                          </Badge>
                        </td>

                        <td className="px-6 py-4">
                          <Badge
                            className={
                              typeof s.guestsCount === 'number' &&
                              s.guestsCount > 0
                                ? 'bg-purple-50 text-purple-700 border border-purple-200'
                                : 'bg-slate-50 text-slate-600 border border-slate-200'
                            }
                          >
                            {typeof s.guestsCount === 'number'
                              ? s.guestsCount
                              : 'Not synchronized'}
                          </Badge>
                        </td>

                        <td className="px-6 py-4">
                          <div className="text-xs text-muted-foreground">
                            {typeof s.storageUsedGB === 'number' &&
                            typeof s.storageQuotaGB === 'number'
                              ? `${s.storageUsedGB} / ${s.storageQuotaGB} GB`
                              : 'Not synchronized'}
                          </div>
                          <div className="mt-2 h-2 w-[180px] rounded-full bg-muted overflow-hidden">
                            <div
                              className={`h-full ${pctColor}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </td>

                        <td className="px-6 py-4 text-muted-foreground">
                          {s.lastActivity}
                        </td>
                      </tr>
                    )
                  })}

                  {filteredSites.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-6 py-10 text-center text-muted-foreground"
                      >
                        No sites match your filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recently deleted sites */}
      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-6">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="font-semibold">Recently deleted sites</div>
              <div className="text-sm text-muted-foreground">
                Recoverable items are not synchronized yet.
              </div>
            </div>
            <Badge className="bg-blue-50 text-blue-700 border border-blue-200">
              {SP_DELETED_SITES.length} items
            </Badge>
          </div>

          <div className="mt-4 max-h-[260px] overflow-y-auto space-y-3">
            {SP_DELETED_SITES.map((d: any) => (
              <div
                key={d.id}
                className="rounded-xl border bg-muted/20 px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">
                      {d.name}
                    </div>
                    <div className="text-xs text-muted-foreground break-all">
                      {d.url}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Deleted: {d.deletedOn} • Size: {d.sizeGB} GB
                    </div>
                  </div>

                  <Badge
                    className={
                      d.daysRemaining <= 10
                        ? 'bg-red-50 text-red-700 border border-red-200'
                        : d.daysRemaining <= 30
                          ? 'bg-orange-50 text-orange-700 border border-orange-200'
                          : 'bg-green-50 text-green-700 border border-green-200'
                    }
                  >
                    {d.daysRemaining} days left
                  </Badge>
                </div>
              </div>
            ))}

            {SP_DELETED_SITES.length === 0 && (
              <div className="text-sm text-muted-foreground text-center py-6">
                No deleted sites found.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
