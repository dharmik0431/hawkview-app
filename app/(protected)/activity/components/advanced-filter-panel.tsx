'use client'

import * as React from 'react'
import { X, RotateCcw, Filter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ActivityTab } from '../data/types'

export type AdvancedFiltersState = {
  // Sign-in filters
  signInStatus: string
  signInCA: string
  signInApp: string
  signInLocation: string
  signInIP: string
  signInClientApp: string
  signInOS: string
  signInRiskLevel: string

  // Audit filters
  auditResult: string
  auditActivity: string
  auditCategory: string
  auditService: string
  auditActor: string
  auditTargetType: string
}

export const initialAdvancedFilters: AdvancedFiltersState = {
  signInStatus: 'all',
  signInCA: 'all',
  signInApp: 'all',
  signInLocation: 'all',
  signInIP: 'all',
  signInClientApp: 'all',
  signInOS: 'all',
  signInRiskLevel: 'all',

  auditResult: 'all',
  auditActivity: 'all',
  auditCategory: 'all',
  auditService: 'all',
  auditActor: 'all',
  auditTargetType: 'all',
}

export type FilterOptions = {
  signInOptions: {
    statuses: string[]
    caResults: string[]
    apps: string[]
    locations: string[]
    ips: string[]
    clientApps: string[]
    osList: string[]
    riskLevels: string[]
  }
  auditOptions: {
    results: string[]
    activities: string[]
    categories: string[]
    services: string[]
    actors: string[]
    targetTypes: string[]
  }
}

export function AdvancedFilterPanel({
  tab,
  open,
  onClose,
  value,
  onChange,
  onClearTabFilters,
  options,
}: {
  tab: ActivityTab
  open: boolean
  onClose: () => void
  value: AdvancedFiltersState
  onChange: (val: AdvancedFiltersState) => void
  onClearTabFilters: () => void
  options: FilterOptions
}) {
  const panelRef = React.useRef<HTMLDivElement>(null)

  // Handle Escape key to close panel
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  const isSignIn = tab === 'signins'
  const signInOpts = options.signInOptions
  const auditOpts = options.auditOptions

  return (
    <div className="relative z-30">
      {/* Click outside backdrop */}
      <div
        className="fixed inset-0 z-20 bg-black/10 dark:bg-black/30 backdrop-blur-xs"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Popover Card */}
      <div
        ref={panelRef}
        role="dialog"
        aria-label={`Advanced filters for ${isSignIn ? 'Sign-in logs' : 'Audit logs'}`}
        className="absolute right-0 top-2 z-30 w-full sm:w-[500px] md:w-[600px] rounded-lg border bg-popover p-4 text-popover-foreground shadow-xl transition-all animate-in fade-in slide-in-from-top-2"
      >
        {/* Panel Header */}
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <h3 className="text-sm font-semibold">
              Filter {isSignIn ? 'Sign-in Logs' : 'Audit Logs'}
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClearTabFilters}
              className="h-8 gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Clear filters
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-8 w-8 rounded-full"
              aria-label="Close filters panel"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Panel Body - Fields Grid */}
        <div className="py-4 grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pr-1">
          {isSignIn ? (
            /* SIGN-IN FILTERS */
            <>
              {/* Status */}
              {signInOpts.statuses.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Status
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500"
                    value={value.signInStatus}
                    onChange={(e) =>
                      onChange({ ...value, signInStatus: e.target.value })
                    }
                  >
                    <option value="all">All Statuses</option>
                    {signInOpts.statuses.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Conditional Access */}
              {signInOpts.caResults.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Conditional Access
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500"
                    value={value.signInCA}
                    onChange={(e) =>
                      onChange({ ...value, signInCA: e.target.value })
                    }
                  >
                    <option value="all">All CA States</option>
                    {signInOpts.caResults.map((ca) => (
                      <option key={ca} value={ca}>
                        {ca}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Application */}
              {signInOpts.apps.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Application
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500"
                    value={value.signInApp}
                    onChange={(e) =>
                      onChange({ ...value, signInApp: e.target.value })
                    }
                  >
                    <option value="all">All Applications</option>
                    {signInOpts.apps.map((app) => (
                      <option key={app} value={app}>
                        {app}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Location */}
              {signInOpts.locations.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Location
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500"
                    value={value.signInLocation}
                    onChange={(e) =>
                      onChange({ ...value, signInLocation: e.target.value })
                    }
                  >
                    <option value="all">All Locations</option>
                    {signInOpts.locations.map((loc) => (
                      <option key={loc} value={loc}>
                        {loc}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* IP Address */}
              {signInOpts.ips.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    IP Address
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500 font-mono"
                    value={value.signInIP}
                    onChange={(e) =>
                      onChange({ ...value, signInIP: e.target.value })
                    }
                  >
                    <option value="all">All IP Addresses</option>
                    {signInOpts.ips.map((ip) => (
                      <option key={ip} value={ip}>
                        {ip}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Client Application */}
              {signInOpts.clientApps.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Client Application
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500"
                    value={value.signInClientApp}
                    onChange={(e) =>
                      onChange({ ...value, signInClientApp: e.target.value })
                    }
                  >
                    <option value="all">All Client Apps</option>
                    {signInOpts.clientApps.map((ca) => (
                      <option key={ca} value={ca}>
                        {ca}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Operating System */}
              {signInOpts.osList.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Operating System
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500"
                    value={value.signInOS}
                    onChange={(e) =>
                      onChange({ ...value, signInOS: e.target.value })
                    }
                  >
                    <option value="all">All Operating Systems</option>
                    {signInOpts.osList.map((os) => (
                      <option key={os} value={os}>
                        {os}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Risk Level */}
              {signInOpts.riskLevels.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Risk Level
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500"
                    value={value.signInRiskLevel}
                    onChange={(e) =>
                      onChange({ ...value, signInRiskLevel: e.target.value })
                    }
                  >
                    <option value="all">All Risk Levels</option>
                    {signInOpts.riskLevels.map((rl) => (
                      <option key={rl} value={rl}>
                        {rl}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          ) : (
            /* AUDIT FILTERS */
            <>
              {/* Result */}
              {auditOpts.results.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Result
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500"
                    value={value.auditResult}
                    onChange={(e) =>
                      onChange({ ...value, auditResult: e.target.value })
                    }
                  >
                    <option value="all">All Results</option>
                    {auditOpts.results.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Activity */}
              {auditOpts.activities.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Activity
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500"
                    value={value.auditActivity}
                    onChange={(e) =>
                      onChange({ ...value, auditActivity: e.target.value })
                    }
                  >
                    <option value="all">All Activities</option>
                    {auditOpts.activities.map((act) => (
                      <option key={act} value={act}>
                        {act}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Category */}
              {auditOpts.categories.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Category
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500"
                    value={value.auditCategory}
                    onChange={(e) =>
                      onChange({ ...value, auditCategory: e.target.value })
                    }
                  >
                    <option value="all">All Categories</option>
                    {auditOpts.categories.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Service */}
              {auditOpts.services.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Service
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500"
                    value={value.auditService}
                    onChange={(e) =>
                      onChange({ ...value, auditService: e.target.value })
                    }
                  >
                    <option value="all">All Services</option>
                    {auditOpts.services.map((srv) => (
                      <option key={srv} value={srv}>
                        {srv}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Performed by */}
              {auditOpts.actors.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Performed by
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500"
                    value={value.auditActor}
                    onChange={(e) =>
                      onChange({ ...value, auditActor: e.target.value })
                    }
                  >
                    <option value="all">All Actors</option>
                    {auditOpts.actors.map((act) => (
                      <option key={act} value={act}>
                        {act}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Target Type */}
              {auditOpts.targetTypes.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Target Type
                  </label>
                  <select
                    className="w-full h-9 rounded-md border bg-background px-3 text-xs focus:ring-2 focus:ring-blue-500"
                    value={value.auditTargetType}
                    onChange={(e) =>
                      onChange({ ...value, auditTargetType: e.target.value })
                    }
                  >
                    <option value="all">All Target Types</option>
                    {auditOpts.targetTypes.map((tt) => (
                      <option key={tt} value={tt}>
                        {tt}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}
        </div>

        {/* Panel Footer */}
        <div className="pt-3 border-t border-border flex items-center justify-end">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onClose}
            className="text-xs font-medium"
          >
            Apply & Close
          </Button>
        </div>
      </div>
    </div>
  )
}
