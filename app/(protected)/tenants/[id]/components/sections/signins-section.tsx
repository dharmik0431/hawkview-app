'use client'

import { useMemo, useState, useEffect } from 'react'
import maplibregl from 'maplibre-gl'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Search,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Map as MapIcon,
  List as ListIcon,
  CheckCircle2,
  XCircle,
  Globe,
  Info,
  AlertTriangle,
} from 'lucide-react'
import type { TenantSyncStatus } from '@/types/tenant-data'
import type { ServiceSyncFreshness } from '@/types/tenant-data'
import type { PilotEvidenceView } from '@/lib/tenants/collection-readiness'

export type SignInResult = 'Success' | 'Failure'

export type SignInEvent = {
  id: string
  userId: string
  userDisplayName: string
  userPrincipalName: string
  createdAt: string
  ipAddress: string
  result: SignInResult
  appDisplayName: string
  clientAppUsed: string
  country: string
  city?: string
  state?: string
  latitude: number
  longitude: number
  riskLevel?: 'low' | 'medium' | 'high'
  dataSource?: 'entra-sign-in-logs' | 'microsoft-365-management-activity'
  isLimited?: boolean
}

export type TimeWindow = '24h' | '7d' | '30d'

interface SignInActivitySectionProps {
  signIns: SignInEvent[]
  signInView: 'list' | 'map'
  onSignInViewChange: (view: 'list' | 'map') => void
  syncStatus?: TenantSyncStatus
  freshness?: ServiceSyncFreshness | null
  signInEvidence?: PilotEvidenceView['signIns'] | null
}

function formatSignInTime(dateStr: string) {
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return dateStr
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d)
  } catch {
    return dateStr
  }
}

function withinTimeWindow(createdAtIso: string, window: TimeWindow): boolean {
  try {
    const t = new Date(createdAtIso).getTime()
    if (isNaN(t)) return false
    const now = new Date().getTime()
    const diffHours = (now - t) / (1000 * 3600)
    if (window === '24h') return diffHours <= 24
    if (window === '7d') return diffHours <= 24 * 7
    if (window === '30d') return diffHours <= 24 * 30
    return true
  } catch {
    return true
  }
}

function escapeHtml(str: string) {
  if (!str) return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function cleanLocationPart(value?: string | null): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || /^(undefined|null|unknown)$/i.test(normalized)) return null
  return normalized
}

function formatLocation(event: SignInEvent): string {
  const parts = [event.city, event.state, event.country]
    .map(cleanLocationPart)
    .filter((part): part is string => Boolean(part))
  return Array.from(new Set(parts)).join(', ') || 'Location unavailable'
}

export default function SignInActivitySection({
  signIns,
  signInView,
  onSignInViewChange,
  syncStatus,
  freshness,
  signInEvidence,
}: SignInActivitySectionProps) {
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('24h')
  const [resultFilter, setResultFilter] = useState<
    'all' | 'Success' | 'Failure'
  >('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [mapLoadError, setMapLoadError] = useState<string | null>(null)
  const pageSize = 10
  const hasLimitedActivity = signInEvidence?.availability === 'CURRENT_LIMITED' &&
    signInEvidence.coverage === 'LIMITED' &&
    signInEvidence.selectedSource === 'OFFICE_365_ACTIVITY_FEED'
  const selectedEvidenceFailed = signInEvidence?.selectedSource !== null &&
    ['FAILED_TRANSIENT', 'STALE', 'BLOCKED_PERMISSION', 'BLOCKED_TENANT_CONFIGURATION'].includes(signInEvidence?.availability ?? '')
  const showCollectionFailure = selectedEvidenceFailed || (!signInEvidence?.selectedSource && syncStatus?.status === 'failed')
  const freshnessLabel = !freshness
    ? 'Freshness unavailable'
    : freshness.status === 'RUNNING'
      ? 'Syncing'
      : freshness.status === 'PARTIAL'
        ? `Partial — ${freshness.partialFailures.length} collector${freshness.partialFailures.length === 1 ? '' : 's'} need attention`
        : freshness.status === 'STALE' || freshness.freshnessStatus === 'STALE'
          ? 'Stale'
          : freshness.status === 'NOT_COLLECTED' || freshness.freshnessStatus === 'NEVER_SYNCED'
            ? 'Never synchronized'
            : freshness.lastSuccessfulCollectionAt
              ? `Updated ${formatSignInTime(freshness.lastSuccessfulCollectionAt)}`
              : 'Freshness unavailable'

  // Filtered dataset shared between Table and Map
  const filteredSignIns = useMemo(() => {
    return signIns.filter((e) => {
      if (!withinTimeWindow(e.createdAt, timeWindow)) return false
      if (resultFilter !== 'all' && e.result !== resultFilter) return false
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim()
        const matchUser =
          e.userDisplayName?.toLowerCase().includes(q) ||
          e.userPrincipalName?.toLowerCase().includes(q)
        const matchIp = e.ipAddress?.toLowerCase().includes(q)
        const matchApp = e.appDisplayName?.toLowerCase().includes(q)
        const matchLoc = formatLocation(e)
          .toLowerCase()
          .includes(q)
        if (!matchUser && !matchIp && !matchApp && !matchLoc) return false
      }
      return true
    })
  }, [signIns, timeWindow, resultFilter, searchQuery])

  // Events with valid coordinates for Map
  const mappedEvents = useMemo(() => {
    return filteredSignIns.filter(
      (e) =>
        typeof e?.longitude === 'number' &&
        typeof e?.latitude === 'number' &&
        !(e.longitude === 0 && e.latitude === 0)
    )
  }, [filteredSignIns])

  const unmappedCount = filteredSignIns.length - mappedEvents.length

  const uniqueLocationsCount = useMemo(() => {
    return new Set(mappedEvents.map(formatLocation)).size
  }, [mappedEvents])

  const mappedSuccessCount = useMemo(() => {
    return mappedEvents.filter((e) => e.result === 'Success').length
  }, [mappedEvents])

  const mappedFailureCount = useMemo(() => {
    return mappedEvents.filter((e) => e.result === 'Failure').length
  }, [mappedEvents])

  // Table pagination
  const totalPages = Math.max(1, Math.ceil(filteredSignIns.length / pageSize))
  const paginatedSignIns = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return filteredSignIns.slice(start, start + pageSize)
  }, [filteredSignIns, currentPage, pageSize])

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, resultFilter, timeWindow])

  // Map initialization effect
  useEffect(() => {
    if (signInView !== 'map' || mappedEvents.length === 0) return
    let map: any = null
    let markers: any[] = []
    let disposed = false
    let mapLoaded = false
    let readinessTimer: ReturnType<typeof setTimeout> | null = null

    const timer = setTimeout(() => {
      const el = document.getElementById('entra-signins-map-container')
      if (!el) return

      // A previous MapLibre instance leaves canvas children behind. Clearing
      // them makes switching back to Map deterministic, including in React
      // strict mode and after a failed dynamic import.
      el.replaceChildren()
      setMapLoadError(null)

      const initMap = () => {
        try {
          if (typeof maplibregl?.Map !== 'function') {
            throw new Error('Map library loaded without a Map constructor.')
          }
          if (disposed) return

          map = new maplibregl.Map({
            container: el,
            // Hosted OpenStreetMap-based vector style; no client API key.
            // This URL can be swapped for a self-hosted style later.
            style: 'https://tiles.openfreemap.org/styles/liberty',
            center: [0, 20],
            zoom: 1.5,
            minZoom: 1,
            maxZoom: 12,
            attributionControl: false,
          })

          map.addControl(
            new maplibregl.NavigationControl({ showCompass: true }),
            'top-right'
          )

          // In embedded previews, WebGL can fail without throwing from the
          // constructor. Detect that case rather than leaving a blank panel.
          readinessTimer = setTimeout(() => {
            if (!disposed && !mapLoaded) {
              setMapLoadError(
                'The interactive map renderer did not become ready in this browser.'
              )
              try {
                map?.remove()
              } catch {}
            }
          }, 5000)

          map.on('load', () => {
            if (disposed) return
            mapLoaded = true
            if (readinessTimer) clearTimeout(readinessTimer)

            mappedEvents.forEach((e) => {
              const dot = document.createElement('div')
              dot.style.width = '12px'
              dot.style.height = '12px'
              dot.style.borderRadius = '999px'
              dot.style.border = '2px solid #ffffff'
              dot.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)'
              dot.style.backgroundColor =
                e.result === 'Failure' ? '#ef4444' : '#22c55e'
              dot.style.cursor = 'pointer'

              const cityCountry = formatLocation(e)
              const popupDiv = document.createElement('div')
              popupDiv.className = 'p-1 text-xs font-sans text-slate-900'
              popupDiv.innerHTML = `
                <div style="font-weight:700; font-size:13px; color:#0f172a; margin-bottom:2px;">${escapeHtml(e.userDisplayName)}</div>
                <div style="font-size:11px; color:#64748b; margin-bottom:8px;">${escapeHtml(e.userPrincipalName)}</div>
                <div style="display:grid; gap:4px; font-size:11px; color:#334155;">
                  <div><strong>Location:</strong> ${escapeHtml(cityCountry)}</div>
                  <div><strong>Application:</strong> ${escapeHtml(e.appDisplayName)}</div>
                  <div><strong>Result:</strong> <span style="color:${e.result === 'Success' ? '#16a34a' : '#dc2626'}; font-weight:600;">${e.result}</span></div>
                  <div><strong>Time:</strong> ${escapeHtml(formatSignInTime(e.createdAt))}</div>
                  <div><strong>IP Address:</strong> <code style="background:#f1f5f9; padding:1px 5px; border-radius:4px; font-family:monospace; color:#0f172a;">${escapeHtml(e.ipAddress)}</code></div>
                </div>
              `

              const popup = new maplibregl.Popup({
                offset: 12,
                closeButton: true,
              }).setDOMContent(popupDiv)

              const marker = new maplibregl.Marker({ element: dot })
                .setLngLat([e.longitude, e.latitude])
                .setPopup(popup)
                .addTo(map)

              markers.push(marker)
            })

            const coords = mappedEvents.map((x) => [x.longitude, x.latitude])
            if (coords.length >= 2) {
              const bounds = coords.reduce(
                (b: any, c: any) => b.extend(c),
                new maplibregl.LngLatBounds(
                  coords[0] as [number, number],
                  coords[0] as [number, number]
                )
              )
              map.fitBounds(bounds, { padding: 50, maxZoom: 6, duration: 400 })
            } else if (coords.length === 1) {
              map.setCenter(coords[0])
              map.setZoom(5)
            }
          })

          map.on('error', (event: any) => {
            const message = event?.error?.message
            if (message) {
              console.warn(`Sign-in map resource error: ${message}`)
            }
          })
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Unknown map loading error.'
          console.error('Failed to load sign-in map', err)
          if (!disposed) setMapLoadError(message)
        }
      }

      initMap()
    }, 100)

    return () => {
      disposed = true
      clearTimeout(timer)
      if (readinessTimer) clearTimeout(readinessTimer)
      for (const m of markers) m.remove()
      markers = []
      if (map) {
        try {
          map.remove()
        } catch {}
      }
    }
  }, [signInView, mappedEvents])

  const timeWindowLabel =
    timeWindow === '24h'
      ? 'Last 24 hours'
      : timeWindow === '7d'
        ? 'Last 7 days'
        : 'Last 30 days'

  return (
    <div className="mt-4 space-y-3">
      {showCollectionFailure && (
        <div role="alert" className="flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="text-sm font-semibold">Sign-in collection needs attention</p>
            <p className="mt-1 text-xs leading-5">
              {signIns.length
                ? 'The selected sign-in source is stale or failed. Retained events remain visible with their original timestamps while HawkView awaits current evidence.'
                : 'The selected sign-in source is stale, blocked, or failed and no retained events are available for this range.'}
            </p>
          </div>
        </div>
      )}
      {!showCollectionFailure && hasLimitedActivity && (
        <div role="status" aria-live="polite" className="flex gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
          <Info className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="text-sm font-semibold">Limited login activity</p>
            <p className="mt-1 text-xs leading-5">
              HawkView is using current login evidence from the Microsoft 365
              audit feed. This limited source does not include Conditional
              Access, risk, device, location, or authentication-step details.
            </p>
          </div>
        </div>
      )}
      <Card className="rounded-2xl shadow-sm bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800">
        <CardContent className="p-0">
        {/* Header & Controls Toolbar */}
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-50/50 dark:bg-slate-800/40 rounded-t-2xl">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
              Sign-in Activity
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Review sign-in evidence and the details supplied by the selected Microsoft source.
            </p>
            <p className="mt-1 text-xs font-medium text-slate-600 dark:text-slate-300" title={freshness?.lastSuccessfulCollectionAt ?? undefined}>
              {freshnessLabel}
            </p>
          </div>

          {/* Filter Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Search */}
            <div className="relative min-w-[180px] sm:min-w-[220px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search user, IP or app..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 pl-8 text-xs bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800"
              />
            </div>

            {/* Result Filter */}
            <select
              value={resultFilter}
              onChange={(e) => setResultFilter(e.target.value as any)}
              className="h-8 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
            >
              <option value="all">All Results</option>
              <option value="Success">Success Only</option>
              <option value="Failure">Failure Only</option>
            </select>

            {/* Time Window */}
            <select
              value={timeWindow}
              onChange={(e) => setTimeWindow(e.target.value as TimeWindow)}
              className="h-8 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 text-xs text-slate-800 dark:text-slate-200 focus:outline-none"
            >
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>

            {/* List / Map Switcher */}
            <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 p-0.5 bg-white dark:bg-slate-900">
              <button
                type="button"
                onClick={() => onSignInViewChange('list')}
                className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                  signInView === 'list'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <ListIcon className="h-3.5 w-3.5" />
                List
              </button>
              <button
                type="button"
                onClick={() => onSignInViewChange('map')}
                className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                  signInView === 'map'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <MapIcon className="h-3.5 w-3.5" />
                Map
              </button>
            </div>
          </div>
        </div>

        {/* LIST VIEW */}
        {signInView === 'list' && (
          <div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50/60 dark:bg-slate-800/30 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-muted-foreground uppercase">
                  <tr>
                    <th className="px-5 py-3">User</th>
                    <th className="px-5 py-3">Location</th>
                    <th className="px-5 py-3">IP Address</th>
                    <th className="px-5 py-3">Application</th>
                    <th className="px-5 py-3">Result</th>
                    <th className="px-5 py-3 text-right">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-800 dark:text-slate-200">
                  {paginatedSignIns.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-5 py-12 text-center text-muted-foreground"
                      >
                        {hasLimitedActivity && signIns.length === 0
                          ? 'No limited sign-in events were reported for this range.'
                          : 'No sign-in events match the selected filter criteria.'}
                      </td>
                    </tr>
                  ) : (
                    paginatedSignIns.map((e) => (
                      <tr
                        key={e.id}
                        className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30 transition-colors"
                      >
                        <td className="px-5 py-3">
                          <div className="font-semibold text-slate-900 dark:text-slate-100">
                            {e.userDisplayName}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {e.userPrincipalName}
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                            <MapPin className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                            <span>
                              {formatLocation(e)}
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-3 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                          {e.ipAddress}
                        </td>
                        <td className="px-5 py-3 font-medium">
                          {e.appDisplayName}
                        </td>
                        <td className="px-5 py-3">
                          {e.result === 'Success' ? (
                            <Badge className="bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800 font-normal text-[10px]">
                              Success
                            </Badge>
                          ) : (
                            <Badge className="bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800 font-normal text-[10px]">
                              Failure
                            </Badge>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right text-muted-foreground whitespace-nowrap">
                          {formatSignInTime(e.createdAt)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs bg-slate-50/30 dark:bg-slate-800/20 rounded-b-2xl">
              <span className="text-muted-foreground">
                Showing {filteredSignIns.length} event(s) · Page {currentPage}{' '}
                of {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  className="h-8 text-xs px-3 border-slate-200 dark:border-slate-800"
                >
                  <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= totalPages}
                  onClick={() =>
                    setCurrentPage((p) => Math.min(totalPages, p + 1))
                  }
                  className="h-8 text-xs px-3 border-slate-200 dark:border-slate-800"
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* MAP VIEW */}
        {signInView === 'map' && (
          <div className="p-5 space-y-4">
            {/* Map Summary Banner */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-800/50 text-xs">
              <div>
                <span className="text-muted-foreground text-[11px] block">
                  Mapped Events
                </span>
                <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  {mappedEvents.length} / {filteredSignIns.length}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground text-[11px] block">
                  Unique Locations
                </span>
                <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  {uniqueLocationsCount}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground text-[11px] block">
                  Successful Events
                </span>
                <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400">
                  {mappedSuccessCount}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground text-[11px] block">
                  Failed Events
                </span>
                <span className="text-sm font-bold text-red-600 dark:text-red-400">
                  {mappedFailureCount}
                </span>
              </div>
            </div>

            {unmappedCount > 0 && (
              <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800/60 p-2.5 rounded-lg">
                <Info className="h-4 w-4 shrink-0 text-amber-600" />
                <span>
                  {unmappedCount} event(s) could not be mapped on the globe due
                  to missing location coordinates.
                </span>
              </div>
            )}

            {/* Map Canvas */}
            <div className="relative">
              <div
                id="entra-signins-map-container"
                className="h-[420px] w-full rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-inner bg-slate-100 dark:bg-slate-950"
              />

              {/* Retained temporarily as source history while the actual map renders below. */}
              {/*
              {mappedEvents.length > 0 && (
                <div
                  className="absolute inset-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-950 cursor-grab active:cursor-grabbing touch-none"
                  onWheel={(event) => {
                    event.preventDefault()
                    handleMapWheel(event.deltaY)
                  }}
                  onMouseDown={(event) => startMapDrag(event.clientX, event.clientY)}
                  onMouseMove={(event) => moveMapDrag(event.clientX, event.clientY)}
                  onMouseUp={endMapDrag}
                  onMouseLeave={endMapDrag}
                >
                  <div
                  aria-label="Fallback geographic plot of mapped sign-in activity"
                  className="absolute inset-0 origin-center bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,.14),transparent_65%)] transition-transform duration-150"
                  style={{ transform: `translate(${mapOffset.x}px, ${mapOffset.y}px) scale(${mapZoom})` }}
                >
                  <WorldMapBackdrop />
                  {fallbackMapPoints.map(({ event, count, hasFailure }) => (
                    <button
                      type="button"
                      key={`${event.latitude}:${event.longitude}`}
                      aria-label={`Show ${count} sign-in event${count === 1 ? '' : 's'} near ${formatLocation(event)}`}
                      onMouseDown={(click) => click.stopPropagation()}
                      onClick={(click) => {
                        click.stopPropagation()
                        setSelectedMapPoint({ event, count, hasFailure })
                      }}
                      title={`${formatLocation(event)} — ${count} sign-in event${count === 1 ? '' : 's'}`}
                      className={`absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md transition-transform hover:scale-125 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${hasFailure ? 'bg-red-500' : 'bg-emerald-500'}`}
                      style={{
                        ...fallbackMapPosition(event.latitude, event.longitude),
                        width: count > 9 ? 18 : 12,
                        height: count > 9 ? 18 : 12,
                      }}
                    >
                      {count > 9 && (
                        <span className="absolute inset-0 flex items-center justify-center text-[7px] font-bold text-white">
                          {count > 99 ? '99+' : count}
                        </span>
                      )}
                    </button>
                  ))}
                  </div>
                  <div className="absolute left-4 top-4 z-20 max-w-sm rounded-lg border border-amber-200 bg-white/95 p-3 shadow-sm dark:border-amber-900 dark:bg-slate-900/95">
                    <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Sign-in world map
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Uses synchronized Microsoft location coordinates directly. Green markers are successful sign-ins; red markers include failures.
                    </p>
                  </div>
                  <div
                    className="absolute right-4 top-4 z-20 flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    <Button variant="ghost" size="icon" className="h-9 w-9 rounded-none" onClick={() => zoomMap('in')} aria-label="Zoom in">
                      <Plus className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-9 w-9 rounded-none border-y border-slate-200 dark:border-slate-700" onClick={() => zoomMap('out')} aria-label="Zoom out">
                      <Minus className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-9 w-9 rounded-none" onClick={resetMapView} aria-label="Reset map view">
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                  </div>
                  {selectedMapPoint && (
                    <div
                      className="absolute bottom-4 left-4 z-30 w-[min(360px,calc(100%-2rem))] rounded-xl border border-slate-200 bg-white p-4 shadow-lg dark:border-slate-700 dark:bg-slate-900"
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <Button variant="ghost" size="icon" className="absolute right-2 top-2 h-7 w-7" onClick={() => setSelectedMapPoint(null)} aria-label="Close sign-in details">
                        <X className="h-4 w-4" />
                      </Button>
                      <p className="pr-8 text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {selectedMapPoint.event.userDisplayName || 'Unknown user'}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {selectedMapPoint.event.userPrincipalName || 'User principal name unavailable'}
                      </p>
                      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                        <span className="text-muted-foreground">Location</span>
                        <span className="text-right font-medium">{formatLocation(selectedMapPoint.event)}</span>
                        <span className="text-muted-foreground">IP address</span>
                        <span className="text-right font-medium">{selectedMapPoint.event.ipAddress || 'Unavailable'}</span>
                        <span className="text-muted-foreground">Application</span>
                        <span className="text-right font-medium">{selectedMapPoint.event.appDisplayName || 'Microsoft 365'}</span>
                        <span className="text-muted-foreground">Result</span>
                        <span className={`text-right font-medium ${selectedMapPoint.hasFailure ? 'text-red-600' : 'text-emerald-600'}`}>
                          {selectedMapPoint.hasFailure ? 'Includes failures' : 'Successful'}
                        </span>
                        <span className="text-muted-foreground">Events at location</span>
                        <span className="text-right font-medium">{selectedMapPoint.count}</span>
                        <span className="text-muted-foreground">Latest event</span>
                        <span className="text-right font-medium">{formatSignInTime(selectedMapPoint.event.createdAt)}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
              */}

              {mappedEvents.length > 0 && !mapLoadError && (
                <div className="pointer-events-none absolute left-4 top-4 z-20 max-w-sm rounded-lg border border-slate-200 bg-white/95 p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900/95">
                  <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Sign-in world map
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Drag to pan, use the map controls to zoom, and select a marker for sign-in details. Green is successful; red is failed.
                  </p>
                </div>
              )}

              {mapLoadError && mappedEvents.length > 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-slate-50/95 p-6 text-center dark:bg-slate-900/95">
                  <AlertTriangle className="mb-2 h-9 w-9 text-amber-500" />
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Interactive map could not be loaded
                  </p>
                  <p className="mt-1 max-w-md text-xs text-muted-foreground">
                    {mapLoadError} Your sign-in events are still available in List view.
                  </p>
                </div>
              )}

              {mappedEvents.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-50/90 dark:bg-slate-900/90 rounded-xl p-6 text-center">
                  <Globe className="h-10 w-10 text-muted-foreground mb-2" />
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    No mapped geographic events
                  </p>
                  <p className="text-xs text-muted-foreground max-w-sm mt-1">
                    There are no sign-in events with valid location coordinates
                    matching your current filter selection ({timeWindowLabel}).
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
        </CardContent>
      </Card>
    </div>
  )
}
