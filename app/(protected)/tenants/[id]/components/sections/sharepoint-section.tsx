'use client'

import React, { useMemo, useState, useEffect, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowUpDown,
  Bell,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  Globe,
  HardDrive,
  History,
  Info,
  Laptop,
  Layers,
  Lock,
  Menu,
  RefreshCw,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Trash2,
  User,
  X,
  Database,
  Calendar,
  Clock,
  Building2,
  Share2,
  Key,
  Cloud,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatTenantTimestamp } from '@/lib/tenant-workspace-state'
import {
  buildSharePointViewModel,
  sharePointReportedDeletedState,
  sharePointRetentionDaysLabel,
} from '@/lib/tenants/sharepoint-view-model'

export type SharePointSiteType =
  | 'Microsoft 365 group site'
  | 'SharePoint site'
  | 'Communication site'
  | 'OneDrive'

export type TabKey = 'overview' | 'sites' | 'tenant-settings'

export type SharePointSectionProps = {
  bundle: any
  onSync?: () => void
  syncState?: 'idle' | 'syncing' | 'success' | 'fail'
  serviceFreshnessText?: string | null
  onOpenMobileNav?: () => void
}

type OptionalColumnKey =
  | 'fileCount'
  | 'activeFileCount'
  | 'pageViews'
  | 'visitedPages'
  | 'reportRefreshedAt'
  | 'reportPeriod'
  | 'createdDate'
  | 'graphLastModified'
  | 'rootTemplate'
  | 'usageReportDeleted'

const OPTIONAL_COLUMNS: { key: OptionalColumnKey; label: string }[] = [
  { key: 'fileCount', label: 'File Count' },
  { key: 'activeFileCount', label: 'Active File Count' },
  { key: 'pageViews', label: 'Page Views' },
  { key: 'visitedPages', label: 'Visited Pages' },
  { key: 'reportRefreshedAt', label: 'Report Refreshed Date' },
  { key: 'reportPeriod', label: 'Report Period' },
  { key: 'createdDate', label: 'Created Date' },
  { key: 'graphLastModified', label: 'Graph Last Modified' },
  { key: 'rootTemplate', label: 'Root Template' },
  { key: 'usageReportDeleted', label: 'Marked Deleted in Usage Report' },
]

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Not reported by Microsoft'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return 'Not reported by Microsoft'
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatExactTimestamp(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Not reported'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return 'Not reported'
  return d.toISOString()
}

function formatStorageGB(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value)) return 'Not reported'
  if (value === 0) return '0 GB'
  if (value < 0.01) return '< 0.01 GB'
  return `${(Math.round(value * 100) / 100).toLocaleString()} GB`
}

function formatMBToReadable(mbValue: number | null | undefined): string {
  if (mbValue === null || mbValue === undefined || isNaN(mbValue)) return 'Not available'
  if (mbValue >= 1048576) {
    const tb = Math.round((mbValue / 1048576) * 100) / 100
    return `${tb} TB (${mbValue.toLocaleString()} MB)`
  }
  if (mbValue >= 1024) {
    const gb = Math.round((mbValue / 1024) * 100) / 100
    return `${gb} GB (${mbValue.toLocaleString()} MB)`
  }
  return `${mbValue.toLocaleString()} MB`
}

function formatSharingCapability(val: any): string {
  if (val === null || val === undefined) return 'Not available'
  const s = String(val).trim().toLowerCase()
  if (!s || s === 'unknown' || s.includes('not')) return 'Not available'
  if (s === 'externaluserandguestsharing' || s.includes('anyone')) return 'Anyone (Anonymous sharing permitted)'
  if (s === 'externalusersharingonly' || s.includes('newandexisting')) return 'New and existing guests'
  if (s === 'existingexternalusersharingonly' || s.includes('existing')) return 'Existing guests only'
  if (s === 'disabled' || s.includes('org') || s.includes('organization') || s.includes('internal')) return 'Only people in your organization'
  if (s === 'off') return 'Disabled'
  return String(val)
}

function formatBooleanSetting(val: any): string {
  if (typeof val === 'boolean') return val ? 'Enabled' : 'Disabled'
  return 'Not available'
}

export default function SharePointPage({
  bundle,
  onSync,
  syncState = 'idle',
  serviceFreshnessText,
  onOpenMobileNav,
}: SharePointSectionProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('overview')

  // Search & Filter States
  const [siteQuery, setSiteQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | SharePointSiteType>('all')
  const [activityFilter, setActivityFilter] = useState<
    'all' | 'active90' | 'inactive90_179' | 'inactive180' | 'unreported' | 'concealed'
  >('all')
  const [storageFilter, setStorageFilter] = useState<
    'all' | 'reported' | 'unreported' | 'nearCapacity'
  >('all')
  const [reportAvailabilityFilter, setReportAvailabilityFilter] = useState<
    'all' | 'reported' | 'missing'
  >('all')
  const [usageDeletedFilter, setUsageDeletedFilter] = useState<
    'all' | 'deleted' | 'active'
  >('all')

  const [sortKey, setSortKey] = useState<
    'name' | 'type' | 'storageUsedGB' | 'utilization' | 'lastActivityAt'
  >('storageUsedGB')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // Column Manager & Popover States
  const [visibleOptionalCols, setVisibleOptionalCols] = useState<Set<OptionalColumnKey>>(
    new Set<OptionalColumnKey>(['fileCount', 'rootTemplate'])
  )
  const [isColumnManagerOpen, setIsColumnManagerOpen] = useState(false)
  const [isMoreFiltersOpen, setIsMoreFiltersOpen] = useState(false)

  // Drawer Inspection State
  const [selectedSite, setSelectedSite] = useState<any | null>(null)
  const lastTriggerRef = useRef<HTMLElement | null>(null)

  // Expandable Chip List States for Settings Tab
  const [expandedSettingsLists, setExpandedSettingsLists] = useState<Record<string, boolean>>({})

  const toggleSettingsListExpand = (key: string) => {
    setExpandedSettingsLists((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  // Global Escape key listener for drawer
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedSite) {
        setSelectedSite(null)
        if (lastTriggerRef.current) {
          lastTriggerRef.current.focus()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedSite])

  // Retrieve SharePoint dataset safely from bundle
  const sp = useMemo(() => {
    return (
      bundle?.sharepoint ??
      bundle?.sharePoint ??
      bundle?.m365?.sharepoint ??
      bundle?.m365?.sharePoint ??
      bundle?.office365?.sharepoint ??
      bundle?.office365?.sharePoint ??
      {}
    )
  }, [bundle])

  const sharePointView: any = useMemo(() => buildSharePointViewModel(sp), [sp])
  const rawOverview = sharePointView.overview
  const tenant = bundle?.tenant ?? {}
  const tenantId = tenant.id || String(rawOverview.tenantId || '')
  const tenantName = tenant.name || 'Tenant'
  const primaryDomain = tenant.domain || ''

  const SP_OVERVIEW = {
    totalSites:
      typeof rawOverview.totalSites === 'number'
        ? rawOverview.totalSites
        : typeof rawOverview.sitesTotal === 'number'
          ? rawOverview.sitesTotal
          : null,
    totalStorageQuotaGB:
      typeof rawOverview.totalStorageQuotaGB === 'number'
        ? rawOverview.totalStorageQuotaGB
        : typeof rawOverview.storageQuotaGB === 'number'
          ? rawOverview.storageQuotaGB
          : null,
    reportedStorageUsedGB:
      typeof rawOverview.reportedStorageUsedGB === 'number'
        ? rawOverview.reportedStorageUsedGB
        : null,
    storageQuotaSource:
      rawOverview.storageQuotaSource ?? rawOverview.quotaSource ?? null,
    oneDriveStorageLimitGB:
      typeof rawOverview.oneDriveStorageLimitGB === 'number'
        ? rawOverview.oneDriveStorageLimitGB
        : typeof rawOverview.oneDriveLimitGB === 'number'
          ? rawOverview.oneDriveLimitGB
          : null,
    siteStorageLimitsMode:
      rawOverview.siteStorageLimitsMode ?? rawOverview.storageLimitsMode ?? null,
    inactiveSites90Days:
      typeof rawOverview.inactiveSites90Days === 'number'
        ? rawOverview.inactiveSites90Days
        : null,
    inactiveSites180Days:
      typeof rawOverview.inactiveSites180Days === 'number'
        ? rawOverview.inactiveSites180Days
        : null,
    sitesWithoutActivityData:
      typeof rawOverview.sitesWithoutActivityData === 'number'
        ? rawOverview.sitesWithoutActivityData
        : null,
    sitesMissingReportedOwner:
      typeof rawOverview.sitesMissingReportedOwner === 'number'
        ? rawOverview.sitesMissingReportedOwner
        : null,
    sitesWithMatchedUsage:
      typeof rawOverview.sitesWithMatchedUsage === 'number'
        ? rawOverview.sitesWithMatchedUsage
        : null,
    sitesWithoutMatchedUsage:
      typeof rawOverview.sitesWithoutMatchedUsage === 'number'
        ? rawOverview.sitesWithoutMatchedUsage
        : null,
    reportedDeletedCount:
      typeof rawOverview.reportedDeletedCount === 'number'
        ? rawOverview.reportedDeletedCount
        : null,
    sharingCapability:
      rawOverview.sharingCapability ??
      rawOverview.sharingSharePoint ??
      rawOverview.sharePointSharing ??
      sp?.tenantSettings?.sharingCapability ??
      sp?.collection?.tenantSettings?.value?.sharingCapability ??
      null,
  }

  const SP_SITES: any[] = sharePointView.sites
  const SITE_TABLE_ROWS: any[] = sharePointView.siteTableRows
  const siteCountLabel: string = sharePointView.inventory.countLabel

  // Collection Status strip data
  const collectionInfo = sp?.collection ?? {}
  const sharePointSync = sharePointView.sync
  const isSyncing = syncState === 'syncing' || sharePointSync?.status === 'running'
  const isLastKnownData = syncState === 'fail' || sharePointSync?.status === 'failed'

  const lastAttemptRaw = sharePointSync.lastAttemptAt || collectionInfo.lastAttemptAt || bundle?.lastSyncAt
  const lastSuccessRaw = sharePointSync.lastSuccessAt || collectionInfo.lastSuccessAt || bundle?.lastSuccessSyncAt
  const reportRefreshedRaw = sharePointSync.reportRefreshedAt

  const lastAttemptFormatted = formatTenantTimestamp(lastAttemptRaw)
  const lastSuccessFormatted = formatTenantTimestamp(lastSuccessRaw)
  const reportRefreshedFormatted = formatDate(reportRefreshedRaw)

  // Fix Contradictory Status Logic: Never say "No Data" when valid legacy data/sites are present!
  const syncStatusDotColor = (() => {
    if (isSyncing) return 'bg-blue-500 animate-pulse'
    if (syncState === 'fail' || sharePointSync.status === 'failed') return 'bg-red-500'
    if (sharePointSync?.status === 'partial') return 'bg-amber-500'
    if (SP_SITES.length > 0 || lastSuccessRaw) return 'bg-emerald-500'
    return 'bg-slate-400'
  })()

  const syncStatusLabel = (() => {
    if (isSyncing) return 'Syncing...'
    if (syncState === 'fail' || sharePointSync.status === 'failed') return 'Collection Needs Attention'
    if (sharePointSync?.status === 'partial') return 'Partial Data Available'
    if (SP_SITES.length > 0) {
      if (lastSuccessRaw) return 'Current Dataset'
      return 'Legacy Data Available'
    }
    if (lastSuccessRaw) return 'Current Dataset'
    return 'Awaiting First Successful Collection'
  })()

  // Derived metrics from real runtime fields
  const totalStorageUsedGB = useMemo(() => {
    if (sharePointView.contractPresent) {
      return SP_OVERVIEW.reportedStorageUsedGB
    }
    if (!sharePointView.usageReport.exactClaimsAvailable) return null
    let sum = 0
    let hasValue = false
    for (const site of SP_SITES) {
      if (typeof site.storageUsedGB === 'number' && !isNaN(site.storageUsedGB)) {
        sum += site.storageUsedGB
        hasValue = true
      }
    }
    return hasValue ? Math.round(sum * 100) / 100 : null
  }, [SP_OVERVIEW.reportedStorageUsedGB, SP_SITES, sharePointView.contractPresent, sharePointView.usageReport.exactClaimsAvailable])

  const bestEffortDriveStorageUsedGB = useMemo(() => {
    let sum = 0
    let hasValue = false
    for (const site of SP_SITES) {
      if (
        typeof site.bestEffortDriveStorageUsedGB === 'number' &&
        !isNaN(site.bestEffortDriveStorageUsedGB)
      ) {
        sum += site.bestEffortDriveStorageUsedGB
        hasValue = true
      }
    }
    return hasValue ? Math.round(sum * 100) / 100 : null
  }, [SP_SITES])

  const aggregateReportedAllocationGB = useMemo(() => {
    if (sharePointView.contractPresent) {
      return SP_OVERVIEW.totalStorageQuotaGB
    }
    if (!sharePointView.usageReport.exactClaimsAvailable) return null
    let sum = 0
    let hasValue = false
    for (const site of SP_SITES) {
      if (typeof site.storageQuotaGB === 'number' && !isNaN(site.storageQuotaGB)) {
        sum += site.storageQuotaGB
        hasValue = true
      }
    }
    return hasValue ? Math.round(sum * 100) / 100 : null
  }, [SP_OVERVIEW.totalStorageQuotaGB, SP_SITES, sharePointView.contractPresent, sharePointView.usageReport.exactClaimsAvailable])

  const sitesWithActivityCount = useMemo(() => {
    return SP_SITES.filter((s) => s.lastActivityAt || s.lastActivity).length
  }, [SP_SITES])

  const matchedUsageSiteCount = useMemo(() => {
    return SP_OVERVIEW.sitesWithMatchedUsage
  }, [SP_OVERVIEW.sitesWithMatchedUsage])

  const calculatedInactive90Count = useMemo(() => {
    if (typeof SP_OVERVIEW.inactiveSites90Days === 'number') {
      return SP_OVERVIEW.inactiveSites90Days
    }
    if (!sharePointView.usageReport.exactClaimsAvailable) return null
    return SP_SITES.filter((s) => {
      const days = typeof s.activityAgeDays === 'number' ? s.activityAgeDays : null
      return days !== null && days >= 90
    }).length
  }, [SP_OVERVIEW.inactiveSites90Days, SP_SITES, sharePointView.usageReport.exactClaimsAvailable])

  const calculatedInactive180Count = useMemo(() => {
    if (typeof SP_OVERVIEW.inactiveSites180Days === 'number') {
      return SP_OVERVIEW.inactiveSites180Days
    }
    if (!sharePointView.usageReport.exactClaimsAvailable) return null
    return SP_SITES.filter((s) => {
      const days = typeof s.activityAgeDays === 'number' ? s.activityAgeDays : null
      return days !== null && days >= 180
    }).length
  }, [SP_OVERVIEW.inactiveSites180Days, SP_SITES, sharePointView.usageReport.exactClaimsAvailable])

  const calculatedUnreportedActivityCount = useMemo(() => {
    if (typeof SP_OVERVIEW.sitesWithoutActivityData === 'number') {
      return SP_OVERVIEW.sitesWithoutActivityData
    }
    if (!sharePointView.usageReport.exactClaimsAvailable) return null
    return SP_SITES.filter((s) => !s.lastActivityAt && !s.lastActivity).length
  }, [SP_OVERVIEW.sitesWithoutActivityData, SP_SITES, sharePointView.usageReport.exactClaimsAvailable])

  const activityDistributionAvailable = [
    calculatedInactive90Count,
    calculatedInactive180Count,
    calculatedUnreportedActivityCount,
  ].every((value) => typeof value === 'number')
  const activeWithin90Count = activityDistributionAvailable
    ? Math.max(0, sitesWithActivityCount - (calculatedInactive90Count as number))
    : null
  const inactive90To179Count = activityDistributionAvailable
    ? Math.max(0, (calculatedInactive90Count as number) - (calculatedInactive180Count as number))
    : null
  const activityDistribution = {
    activeUnder90: activeWithin90Count ?? 0,
    inactive90To179: inactive90To179Count ?? 0,
    inactive180Plus: calculatedInactive180Count ?? 0,
    unreported: calculatedUnreportedActivityCount ?? 0,
  }

  const sitesMissingOwnerCount = SP_OVERVIEW.sitesMissingReportedOwner

  // This count is emitted once by the authoritative D180 contract. Do not add
  // the deleted-signal array to matched site flags: the same Microsoft row can
  // legitimately appear in both projections.
  const usageReportMarkedDeletedCount = SP_OVERVIEW.reportedDeletedCount

  // Check for typed OneDrive accounts collection
  const ONEDRIVE_ACCOUNTS: any[] = sharePointView.oneDriveAccounts

  const hasTypedOneDriveCollection = ONEDRIVE_ACCOUNTS.length > 0

  // Tenant Settings allowlist extraction
  const rawTenantSettings = sharePointView.tenantSettings

  // Is Anonymous Sharing Enabled?
  const isAnonymousSharingEnabled = useMemo(() => {
    const cap = String(SP_OVERVIEW.sharingCapability || '').toLowerCase()
    return cap.includes('anyone') || cap === 'externaluserandguestsharing'
  }, [SP_OVERVIEW.sharingCapability])

  // Filter & Sort Sites
  const filteredSites = useMemo(() => {
    const q = siteQuery.trim().toLowerCase()

    const rows = SITE_TABLE_ROWS.filter((s) => {
      // Type filter
      if (typeFilter !== 'all' && s.type !== typeFilter) return false

      // Activity filter
      const activityDays = typeof s.activityAgeDays === 'number' ? s.activityAgeDays : null
      if (activityFilter === 'active90' && (activityDays === null || activityDays >= 90)) {
        return false
      }
      if (activityFilter === 'inactive90_179' && (activityDays === null || activityDays < 90 || activityDays >= 180)) {
        return false
      }
      if (activityFilter === 'inactive180' && (activityDays === null || activityDays < 180)) {
        return false
      }
      if (activityFilter === 'unreported' && activityDays !== null) {
        return false
      }
      if (activityFilter === 'concealed' && s.activityDataStatus !== 'identifiers-concealed') {
        return false
      }

      // Storage filter
      const hasUsed = typeof s.storageUsedGB === 'number'
      const hasReportedUsed = s.storageUsedSource === 'microsoft-d180-usage-report'
      const hasQuota = typeof s.storageQuotaGB === 'number' && s.storageQuotaGB > 0
      const pct =
        hasUsed && hasQuota
          ? Math.min(100, Math.round((s.storageUsedGB / s.storageQuotaGB) * 100))
          : null

      if (storageFilter === 'reported' && !hasReportedUsed) return false
      if (storageFilter === 'unreported' && hasReportedUsed) return false
      if (storageFilter === 'nearCapacity' && (pct === null || pct < 80)) return false

      // Activity-date evidence is distinct from whether a D180 usage row
      // matched this site. This filter intentionally covers only the date.
      const hasActivity = Boolean(s.lastActivityAt || s.lastActivity)
      if (reportAvailabilityFilter === 'reported' && !hasActivity) return false
      if (reportAvailabilityFilter === 'missing' && hasActivity) return false

      // Usage Deleted filter
      const deletedState = sharePointReportedDeletedState(s)
      if (usageDeletedFilter === 'deleted' && deletedState !== true) return false
      if (usageDeletedFilter === 'active' && deletedState !== false) return false

      // Search query
      if (!q) return true
      const name = String(s.name || '').toLowerCase()
      const url = String(s.url || '').toLowerCase()
      return name.includes(q) || url.includes(q)
    })

    return [...rows].sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1
      if (sortKey === 'name') {
        return String(a.name || '').localeCompare(String(b.name || '')) * dir
      }
      if (sortKey === 'type') {
        return String(a.type || '').localeCompare(String(b.type || '')) * dir
      }
      if (sortKey === 'storageUsedGB') {
        const aVal = typeof a.storageUsedGB === 'number' ? a.storageUsedGB : -1
        const bVal = typeof b.storageUsedGB === 'number' ? b.storageUsedGB : -1
        return (aVal - bVal) * dir
      }
      if (sortKey === 'utilization') {
        const aPct =
          typeof a.storageUsedGB === 'number' && typeof a.storageQuotaGB === 'number' && a.storageQuotaGB > 0
            ? (a.storageUsedGB / a.storageQuotaGB) * 100
            : -1
        const bPct =
          typeof b.storageUsedGB === 'number' && typeof b.storageQuotaGB === 'number' && b.storageQuotaGB > 0
            ? (b.storageUsedGB / b.storageQuotaGB) * 100
            : -1
        return (aPct - bPct) * dir
      }
      if (sortKey === 'lastActivityAt') {
        const aTime = a.lastActivityAt || a.lastActivity ? new Date(a.lastActivityAt || a.lastActivity).getTime() : -1
        const bTime = b.lastActivityAt || b.lastActivity ? new Date(b.lastActivityAt || b.lastActivity).getTime() : -1
        return (aTime - bTime) * dir
      }
      return 0
    })
  }, [
    SITE_TABLE_ROWS,
    siteQuery,
    typeFilter,
    activityFilter,
    storageFilter,
    reportAvailabilityFilter,
    usageDeletedFilter,
    sortKey,
    sortDir,
  ])

  const isFilterActive =
    Boolean(siteQuery.trim()) ||
    typeFilter !== 'all' ||
    activityFilter !== 'all' ||
    storageFilter !== 'all' ||
    reportAvailabilityFilter !== 'all' ||
    usageDeletedFilter !== 'all'

  function handleClearFilters() {
    setSiteQuery('')
    setTypeFilter('all')
    setActivityFilter('all')
    setStorageFilter('all')
    setReportAvailabilityFilter('all')
    setUsageDeletedFilter('all')
  }

  const openDrawer = (site: any, e: React.MouseEvent | React.KeyboardEvent) => {
    lastTriggerRef.current = e.currentTarget as HTMLElement
    setSelectedSite(site)
  }

  return (
    <div className="mt-1 space-y-4 text-slate-900 dark:text-slate-100">
      {/* ================= SINGLE MERGED PAGE HEADER ================= */}
      <div className="flex flex-col gap-2.5 pb-3 border-b border-slate-200 dark:border-slate-800">
        {/* Top Row: Title, Mobile Trigger, Tenant Context, Sync Now Button */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {onOpenMobileNav && (
              <button
                type="button"
                onClick={onOpenMobileNav}
                className="md:hidden inline-flex items-center justify-center p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                aria-label="Open navigation menu"
              >
                <Menu className="h-4 w-4" />
              </button>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
                  SharePoint & OneDrive
                </h1>
                {tenantName && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                    <Building2 className="h-3.5 w-3.5 text-slate-500 shrink-0" aria-hidden="true" />
                    <span className="truncate max-w-[140px] sm:max-w-[220px]">{tenantName}</span>
                    {primaryDomain && <span className="text-slate-400 font-normal">({primaryDomain})</span>}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Review discovered sites, reported usage, tenant controls, and administrative evidence.
              </p>
            </div>
          </div>

          {/* Action Header Group: Single Sync Now Button */}
          {onSync && (
            <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
              <Button
                type="button"
                size="sm"
                disabled={isSyncing}
                onClick={onSync}
                className="h-8 text-xs font-medium gap-1.5 cursor-pointer shrink-0 bg-teal-600 hover:bg-teal-700 text-white dark:bg-teal-600 dark:hover:bg-teal-500 border-none shadow-2xs"
                aria-label="Synchronize SharePoint & OneDrive dataset"
                aria-live="polite"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')} aria-hidden="true" />
                <span>
                  {isSyncing
                    ? 'Syncing...'
                    : syncState === 'success'
                      ? 'Synced'
                      : syncState === 'fail'
                        ? 'Sync failed'
                        : 'Sync Now'}
                </span>
              </Button>
            </div>
          )}
        </div>

        {/* Operational Status Ribbon */}
        <div className="flex flex-wrap items-center gap-y-1.5 gap-x-3 sm:gap-x-4 text-xs text-slate-600 dark:text-slate-400 bg-slate-50/90 dark:bg-slate-800/60 px-3.5 py-2 rounded-xl border border-slate-200/80 dark:border-slate-800 shadow-2xs">
          <div className="flex items-center gap-1.5 font-medium shrink-0">
            <span className={cn('h-2 w-2 rounded-full shrink-0', syncStatusDotColor)} aria-hidden="true" />
            <span className="text-slate-900 dark:text-slate-100 font-semibold">{syncStatusLabel}</span>
          </div>

          <span className="text-slate-300 dark:text-slate-700 hidden sm:inline" aria-hidden="true">•</span>

          <div className="shrink-0">
            <span className="text-slate-500 dark:text-slate-400">Coverage: </span>
            <span className="font-medium text-slate-800 dark:text-slate-200">
              {serviceFreshnessText || 'D180 usage report active'}
            </span>
          </div>

          <span className="text-slate-300 dark:text-slate-700 hidden sm:inline" aria-hidden="true">•</span>

          <div className="shrink-0">
            <span className="text-slate-500 dark:text-slate-400">Last attempt: </span>
            <span className="font-medium text-slate-800 dark:text-slate-200" title={lastAttemptRaw || undefined}>
              {lastAttemptFormatted}
            </span>
          </div>

          <span className="text-slate-300 dark:text-slate-700 hidden sm:inline" aria-hidden="true">•</span>

          <div className="shrink-0">
            <span className="text-slate-500 dark:text-slate-400">Last success: </span>
            <span className="font-medium text-slate-800 dark:text-slate-200" title={lastSuccessRaw || undefined}>
              {lastSuccessFormatted}
            </span>
          </div>

          <span className="text-slate-300 dark:text-slate-700 hidden sm:inline" aria-hidden="true">•</span>

          <div className="shrink-0">
            <span className="text-slate-500 dark:text-slate-400">MS report refreshed: </span>
            <span className="font-medium text-slate-800 dark:text-slate-200">{reportRefreshedFormatted}</span>
          </div>
        </div>

        {/* Sync Failure Banner */}
        {isLastKnownData && (
          <div className="text-xs px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="truncate">
                Showing last successful collection from {lastSuccessFormatted}. Recent sync attempt failed.
              </span>
            </div>
            {onSync && (
              <button
                type="button"
                onClick={onSync}
                className="underline hover:no-underline text-amber-900 dark:text-amber-200 font-medium shrink-0 cursor-pointer"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      {/* ================= EXACTLY THREE PRIMARY TABS ================= */}
      <div className="border-b border-slate-200 dark:border-slate-800">
        <div role="tablist" aria-label="SharePoint workspace navigation" className="flex gap-2 overflow-x-auto no-scrollbar">
          <button
            type="button"
            role="tab"
            id="tab-overview"
            aria-selected={activeTab === 'overview'}
            aria-controls="panel-overview"
            onClick={() => setActiveTab('overview')}
            className={cn(
              'px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500',
              activeTab === 'overview'
                ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-400 font-semibold'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            )}
          >
            Overview
          </button>

          <button
            type="button"
            role="tab"
            id="tab-sites"
            aria-selected={activeTab === 'sites'}
            aria-controls="panel-sites"
            onClick={() => setActiveTab('sites')}
            className={cn(
              'px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 flex items-center gap-1.5',
              activeTab === 'sites'
                ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-400 font-semibold'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            )}
          >
            <span>Sites</span>
            <span className="text-[11px] px-1.5 py-0.2 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-normal">
              {siteCountLabel}
            </span>
          </button>

          <button
            type="button"
            role="tab"
            id="tab-tenant-settings"
            aria-selected={activeTab === 'tenant-settings'}
            aria-controls="panel-tenant-settings"
            onClick={() => setActiveTab('tenant-settings')}
            className={cn(
              'px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500',
              activeTab === 'tenant-settings'
                ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-400 font-semibold'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            )}
          >
            Org-wide Settings
          </button>
        </div>
      </div>

      {/* ================= TAB 1: OVERVIEW ================= */}
      {activeTab === 'overview' && (
        <div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview" className="space-y-4">
          {/* 1. Primary 4 KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            {/* Card 1: Discovered SharePoint sites (Teal/Blue Accent) */}
            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs hover:shadow-xs transition-shadow">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-medium">
                <span>Discovered SharePoint sites</span>
                <div className="p-1.5 rounded-lg bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 border border-teal-100 dark:border-teal-900/40">
                  <Globe className="h-4 w-4" aria-hidden="true" />
                </div>
              </div>
              <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                {siteCountLabel}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                Discovered Graph sites
              </div>
            </div>

            {/* Card 2: Reported storage used (Indigo/Blue Accent) */}
            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs hover:shadow-xs transition-shadow">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-medium">
                <span>Reported storage used</span>
                <div className="p-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900/40">
                  <HardDrive className="h-4 w-4" aria-hidden="true" />
                </div>
              </div>
              <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                {formatStorageGB(totalStorageUsedGB)}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                {totalStorageUsedGB !== null
                  ? 'Microsoft D180 usage report storage'
                  : bestEffortDriveStorageUsedGB !== null
                    ? `D180 storage not reported · Graph default-drive estimate ${formatStorageGB(bestEffortDriveStorageUsedGB)}`
                    : 'D180 storage not reported by Microsoft'}
              </div>
            </div>

            {/* Card 3: Inactive sites (Amber Accent) */}
            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs hover:shadow-xs transition-shadow">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-medium">
                <span>Inactive sites</span>
                <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border border-amber-100 dark:border-amber-900/40">
                  <Clock className="h-4 w-4" aria-hidden="true" />
                </div>
              </div>
              <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                {calculatedInactive90Count ?? 'Not reported'}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                {calculatedInactive90Count === null
                  ? 'Microsoft D180 activity evidence unavailable'
                  : 'No activity in 90+ days'}
              </div>
            </div>

            {/* Card 4: Activity coverage (Emerald Accent) */}
            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs hover:shadow-xs transition-shadow">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-medium">
                <span>D180 usage matches</span>
                <div className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-900/40">
                  <Activity className="h-4 w-4" aria-hidden="true" />
                </div>
              </div>
              <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                {matchedUsageSiteCount ?? 'Not reported'}{' '}
                {matchedUsageSiteCount !== null && (
                  <span className="text-sm font-normal text-slate-500">/ {siteCountLabel}</span>
                )}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                {matchedUsageSiteCount === null
                  ? 'Microsoft usage-row matching unavailable'
                  : SP_SITES.length > 0
                    ? `${Math.round((matchedUsageSiteCount / SP_SITES.length) * 100)}% matched · ${sitesWithActivityCount} with reported activity dates`
                    : 'No sites'}
              </div>
            </div>
          </div>

          {/* Unified Section Card: SharePoint usage & posture */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs overflow-hidden">
            {/* Card Header Title */}
            <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-1 rounded-md bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400">
                  <FileText className="h-4 w-4" aria-hidden="true" />
                </div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white">SharePoint usage & posture</h2>
              </div>
            </div>

            {/* Desktop 60% / 40% split with divider, stacked on mobile */}
            <div className="flex flex-col lg:flex-row divide-y lg:divide-y-0 lg:divide-x divide-slate-100 dark:divide-slate-800 items-start">
              {/* LEFT 60%: USAGE & ACTIVITY */}
              <div className="w-full lg:w-[60%] p-5 space-y-4">
                <h3 className="text-base font-bold text-slate-900 dark:text-white">Usage & activity</h3>

                {/* Storage Visual Anchor */}
                <div className="space-y-1">
                  <div className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                    {formatStorageGB(totalStorageUsedGB)}
                  </div>
                  <div className="text-xs text-slate-600 dark:text-slate-400 font-medium">
                    of {formatStorageGB(aggregateReportedAllocationGB)} aggregate D180 reported allocation
                    {totalStorageUsedGB !== null && aggregateReportedAllocationGB !== null && aggregateReportedAllocationGB > 0 && (
                      <span> · {totalStorageUsedGB / aggregateReportedAllocationGB < 0.0001 ? '<0.01%' : `${((totalStorageUsedGB / aggregateReportedAllocationGB) * 100).toFixed(2)}%`}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {totalStorageUsedGB !== null
                      ? 'Microsoft D180 usage report'
                      : bestEffortDriveStorageUsedGB !== null
                        ? `D180 usage unavailable; Graph default-drive estimate is ${formatStorageGB(bestEffortDriveStorageUsedGB)}`
                        : 'Microsoft D180 usage not reported'}
                  </div>
                </div>

                {/* Activity Distribution */}
                <div className="space-y-2.5 pt-1">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-semibold text-slate-700 dark:text-slate-300">Activity-date coverage</span>
                    <span className="text-slate-500 dark:text-slate-400">
                      {sharePointView.usageReport.exactClaimsAvailable
                        ? matchedUsageSiteCount !== null
                          ? `${sitesWithActivityCount} of ${matchedUsageSiteCount} matched sites include a reported date`
                          : `${sitesWithActivityCount} sites include a reported activity date; matched-row total unavailable`
                        : 'Not available'}
                    </span>
                  </div>
                  {/* Slim, softly colored horizontal segmented bar */}
                  {SP_SITES.length > 0 && activityDistributionAvailable ? (
                    <>
                      <div className="h-2 rounded-full overflow-hidden flex bg-slate-100 dark:bg-slate-800 w-full" aria-hidden="true">
                        {activityDistribution.activeUnder90 > 0 && (
                          <div
                            className="bg-teal-600/80 dark:bg-teal-500/80 h-full transition-all"
                            style={{ width: `${(activityDistribution.activeUnder90 / SP_SITES.length) * 100}%` }}
                          />
                        )}
                        {activityDistribution.inactive90To179 > 0 && (
                          <div
                            className="bg-amber-500/80 dark:bg-amber-500/80 h-full transition-all"
                            style={{ width: `${(activityDistribution.inactive90To179 / SP_SITES.length) * 100}%` }}
                          />
                        )}
                        {activityDistribution.inactive180Plus > 0 && (
                          <div
                            className="bg-orange-600/80 dark:bg-orange-500/80 h-full transition-all"
                            style={{ width: `${(activityDistribution.inactive180Plus / SP_SITES.length) * 100}%` }}
                          />
                        )}
                        {activityDistribution.unreported > 0 && (
                          <div
                            className="bg-slate-300 dark:bg-slate-600 h-full transition-all"
                            style={{ width: `${(activityDistribution.unreported / SP_SITES.length) * 100}%` }}
                          />
                        )}
                      </div>

                      {/* Accessible Text */}
                      <div className="sr-only">
                        Activity distribution across {sharePointView.inventory.countAtLeast ? 'at least ' : ''}{SP_SITES.length} projected sites: {activityDistribution.activeUnder90} active under 90 days, {activityDistribution.inactive90To179} inactive 90 to 179 days, {activityDistribution.inactive180Plus} inactive 180 or more days, and {activityDistribution.unreported} activity not reported.
                      </div>

                      {/* Clean 2-column 2-row legend (No boxes, no colons after labels) */}
                      <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-xs pt-1">
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-teal-600/80 dark:bg-teal-500/80 shrink-0" aria-hidden="true" />
                          <span className="text-slate-600 dark:text-slate-400">Active under 90 days</span>
                          <span className="font-bold text-slate-900 dark:text-white ml-auto">{activityDistribution.activeUnder90}</span>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-amber-500/80 dark:bg-amber-500/80 shrink-0" aria-hidden="true" />
                          <span className="text-slate-600 dark:text-slate-400">Inactive 90–179 days</span>
                          <span className="font-bold text-slate-900 dark:text-white ml-auto">{activityDistribution.inactive90To179}</span>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-orange-600/80 dark:bg-orange-500/80 shrink-0" aria-hidden="true" />
                          <span className="text-slate-600 dark:text-slate-400">Inactive 180+ days</span>
                          <span className="font-bold text-slate-900 dark:text-white ml-auto">{activityDistribution.inactive180Plus}</span>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-slate-300 dark:bg-slate-600 shrink-0" aria-hidden="true" />
                          <span className="text-slate-600 dark:text-slate-400">Activity not reported</span>
                          <span className="font-bold text-slate-900 dark:text-white ml-auto">{activityDistribution.unreported}</span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-slate-500 italic">
                      {SP_SITES.length === 0
                        ? 'No sites available for activity distribution.'
                        : 'Microsoft D180 activity distribution is not available for this projection.'}
                    </div>
                  )}
                </div>

                {/* Data Quality Footer Line */}
                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <User className="h-3.5 w-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                    <span>
                      {sitesMissingOwnerCount === null
                        ? 'Reported-owner coverage not available from the current D180 projection'
                        : <>Reported owner unavailable for <strong className="text-slate-800 dark:text-slate-200">{sitesMissingOwnerCount}</strong> matched D180 usage rows</>}
                    </span>
                  </div>

                  <span className="text-slate-300 dark:text-slate-700 hidden sm:inline" aria-hidden="true">•</span>

                  <div className="flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                    <span>
                      {usageReportMarkedDeletedCount !== null
                        ? `${usageReportMarkedDeletedCount} rows marked deleted in current D180 report`
                        : 'Marked-deleted status not available'}
                    </span>
                  </div>
                </div>
              </div>

              {/* RIGHT 40%: SHARING POSTURE */}
              <div className="w-full lg:w-[40%] p-5 space-y-4">
                <h3 className="text-base font-bold text-slate-900 dark:text-white">Sharing posture</h3>

                {/* Restrained Teal/Blue Tinted Header Area */}
                <div className="p-3 rounded-lg bg-teal-50/50 dark:bg-teal-950/30 border border-teal-100/80 dark:border-teal-900/40 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">Tenant External Sharing Capability</span>
                    <Badge
                      variant={isAnonymousSharingEnabled ? 'outline' : 'secondary'}
                      className={cn(
                        'font-semibold text-xs shrink-0',
                        isAnonymousSharingEnabled && 'text-amber-800 dark:text-amber-300 border-amber-300 bg-amber-100/50 dark:bg-amber-900/40'
                      )}
                    >
                      {formatSharingCapability(SP_OVERVIEW.sharingCapability)}
                    </Badge>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                    Governs tenant-wide default external file and folder sharing boundaries across SharePoint and OneDrive.
                  </p>
                </div>

                {/* Vertical Definition List */}
                <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs space-y-2 pt-1">
                  <div className="flex items-center justify-between py-1.5">
                    <span className="text-slate-600 dark:text-slate-400">Domain restrictions</span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {!rawTenantSettings?.sharingDomainRestrictionMode || String(rawTenantSettings.sharingDomainRestrictionMode).toLowerCase() === 'none'
                        ? 'No domain restriction'
                        : String(rawTenantSettings.sharingDomainRestrictionMode)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between py-1.5">
                    <span className="text-slate-600 dark:text-slate-400">External resharing</span>
                    <Badge variant="outline" className="font-medium text-xs">
                      {formatBooleanSetting(rawTenantSettings?.isResharingByExternalUsersEnabled)}
                    </Badge>
                  </div>

                  <div className="flex items-center justify-between py-1.5">
                    <span className="text-slate-600 dark:text-slate-400">Invitee matching</span>
                    <Badge variant="outline" className="font-medium text-xs">
                      {formatBooleanSetting(rawTenantSettings?.isRequireAcceptingUserToMatchInvitedUserEnabled)}
                    </Badge>
                  </div>
                </div>

                {/* Limitation Note */}
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-tight pt-1">
                  These are tenant-wide controls and do not represent effective per-site sharing, guests, members, owner rosters, administrators or permissions.
                </p>
              </div>
            </div>
          </div>

          {/* Conditional Small OneDrive Summary Card on Overview (Only when accounts exist) */}
          {hasTypedOneDriveCollection && (
            <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3 shadow-2xs">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <Cloud className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">OneDrive Summary</h2>
                </div>
                <Badge variant="secondary" className="text-xs">
                  {ONEDRIVE_ACCOUNTS.length} Reported Accounts
                </Badge>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <span className="text-slate-500 block">Reported Accounts</span>
                  <span className="font-bold text-slate-900 dark:text-white">{ONEDRIVE_ACCOUNTS.length}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">Default Storage Limit</span>
                  <span className="font-bold text-slate-900 dark:text-white">
                    {formatMBToReadable(rawTenantSettings?.personalSiteDefaultStorageLimitInMB)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">Retention Period</span>
                  <span className="font-bold text-slate-900 dark:text-white">
                    {sharePointRetentionDaysLabel(rawTenantSettings?.deletedUserPersonalSiteRetentionPeriodInDays)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">Status</span>
                  <Badge variant="outline" className="text-emerald-700 dark:text-emerald-300 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40">
                    Accounts Discovered
                  </Badge>
                </div>
              </div>
            </div>
          )}

          {/* 3. Compact Data Coverage & Freshness Strip */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3 shadow-2xs">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-slate-500" />
                <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">Data coverage & freshness</h2>
              </div>
              <span className="text-xs text-slate-400 font-mono">Collection Timeline</span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 space-y-1">
                <div className="text-slate-500 flex items-center justify-between">
                  <span>Graph site inventory</span>
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                </div>
                <div className="font-bold text-slate-900 dark:text-slate-100">{siteCountLabel} discovered</div>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 space-y-1">
                <div className="text-slate-500 flex items-center justify-between">
                  <span>SharePoint report</span>
                  <span className={cn('h-2 w-2 rounded-full', reportRefreshedRaw ? 'bg-emerald-500' : 'bg-slate-400')} />
                </div>
                <div className="font-bold text-slate-900 dark:text-slate-100">{reportRefreshedFormatted}</div>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 space-y-1">
                <div className="text-slate-500 flex items-center justify-between">
                  <span>OneDrive report window</span>
                  <span className="h-2 w-2 rounded-full bg-slate-400" />
                </div>
                <div className="font-bold text-slate-900 dark:text-slate-100">D30 (30 days)</div>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 space-y-1">
                <div className="text-slate-500 flex items-center justify-between">
                  <span>HawkView sync</span>
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                </div>
                <div className="font-bold text-slate-900 dark:text-slate-100">{lastSuccessFormatted}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 2: SITES ================= */}
      {activeTab === 'sites' && (
        <div role="tabpanel" id="panel-sites" aria-labelledby="tab-sites" className="space-y-3">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 p-3 rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
            <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
              {/* Search */}
              <div className="relative min-w-[200px] flex-1 max-w-sm">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
                <Input
                  type="text"
                  placeholder="Search by site name or URL..."
                  value={siteQuery}
                  onChange={(e) => setSiteQuery(e.target.value)}
                  className="pl-8 h-8 text-xs bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700"
                />
                {siteQuery && (
                  <button
                    type="button"
                    onClick={() => setSiteQuery('')}
                    className="absolute right-2 top-2 text-slate-400 hover:text-slate-600"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Site Type Select */}
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as any)}
                className="h-8 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-teal-500 cursor-pointer"
              >
                <option value="all">All Types</option>
                <option value="Microsoft 365 group site">Microsoft 365 Group Site</option>
                <option value="SharePoint site">SharePoint Site</option>
                <option value="Communication site">Communication Site</option>
                <option value="OneDrive">OneDrive</option>
              </select>

              {/* Activity State Select */}
              <select
                value={activityFilter}
                onChange={(e) => setActivityFilter(e.target.value as any)}
                className="h-8 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-teal-500 cursor-pointer"
              >
                <option value="all">All Activity States</option>
                <option value="active90">Active within 90 days</option>
                <option value="inactive90_179">Inactive 90–179 days</option>
                <option value="inactive180">Inactive 180+ days</option>
                <option value="unreported">Activity not reported</option>
                <option value="concealed">Identifiers concealed</option>
              </select>

              {/* Storage Utilization Select */}
              <select
                value={storageFilter}
                onChange={(e) => setStorageFilter(e.target.value as any)}
                className="h-8 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-teal-500 cursor-pointer"
              >
                <option value="all">All Storage States</option>
                <option value="reported">Reported Storage</option>
                <option value="unreported">Unreported Storage</option>
                <option value="nearCapacity">Near Capacity (80%+)</option>
              </select>

              {/* More Filters Toggle */}
              <div className="relative">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsMoreFiltersOpen(!isMoreFiltersOpen)}
                  className="h-8 text-xs gap-1.5 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                >
                  <Filter className="h-3.5 w-3.5" />
                  <span>More Filters</span>
                  {(reportAvailabilityFilter !== 'all' || usageDeletedFilter !== 'all') && (
                    <span className="h-1.5 w-1.5 rounded-full bg-teal-600" />
                  )}
                </Button>

                {isMoreFiltersOpen && (
                  <div className="absolute left-0 mt-1 z-30 w-64 p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl space-y-3 text-xs">
                    <div className="flex items-center justify-between pb-1.5 border-b border-slate-100 dark:border-slate-800 font-semibold text-slate-900 dark:text-white">
                      <span>More Filters</span>
                      <button type="button" onClick={() => setIsMoreFiltersOpen(false)} className="text-slate-400 hover:text-slate-600">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div>
                      <label className="text-[11px] font-medium text-slate-500 block mb-1">Activity Date Availability</label>
                      <select
                        value={reportAvailabilityFilter}
                        onChange={(e) => setReportAvailabilityFilter(e.target.value as any)}
                        className="w-full h-8 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 text-slate-700 dark:text-slate-300"
                      >
                        <option value="all">All Sites</option>
                        <option value="reported">Activity Date Reported</option>
                        <option value="missing">Activity Date Not Reported</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-[11px] font-medium text-slate-500 block mb-1">Usage Report Deleted Flag</label>
                      <select
                        value={usageDeletedFilter}
                        onChange={(e) => setUsageDeletedFilter(e.target.value as any)}
                        className="w-full h-8 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 text-slate-700 dark:text-slate-300"
                      >
                        <option value="all">All Statuses</option>
                        <option value="deleted">Marked Deleted in Report</option>
                        <option value="active">Not Marked Deleted in Report</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right Group: Columns Popover & Clear Filters */}
            <div className="flex items-center gap-2">
              {isFilterActive && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClearFilters}
                  className="h-8 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-200"
                >
                  Clear Filters
                </Button>
              )}

              {/* Column Chooser Popover */}
              <div className="relative">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsColumnManagerOpen(!isColumnManagerOpen)}
                  className="h-8 text-xs gap-1.5 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  <span>Columns</span>
                </Button>

                {isColumnManagerOpen && (
                  <div className="absolute right-0 mt-1 z-30 w-56 p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl space-y-2 text-xs">
                    <div className="flex items-center justify-between pb-1.5 border-b border-slate-100 dark:border-slate-800 font-semibold text-slate-900 dark:text-white">
                      <span>Optional Columns</span>
                      <button type="button" onClick={() => setIsColumnManagerOpen(false)} className="text-slate-400 hover:text-slate-600">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                      {OPTIONAL_COLUMNS.map((col) => {
                        const isChecked = visibleOptionalCols.has(col.key)
                        return (
                          <label key={col.key} className="flex items-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => {
                                const next = new Set(visibleOptionalCols)
                                if (isChecked) next.delete(col.key)
                                else next.add(col.key)
                                setVisibleOptionalCols(next)
                              }}
                              className="rounded border-slate-300 dark:border-slate-700 text-teal-600 focus:ring-teal-500"
                            />
                            <span>{col.label}</span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Table Container */}
          <div className="overflow-x-auto rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-50/90 dark:bg-slate-800/90 backdrop-blur z-10 text-slate-500 font-semibold border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">
                    <button
                      type="button"
                      onClick={() => {
                        if (sortKey === 'name') setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
                        else {
                          setSortKey('name')
                          setSortDir('asc')
                        }
                      }}
                      className="flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                    >
                      <span>Site</span>
                      <ArrowUpDown className="h-3 w-3 text-slate-400" />
                    </button>
                  </th>

                  <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">Type</th>

                  <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">
                    <button
                      type="button"
                      onClick={() => {
                        if (sortKey === 'storageUsedGB') setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
                        else {
                          setSortKey('storageUsedGB')
                          setSortDir('desc')
                        }
                      }}
                      className="flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                    >
                      <span>Storage</span>
                      <ArrowUpDown className="h-3 w-3 text-slate-400" />
                    </button>
                  </th>

                  <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">
                    <button
                      type="button"
                      onClick={() => {
                        if (sortKey === 'lastActivityAt') setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
                        else {
                          setSortKey('lastActivityAt')
                          setSortDir('desc')
                        }
                      }}
                      className="flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                    >
                      <span>Last Activity</span>
                      <ArrowUpDown className="h-3 w-3 text-slate-400" />
                    </button>
                  </th>

                  <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">Activity State</th>

                  {/* Dynamic Optional Columns */}
                  {visibleOptionalCols.has('fileCount') && <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">File Count</th>}
                  {visibleOptionalCols.has('activeFileCount') && <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">Active Files</th>}
                  {visibleOptionalCols.has('pageViews') && <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">Page Views</th>}
                  {visibleOptionalCols.has('visitedPages') && <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">Visited Pages</th>}
                  {visibleOptionalCols.has('reportRefreshedAt') && <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">MS Refreshed</th>}
                  {visibleOptionalCols.has('reportPeriod') && <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">Period</th>}
                  {visibleOptionalCols.has('createdDate') && <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">Created</th>}
                  {visibleOptionalCols.has('graphLastModified') && <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">Graph Modified</th>}
                  {visibleOptionalCols.has('rootTemplate') && <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">Template</th>}
                  {visibleOptionalCols.has('usageReportDeleted') && <th className="p-3 font-semibold text-slate-700 dark:text-slate-300">Deleted Flag</th>}

                  <th className="p-3 font-semibold text-slate-700 dark:text-slate-300 text-right">Action</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredSites.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6 + visibleOptionalCols.size}
                      className="p-8 text-center text-slate-500 dark:text-slate-400"
                    >
                      <Globe className="h-8 w-8 mx-auto text-slate-300 mb-2" />
                      <div className="font-semibold text-slate-900 dark:text-white">No SharePoint sites found</div>
                      <div className="text-xs text-slate-500 mt-1">
                        {isFilterActive ? 'Try adjusting your search query or filters.' : 'No sites discovered for this tenant.'}
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredSites.map((site, index) => {
                    const activityDate = site.lastActivityAt || site.lastActivity
                    const activityDays = typeof site.activityAgeDays === 'number'
                      ? site.activityAgeDays
                      : null

                    const hasUsed = typeof site.storageUsedGB === 'number'
                    const hasQuota = typeof site.storageQuotaGB === 'number' && site.storageQuotaGB > 0
                    const storagePct =
                      hasUsed && hasQuota
                        ? Math.min(100, Math.round((site.storageUsedGB / site.storageQuotaGB) * 100))
                        : null

                    const deletedState = sharePointReportedDeletedState(site)
                    const isMarkedDeleted = deletedState === true

                    return (
                      <tr
                        key={site.id || site.url || index}
                        onClick={(e) => openDrawer(site, e)}
                        className="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 cursor-pointer transition-colors group"
                      >
                        {/* Site Name & URL */}
                        <td className="p-3 min-w-[220px]">
                          <div className="font-bold text-slate-900 dark:text-white group-hover:text-teal-600 dark:group-hover:text-teal-400 transition-colors flex items-center gap-1.5">
                            <span className="truncate max-w-[260px]">{site.name || 'Unnamed Site'}</span>
                            {isMarkedDeleted && (
                              <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300 bg-amber-50 dark:bg-amber-950/40 shrink-0">
                                Marked Deleted
                              </Badge>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[260px]">
                            {site.url || 'No URL'}
                          </div>
                        </td>

                        {/* Type */}
                        <td className="p-3 whitespace-nowrap">
                          <Badge variant="secondary" className="font-normal text-[11px]">
                            {site.type || 'SharePoint site'}
                          </Badge>
                        </td>

                        {/* Storage */}
                        <td className="p-3 whitespace-nowrap">
                          <div className="font-semibold text-slate-900 dark:text-slate-100">
                            {formatStorageGB(site.storageUsedGB)}
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-400">
                            {site.storageUsedSource === 'microsoft-d180-usage-report'
                              ? 'D180 usage report'
                              : site.storageUsedSource === 'graph-default-drive-best-effort'
                                ? 'Graph default-drive estimate'
                                : site.storageUsedSource === 'legacy-backend'
                                  ? 'Legacy collected value'
                                  : 'Source unavailable'}
                          </div>
                          {storagePct !== null && (
                            <div className="w-20 bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full mt-1 overflow-hidden">
                              <div
                                className={cn(
                                  'h-full rounded-full',
                                  storagePct > 80 ? 'bg-amber-500' : 'bg-teal-600'
                                )}
                                style={{ width: `${storagePct}%` }}
                              />
                            </div>
                          )}
                        </td>

                        {/* Last Activity */}
                        <td className="p-3 whitespace-nowrap text-slate-600 dark:text-slate-300 font-medium">
                          {formatDate(activityDate)}
                        </td>

                        {/* Activity State Badge */}
                        <td className="p-3 whitespace-nowrap">
                          {site.activityDataStatus === 'identifiers-concealed' ? (
                            <Badge variant="outline" className="text-purple-700 dark:text-purple-300 border-purple-200 bg-purple-50 dark:bg-purple-950/40 font-medium">
                              Concealed
                            </Badge>
                          ) : activityDays === null ? (
                            <Badge variant="outline" className="text-slate-500 border-slate-200 font-medium">
                              Unreported
                            </Badge>
                          ) : activityDays < 90 ? (
                            <Badge variant="outline" className="text-emerald-700 dark:text-emerald-300 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 font-medium">
                              Active
                            </Badge>
                          ) : activityDays < 180 ? (
                            <Badge variant="outline" className="text-amber-700 dark:text-amber-300 border-amber-200 bg-amber-50 dark:bg-amber-950/40 font-medium">
                              Inactive 90–179d
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-red-700 dark:text-red-300 border-red-200 bg-red-50 dark:bg-red-950/40 font-medium">
                              Inactive 180d+
                            </Badge>
                          )}
                        </td>

                        {/* Optional Columns */}
                        {visibleOptionalCols.has('fileCount') && <td className="p-3 font-medium">{site.fileCount ?? 'Not reported'}</td>}
                        {visibleOptionalCols.has('activeFileCount') && <td className="p-3 font-medium">{site.activeFileCount ?? 'Not reported'}</td>}
                        {visibleOptionalCols.has('pageViews') && <td className="p-3 font-medium">{site.pageViews ?? 'Not reported'}</td>}
                        {visibleOptionalCols.has('visitedPages') && <td className="p-3 font-medium">{site.visitedPages ?? 'Not reported'}</td>}
                        {visibleOptionalCols.has('reportRefreshedAt') && <td className="p-3">{formatDate(site.reportRefreshedAt)}</td>}
                        {visibleOptionalCols.has('reportPeriod') && <td className="p-3">{site.reportPeriod || 'Not reported'}</td>}
                        {visibleOptionalCols.has('createdDate') && <td className="p-3">{formatDate(site.createdDate)}</td>}
                        {visibleOptionalCols.has('graphLastModified') && <td className="p-3">{formatDate(site.graphLastModified)}</td>}
                        {visibleOptionalCols.has('rootTemplate') && <td className="p-3">{site.rootTemplate || 'Not reported'}</td>}
                        {visibleOptionalCols.has('usageReportDeleted') && (
                          <td className="p-3">
                            {deletedState === true ? 'Yes' : deletedState === false ? 'No' : 'Not reported'}
                          </td>
                        )}

                        {/* Action Chevron */}
                        <td className="p-3 text-right">
                          <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-teal-600 dark:group-hover:text-teal-400 transition-colors inline-block" />
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ================= TAB 3: ORG-WIDE SETTINGS ================= */}
      {activeTab === 'tenant-settings' && (
        <div role="tabpanel" id="panel-tenant-settings" aria-labelledby="tab-tenant-settings" className="space-y-4">
          {/* Main Neutral Outer Card */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs overflow-hidden">

            {/* Header Area */}
            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 border border-teal-100 dark:border-teal-900/40 shrink-0">
                  <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-slate-900 dark:text-white">
                      Organization-wide SharePoint & OneDrive settings
                    </h2>
                    <Badge variant="outline" className="text-[11px] font-medium text-slate-500 border-slate-200 dark:border-slate-700 shrink-0">
                      Read-Only View
                    </Badge>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Review tenant-level sharing, storage, access, sync, creation, and notification controls.
                  </p>
                </div>
              </div>

              {/* Source and Freshness Metadata */}
              <div className="text-[11px] text-slate-500 dark:text-slate-400 sm:text-right shrink-0">
                <div>Source: <span className="font-medium text-slate-700 dark:text-slate-300">Microsoft Graph API</span></div>
                <div>Refreshed: <span className="font-medium text-slate-700 dark:text-slate-300">{reportRefreshedFormatted || 'Current'}</span></div>
              </div>
            </div>

            {/* At a Glance Status Strip (Top of card, up to 4 key controls) */}
            <div className="px-5 py-3 bg-slate-50/80 dark:bg-slate-800/40 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="font-semibold text-slate-700 dark:text-slate-300 shrink-0">
                At a glance
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {/* 1. External Sharing Capability */}
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500">Sharing:</span>
                  <Badge
                    variant={isAnonymousSharingEnabled ? 'outline' : 'secondary'}
                    className={cn(
                      'text-[11px] font-semibold',
                      isAnonymousSharingEnabled && 'text-amber-800 dark:text-amber-300 border-amber-300 bg-amber-50 dark:bg-amber-950/40'
                    )}
                  >
                    {formatSharingCapability(rawTenantSettings?.sharingCapability || SP_OVERVIEW.sharingCapability)}
                  </Badge>
                </div>

                {/* 2. Legacy Authentication */}
                {rawTenantSettings?.isLegacyAuthProtocolsEnabled !== undefined && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-500">Legacy Auth:</span>
                    <Badge
                      variant={rawTenantSettings.isLegacyAuthProtocolsEnabled ? 'outline' : 'secondary'}
                      className={cn(
                        'text-[11px] font-semibold',
                        rawTenantSettings.isLegacyAuthProtocolsEnabled && 'text-amber-800 dark:text-amber-300 border-amber-300 bg-amber-50 dark:bg-amber-950/40'
                      )}
                    >
                      {rawTenantSettings.isLegacyAuthProtocolsEnabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </div>
                )}

                {/* 3. Storage-Limit Mode */}
                {rawTenantSettings?.isSitesStorageLimitAutomatic !== undefined && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-500">Storage Limit:</span>
                    <Badge variant="secondary" className="text-[11px] font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200/60 dark:border-indigo-800/60">
                      {rawTenantSettings.isSitesStorageLimitAutomatic ? 'Automatic' : 'Manual'}
                    </Badge>
                  </div>
                )}

                {/* 4. Unmanaged Sync Restriction */}
                {rawTenantSettings?.isUnmanagedSyncAppForTenantRestricted !== undefined && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-500">Unmanaged Sync:</span>
                    <Badge variant="outline" className="text-[11px] font-semibold text-teal-700 dark:text-teal-300 bg-teal-50/50 dark:bg-teal-950/30 border-teal-200/60 dark:border-teal-800/60">
                      {rawTenantSettings.isUnmanagedSyncAppForTenantRestricted ? 'Restricted' : 'Not restricted'}
                    </Badge>
                  </div>
                )}
              </div>
            </div>

            {/* Editorial Two-Column Layout */}
            <div className="flex flex-col lg:flex-row divide-y lg:divide-y-0 lg:divide-x divide-slate-100 dark:divide-slate-800 items-start">

              {/* LEFT COLUMN */}
              <div className="w-full lg:w-1/2 p-5 space-y-6">

                {/* Section 1: Sharing & guest access */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded-md bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400">
                      <Share2 className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-slate-900 dark:text-white">Sharing & guest access</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Tenant-wide sharing boundaries and domain restrictions.</p>
                    </div>
                  </div>

                  <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">External sharing capability</span>
                      <Badge
                        variant={isAnonymousSharingEnabled ? 'outline' : 'secondary'}
                        className={cn(
                          'font-semibold',
                          isAnonymousSharingEnabled && 'text-amber-800 dark:text-amber-300 border-amber-300 bg-amber-50 dark:bg-amber-950/40'
                        )}
                      >
                        {formatSharingCapability(rawTenantSettings?.sharingCapability || SP_OVERVIEW.sharingCapability)}
                      </Badge>
                    </div>

                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">Domain restrictions</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        {!rawTenantSettings?.sharingDomainRestrictionMode || String(rawTenantSettings.sharingDomainRestrictionMode).toLowerCase() === 'none'
                          ? 'No domain restriction'
                          : String(rawTenantSettings.sharingDomainRestrictionMode)}
                      </span>
                    </div>

                    {/* Allowed Domains Chips */}
                    {Array.isArray(rawTenantSettings?.sharingAllowedDomainList) && (
                      <div className="py-2 space-y-1">
                        <span className="text-slate-600 dark:text-slate-400 block">Allowed domains list</span>
                        <div className="flex flex-wrap items-center gap-1">
                          {(expandedSettingsLists['allowedDomains']
                            ? rawTenantSettings.sharingAllowedDomainList
                            : rawTenantSettings.sharingAllowedDomainList.slice(0, 3)
                          ).map((d: string, i: number) => (
                            <Badge key={i} variant="outline" className="text-[10px] font-mono text-slate-700 dark:text-slate-300">{d}</Badge>
                          ))}
                          {rawTenantSettings.sharingAllowedDomainList.length > 3 && (
                            <button
                              type="button"
                              onClick={() => toggleSettingsListExpand('allowedDomains')}
                              className="text-xs text-teal-600 dark:text-teal-400 hover:underline cursor-pointer ml-1 font-medium"
                            >
                              {expandedSettingsLists['allowedDomains'] ? 'Show less' : `Show ${rawTenantSettings.sharingAllowedDomainList.length - 3} more`}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">External resharing</span>
                      <Badge variant="outline" className="font-semibold">
                        {formatBooleanSetting(rawTenantSettings?.isResharingByExternalUsersEnabled)}
                      </Badge>
                    </div>

                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">Invitee identity matching</span>
                      <Badge variant="outline" className="font-semibold">
                        {formatBooleanSetting(rawTenantSettings?.isRequireAcceptingUserToMatchInvitedUserEnabled)}
                      </Badge>
                    </div>
                  </div>
                </div>

                {/* Section 2: Access & sessions */}
                <div className="space-y-3 pt-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded-md bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400">
                      <Lock className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-slate-900 dark:text-white">Access & sessions</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Authentication protocols and unmanaged device access controls.</p>
                    </div>
                  </div>

                  <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">Legacy authentication protocols</span>
                      <Badge
                        variant={rawTenantSettings?.isLegacyAuthProtocolsEnabled ? 'outline' : 'secondary'}
                        className={cn(
                          'font-semibold',
                          rawTenantSettings?.isLegacyAuthProtocolsEnabled && 'text-amber-800 dark:text-amber-300 border-amber-300 bg-amber-50 dark:bg-amber-950/40'
                        )}
                      >
                        {formatBooleanSetting(rawTenantSettings?.isLegacyAuthProtocolsEnabled)}
                      </Badge>
                    </div>

                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">Unmanaged device sync restriction</span>
                      <Badge variant="outline" className="font-semibold">
                        {formatBooleanSetting(rawTenantSettings?.isUnmanagedSyncAppForTenantRestricted)}
                      </Badge>
                    </div>
                  </div>
                </div>

                {/* Section 3: Storage & lifecycle */}
                <div className="space-y-3 pt-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded-md bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400">
                      <HardDrive className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-slate-900 dark:text-white">Storage & lifecycle</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Default quota allocation modes and personal site retention.</p>
                    </div>
                  </div>

                  <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">Site storage limit mode</span>
                      <Badge variant="secondary" className="font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200/60 dark:border-indigo-800/60">
                        {rawTenantSettings?.isSitesStorageLimitAutomatic !== undefined
                          ? rawTenantSettings.isSitesStorageLimitAutomatic
                            ? 'Automatic'
                            : 'Manual'
                          : 'Not available'}
                      </Badge>
                    </div>

                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">Site default storage limit</span>
                      <span
                        className="font-semibold text-slate-800 dark:text-slate-200 cursor-help"
                        title={typeof rawTenantSettings?.siteCreationDefaultStorageLimitInMB === 'number' ? `${rawTenantSettings.siteCreationDefaultStorageLimitInMB.toLocaleString()} MB` : undefined}
                      >
                        {formatMBToReadable(rawTenantSettings?.siteCreationDefaultStorageLimitInMB)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">OneDrive personal storage default</span>
                      <span
                        className="font-semibold text-slate-800 dark:text-slate-200 cursor-help"
                        title={typeof rawTenantSettings?.personalSiteDefaultStorageLimitInMB === 'number' ? `${rawTenantSettings.personalSiteDefaultStorageLimitInMB.toLocaleString()} MB` : undefined}
                      >
                        {formatMBToReadable(rawTenantSettings?.personalSiteDefaultStorageLimitInMB)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">Deleted OneDrive retention period</span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        {sharePointRetentionDaysLabel(rawTenantSettings?.deletedUserPersonalSiteRetentionPeriodInDays)}
                      </span>
                    </div>
                  </div>
                </div>

              </div>

              {/* RIGHT COLUMN */}
              <div className="w-full lg:w-1/2 p-5 space-y-6">

                {/* Section 4: Sync & client controls */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded-md bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400">
                      <Laptop className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-slate-900 dark:text-white">Sync & client controls</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Desktop sync client restrictions and platform policies.</p>
                    </div>
                  </div>

                  <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">Mac sync client restriction</span>
                      <Badge variant="outline" className="font-semibold">
                        {formatBooleanSetting(rawTenantSettings?.isMacSyncClientRestricted)}
                      </Badge>
                    </div>

                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">Sync app domain restriction</span>
                      <Badge variant="outline" className="font-semibold">
                        {formatBooleanSetting(rawTenantSettings?.isSyncAppForTenantRestricted)}
                      </Badge>
                    </div>
                  </div>
                </div>

                {/* Section 5: Site creation & content */}
                <div className="space-y-3 pt-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded-md bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400">
                      <Globe className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-slate-900 dark:text-white">Site creation & content</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">User self-service site provisioning and content tools.</p>
                    </div>
                  </div>

                  <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">Site creation UI</span>
                      <Badge variant="outline" className="font-semibold">
                        {formatBooleanSetting(rawTenantSettings?.isSiteCreationUIEnabled)}
                      </Badge>
                    </div>

                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">Microsoft Loop integration</span>
                      <Badge variant="outline" className="font-semibold">
                        {formatBooleanSetting(rawTenantSettings?.isLoopEnabled)}
                      </Badge>
                    </div>

                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">Page commenting</span>
                      <Badge variant="outline" className="font-semibold">
                        {formatBooleanSetting(rawTenantSettings?.isCommentingOnSitePagesEnabled)}
                      </Badge>
                    </div>
                  </div>
                </div>

                {/* Section 6: Notifications & regional */}
                <div className="space-y-3 pt-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                      <Bell className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-slate-900 dark:text-white">Notifications & regional</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">System notification preferences and default regional behavior.</p>
                    </div>
                  </div>

                  <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                    <div className="flex items-center justify-between py-2">
                      <span className="text-slate-600 dark:text-slate-400">Tenant notification preference</span>
                      <Badge variant="outline" className="font-semibold">
                        {formatBooleanSetting(rawTenantSettings?.isTenantNotificationEnabled)}
                      </Badge>
                    </div>
                  </div>
                </div>

              </div>
            </div>

            {/* Bottom Limitation Note */}
            <div className="px-5 py-3.5 bg-slate-50/60 dark:bg-slate-800/30 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 flex items-start gap-1.5 leading-relaxed">
              <Info className="h-3.5 w-3.5 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                These are organization-wide tenant controls and may not represent the effective configuration of an individual site. HawkView currently displays these settings as read-only.
                {reportRefreshedFormatted && ` (Collection source: Microsoft Graph API · Refreshed ${reportRefreshedFormatted})`}
              </span>
            </div>

          </div>
        </div>
      )}

      {/* ================= SITE ROW DETAIL DRAWER ================= */}
      {selectedSite && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex justify-end"
          onClick={() => setSelectedSite(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Site details for ${selectedSite.name || 'Site'}`}
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:w-[540px] md:w-[600px] h-full bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl overflow-y-auto p-6 space-y-5 animate-in slide-in-from-right-full duration-200"
          >
            {/* Drawer Header */}
            <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                    {selectedSite.name || 'Unnamed Site'}
                  </h2>
                  <Badge variant="secondary" className="text-xs font-medium">
                    {selectedSite.type || 'SharePoint site'}
                  </Badge>
                </div>
                {selectedSite.url && (
                  <a
                    href={selectedSite.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-teal-600 dark:text-teal-400 hover:underline flex items-center gap-1 mt-1 truncate max-w-md"
                  >
                    <span>{selectedSite.url}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSelectedSite(null)}
                className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg cursor-pointer"
                aria-label="Close drawer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Section 1: Identity */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Site Identity</h3>
              <div className="grid grid-cols-2 gap-2 text-xs bg-slate-50 dark:bg-slate-800/50 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                <div>
                  <span className="text-slate-400 block">Reported Owner</span>
                  <span className="font-semibold text-slate-900 dark:text-white">
                    {selectedSite.ownerDisplayName || selectedSite.ownerPrincipalName || 'Not reported'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">Root Template</span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">{selectedSite.rootTemplate || 'Not reported'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Created Date</span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">{formatDate(selectedSite.createdDate)}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Graph Last Modified</span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">{formatDate(selectedSite.graphLastModified)}</span>
                </div>
              </div>
            </div>

            {/* Section 2: Usage & Activity */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Usage & Activity</h3>
              <div className="grid grid-cols-2 gap-2 text-xs bg-slate-50 dark:bg-slate-800/50 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                <div>
                  <span className="text-slate-400 block">Last Reported Activity</span>
                  <span className="font-semibold text-slate-900 dark:text-white">
                    {formatDate(selectedSite.lastActivityAt || selectedSite.lastActivity)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">File Count</span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">{selectedSite.fileCount ?? 'Not reported'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Active File Count</span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">{selectedSite.activeFileCount ?? 'Not reported'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Page Views</span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">{selectedSite.pageViews ?? 'Not reported'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Visited Pages</span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">{selectedSite.visitedPages ?? 'Not reported'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">MS Report Refreshed</span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">{formatDate(selectedSite.reportRefreshedAt)}</span>
                </div>
              </div>
            </div>

            {/* Section 3: Storage */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Storage & Allocation</h3>
              <div className="grid grid-cols-2 gap-2 text-xs bg-slate-50 dark:bg-slate-800/50 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                <div>
                  <span className="text-slate-400 block">
                    {selectedSite.storageUsedSource === 'graph-default-drive-best-effort'
                      ? 'Best-effort Graph Drive Used'
                      : selectedSite.storageUsedSource === 'microsoft-d180-usage-report'
                        ? 'D180 Reported Storage Used'
                        : 'Storage Used'}
                  </span>
                  <span className="font-semibold text-slate-900 dark:text-white">{formatStorageGB(selectedSite.storageUsedGB)}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">
                    {selectedSite.storageUsedSource === 'graph-default-drive-best-effort'
                      ? 'Best-effort Graph Drive Total'
                      : 'D180 Reported Allocation'}
                  </span>
                  <span className="font-semibold text-slate-900 dark:text-white">
                    {formatStorageGB(
                      selectedSite.storageUsedSource === 'graph-default-drive-best-effort'
                        ? selectedSite.bestEffortDriveStorageTotalGB
                        : selectedSite.storageQuotaGB
                    )}
                  </span>
                </div>
              </div>
            </div>

            {/* Section 4: Collection Details */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Collection Details</h3>
              <div className="text-xs bg-slate-50 dark:bg-slate-800/50 p-3 rounded-lg border border-slate-100 dark:border-slate-800 space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-400">Inventory Source:</span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">Microsoft Graph API</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Activity Report Window:</span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">D180 (180 Days)</span>
                </div>
              </div>
            </div>

            {/* Section 5: Limitations */}
            <div className="p-3 rounded-lg bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 text-xs text-amber-800 dark:text-amber-300 space-y-1">
              <div className="font-semibold flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5 shrink-0" />
                <span>Scope & Limitation Notices</span>
              </div>
              <ul className="list-disc list-inside space-y-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                <li>Reported owner is not a complete owner or administrator roster.</li>
                <li>Per-site members, guests, permissions and sharing configuration are not collected.</li>
                <li>Last reported activity reflects Microsoft&apos;s reporting coverage.</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
