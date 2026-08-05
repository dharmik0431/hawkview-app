'use client'

import React, { useState, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Building2,
  Search,
  ChevronRight,
  ArrowUpDown,
  X,
  Copy,
  Check,
  ShieldCheck,
  Info,
  Users,
  Key,
} from 'lucide-react'

export type EnterpriseAppItem = {
  id?: string
  objectId?: string
  appId?: string
  displayName?: string
  name?: string
  description?: string
  publisher?: string
  verifiedPublisher?: boolean
  isMicrosoft?: boolean
  servicePrincipalType?: string
  type?: string
  accountEnabled?: boolean
  enabled?: boolean
  accountStatus?: 'Enabled' | 'Disabled' | string
  appRoleAssignmentRequired?: boolean
  assignmentRequired?: boolean
  createdDateTime?: string
  createdDate?: string
  created?: string
  assignedUsers?: string[]
  assignedGroups?: string[]
  assignedServicePrincipals?: string[]
  users?: string[]
  groups?: string[]
  sps?: string[]
  totalAssigned?: number
  permsCount?: number
  risk?: string | null
  appRoles?: string[]
  delegatedGrants?: string[]
  applicationPermissions?: string[]
  resourceApi?: string
  consentType?: string
  grantedBy?: string
  lastSignIn?: string
  recentSignInCount?: number
  successfulSignIns?: number
  failedSignIns?: number
  lastActivity?: string
  riskLevel?: 'high' | 'medium' | 'low' | string
  riskFindings?: string[]
  recommendedAction?: string
}

interface EnterpriseAppsSectionProps {
  bundle: any
}

type EnterpriseAppSortField = 'name' | 'publisher' | 'type' | 'status' | 'created' | 'risk'
type SortOrder = 'asc' | 'desc'

export default function EnterpriseAppsSection({ bundle }: EnterpriseAppsSectionProps) {
  const rawApps = useMemo<EnterpriseAppItem[]>(() => {
    if (Array.isArray(bundle?.entra?.enterpriseApplications)) return bundle.entra.enterpriseApplications
    if (Array.isArray(bundle?.entra?.servicePrincipals)) return bundle.entra.servicePrincipals
    if (Array.isArray(bundle?.enterpriseApplications)) return bundle.enterpriseApplications
    if (Array.isArray(bundle?.servicePrincipals)) return bundle.servicePrincipals
    return []
  }, [bundle])

  const [query, setQuery] = useState('')
  const [publisherFilter, setPublisherFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [riskFilter, setRiskFilter] = useState<string>('all')
  const [sortField, setSortField] = useState<EnterpriseAppSortField>('name')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')
  const [selectedApp, setSelectedApp] = useState<EnterpriseAppItem | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const normalizedApps = useMemo(() => {
    return rawApps.map((a, idx) => {
      const name = a.displayName || a.name || `Enterprise App ${idx + 1}`
      const appId = a.appId || `app-id-${idx}`
      const objectId = a.objectId || a.id || `sp-id-${idx}`
      const publisher = a.publisher || 'Microsoft Services'
      const isMicrosoft = publisher.toLowerCase().includes('microsoft')
      const type = a.servicePrincipalType || 'Application'
      const enabled = typeof a.accountEnabled === 'boolean' ? a.accountEnabled : a.accountStatus !== 'Disabled'
      const assignmentRequired = Boolean(a.appRoleAssignmentRequired)
      const users = Array.isArray(a.assignedUsers) ? a.assignedUsers : []
      const groups = Array.isArray(a.assignedGroups) ? a.assignedGroups : []
      const sps = Array.isArray(a.assignedServicePrincipals) ? a.assignedServicePrincipals : []
      const totalAssigned = users.length + groups.length + sps.length
      const permsCount = (a.delegatedGrants?.length || 0) + (a.applicationPermissions?.length || 0)
      const created = a.createdDate || a.createdDateTime || 'Unknown'
      const risk = a.riskLevel || null

      return {
        ...a,
        id: objectId,
        objectId,
        appId,
        name,
        publisher,
        isMicrosoft,
        type,
        enabled,
        assignmentRequired,
        users,
        groups,
        sps,
        totalAssigned,
        permsCount,
        created,
        risk,
      }
    })
  }, [rawApps])

  const summary = useMemo(() => {
    const total = normalizedApps.length
    const enabled = normalizedApps.filter(a => a.enabled).length
    const disabled = normalizedApps.filter(a => !a.enabled).length
    const microsoft = normalizedApps.filter(a => a.isMicrosoft).length
    const thirdParty = normalizedApps.filter(a => !a.isMicrosoft).length
    const requiringAttention = normalizedApps.filter(a => a.risk === 'high' || (!a.enabled && a.lastSignIn)).length

    return { total, enabled, disabled, microsoft, thirdParty, requiringAttention }
  }, [normalizedApps])

  const filteredApps = useMemo(() => {
    const q = query.trim().toLowerCase()
    return normalizedApps.filter((a) => {
      const matchesText = !q || a.name.toLowerCase().includes(q) || a.publisher.toLowerCase().includes(q) || a.appId.toLowerCase().includes(q)
      const matchesPublisher = publisherFilter === 'all' || (publisherFilter === 'microsoft' ? a.isMicrosoft : !a.isMicrosoft)
      const matchesType = typeFilter === 'all' || a.type.toLowerCase() === typeFilter.toLowerCase()
      const matchesStatus = statusFilter === 'all' || (statusFilter === 'enabled' ? a.enabled : !a.enabled)
      const matchesRisk = riskFilter === 'all' || (a.risk && a.risk.toLowerCase() === riskFilter.toLowerCase())

      return matchesText && matchesPublisher && matchesType && matchesStatus && matchesRisk
    }).sort((a, b) => {
      let valA: any = a[sortField === 'name' ? 'name' : sortField === 'publisher' ? 'publisher' : sortField === 'type' ? 'type' : sortField === 'status' ? 'enabled' : sortField === 'created' ? 'created' : 'risk']
      let valB: any = b[sortField === 'name' ? 'name' : sortField === 'publisher' ? 'publisher' : sortField === 'type' ? 'type' : sortField === 'status' ? 'enabled' : sortField === 'created' ? 'created' : 'risk']

      if (typeof valA === 'string') valA = valA.toLowerCase()
      if (typeof valB === 'string') valB = valB.toLowerCase()

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1
      return 0
    })
  }, [normalizedApps, query, publisherFilter, typeFilter, statusFilter, riskFilter, sortField, sortOrder])

  const handleSort = (field: EnterpriseAppSortField) => {
    if (sortField === field) {
      setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortOrder('asc')
    }
  }

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(text)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const isSynchronized =
    bundle?.sync?.servicePrincipals?.status === 'succeeded' || rawApps.length > 0

  return (
    <div className="mt-5 space-y-5">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Total Apps</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.total : '—'}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Enabled</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.enabled : '—'}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Disabled</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.disabled : '—'}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Microsoft Apps</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.microsoft : '—'}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Third-party</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.thirdParty : '—'}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs col-span-2 sm:col-span-1">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Requires Attention</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.requiringAttention : '—'}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Table Card */}
      <Card className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm">
        <CardContent className="p-0">
          {/* Filters Bar */}
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="relative w-full sm:w-[280px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search application or publisher..."
                  className="pl-9 h-9 text-xs"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Publisher:</span>
                  <select
                    value={publisherFilter}
                    onChange={(e) => setPublisherFilter(e.target.value)}
                    className="h-8 px-2.5 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
                  >
                    <option value="all">All Publishers</option>
                    <option value="microsoft">Microsoft</option>
                    <option value="thirdParty">Third-party</option>
                  </select>
                </div>

                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Sign-in:</span>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="h-8 px-2.5 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
                  >
                    <option value="all">All Statuses</option>
                    <option value="enabled">Enabled</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>

                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Risk:</span>
                  <select
                    value={riskFilter}
                    onChange={(e) => setRiskFilter(e.target.value)}
                    className="h-8 px-2.5 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
                  >
                    <option value="all">All Risk</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="text-xs text-slate-500 dark:text-slate-400">
              Showing <span className="font-semibold text-slate-900 dark:text-white">{filteredApps.length}</span> of {normalizedApps.length} enterprise applications
            </div>
          </div>

          {/* Table */}
          {!isSynchronized ? (
            <div className="p-8 text-center space-y-2">
              <Info className="mx-auto h-8 w-8 text-slate-400" />
              <div className="text-sm font-semibold text-slate-900 dark:text-white">Enterprise Applications Not Synchronized</div>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                No Service Principal / Enterprise Application objects were found in the current tenant API payload. Entra ID enterprise app synchronization is required for this view.
              </p>
            </div>
          ) : filteredApps.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
              No enterprise applications match your filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400 uppercase tracking-wider font-medium select-none">
                    <th className="py-3 px-4">
                      <button
                        type="button"
                        onClick={() => handleSort('name')}
                        className="inline-flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-white"
                      >
                        <span>Enterprise Application</span>
                        <ArrowUpDown className="h-3 w-3 opacity-60" />
                      </button>
                    </th>
                    <th className="py-3 px-3">
                      <button
                        type="button"
                        onClick={() => handleSort('publisher')}
                        className="inline-flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-white"
                      >
                        <span>Publisher</span>
                        <ArrowUpDown className="h-3 w-3 opacity-60" />
                      </button>
                    </th>
                    <th className="py-3 px-3">Type</th>
                    <th className="py-3 px-3">Sign-in Enabled</th>
                    <th className="py-3 px-3">Assignment Required</th>
                    <th className="py-3 px-3">Assigned Identities</th>
                    <th className="py-3 px-3">Permissions</th>
                    <th className="py-3 px-3">Created</th>
                    <th className="py-3 px-3">Risk</th>
                    <th className="py-3 px-3 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {filteredApps.map((a) => (
                    <tr
                      key={a.id}
                      onClick={() => setSelectedApp(a)}
                      className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white max-w-[200px] truncate">
                        {a.name}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400 max-w-[140px] truncate">
                        {a.publisher}
                      </td>
                      <td className="py-3 px-3">
                        <Badge variant="outline" className="text-[10px]">
                          {a.type}
                        </Badge>
                      </td>
                      <td className="py-3 px-3">
                        {a.enabled ? (
                          <Badge className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200 text-[10px]">
                            Yes
                          </Badge>
                        ) : (
                          <Badge className="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border border-slate-200 text-[10px]">
                            No
                          </Badge>
                        )}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">
                        {a.assignmentRequired ? 'Yes' : 'No'}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">
                        {a.totalAssigned > 0 ? `${a.totalAssigned} identities` : 'None'}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">
                        {a.permsCount > 0 ? `${a.permsCount} granted` : 'None'}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400 whitespace-nowrap">
                        {a.created}
                      </td>
                      <td className="py-3 px-3">
                        {a.risk ? (
                          <Badge className={`text-[10px] uppercase font-semibold border ${
                            a.risk === 'high'
                              ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 border-red-200'
                              : a.risk === 'medium'
                              ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 border-amber-200'
                              : 'bg-slate-50 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-200'
                          }`}>
                            {a.risk}
                          </Badge>
                        ) : (
                          <span className="text-slate-400 text-[11px]">Risk assessment not available</span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right">
                        <ChevronRight className="h-4 w-4 inline text-slate-400 hover:text-slate-600" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Enterprise App Detail Drawer */}
      {selectedApp && (
        <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-xs flex justify-end">
          <div className="w-full max-w-xl bg-white dark:bg-slate-900 h-full shadow-2xl border-l border-slate-200 dark:border-slate-800 overflow-y-auto flex flex-col animate-in slide-in-from-right duration-200">
            {/* Header */}
            <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between sticky top-0 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs z-10">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/50 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-bold text-sm">
                  <Building2 className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-slate-900 dark:text-white leading-tight">
                    {selectedApp.name}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Enterprise Application</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSelectedApp(null)}
                className="h-8 w-8 text-slate-500 hover:text-slate-900 dark:hover:text-white"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content Drawer Sections */}
            <div className="p-5 space-y-6 flex-1 text-xs text-slate-700 dark:text-slate-300">
              {/* 1. Overview */}
              <div className="space-y-3">
                <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                  1. Overview
                </div>

                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200 leading-relaxed mb-3">
                  {selectedApp.description || 'No description provided for this enterprise application.'}
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">Publisher</div>
                    <div className="font-semibold text-slate-900 dark:text-white mt-0.5">{selectedApp.publisher}</div>
                  </div>

                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">Verified Publisher</div>
                    <div className="font-semibold text-slate-900 dark:text-white mt-0.5">{selectedApp.verifiedPublisher ? 'Yes' : 'No'}</div>
                  </div>

                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">Account Enabled</div>
                    <div className="font-semibold text-slate-900 dark:text-white mt-0.5">{selectedApp.enabled ? 'Yes' : 'No'}</div>
                  </div>

                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">Assignment Required</div>
                    <div className="font-semibold text-slate-900 dark:text-white mt-0.5">{selectedApp.assignmentRequired ? 'Yes' : 'No'}</div>
                  </div>
                </div>

                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">Application ID</div>
                      <div className="font-mono text-xs font-semibold text-slate-900 dark:text-white">{selectedApp.appId}</div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCopy(selectedApp.appId!)}
                      className="h-7 text-[11px] gap-1"
                    >
                      {copiedId === selectedApp.appId ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                      Copy
                    </Button>
                  </div>

                  <div className="flex items-center justify-between p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">Service Principal Object ID</div>
                      <div className="font-mono text-xs font-semibold text-slate-900 dark:text-white">{selectedApp.objectId}</div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCopy(selectedApp.objectId!)}
                      className="h-7 text-[11px] gap-1"
                    >
                      {copiedId === selectedApp.objectId ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                      Copy
                    </Button>
                  </div>
                </div>
              </div>

              {/* 2. Access */}
              {(() => {
                const users = selectedApp.users || []
                const groups = selectedApp.groups || []
                const sps = selectedApp.sps || []
                return (
                  <div className="space-y-2">
                    <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                      2. Access & Assignments
                    </div>
                    <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-2">
                      <div>
                        <div className="font-semibold text-slate-900 dark:text-white">Assigned Users ({users.length})</div>
                        {users.length > 0 ? (
                          <ul className="space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-400 mt-1">
                            {users.map((u, i) => <li key={i}>• {u}</li>)}
                          </ul>
                        ) : (
                          <p className="text-slate-500 italic mt-0.5">No direct user assignments listed.</p>
                        )}
                      </div>

                      <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
                        <div className="font-semibold text-slate-900 dark:text-white">Assigned Groups ({groups.length})</div>
                        {groups.length > 0 ? (
                          <ul className="space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-400 mt-1">
                            {groups.map((g, i) => <li key={i}>• {g}</li>)}
                          </ul>
                        ) : (
                          <p className="text-slate-500 italic mt-0.5">No group assignments listed.</p>
                        )}
                      </div>

                      <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
                        <div className="font-semibold text-slate-900 dark:text-white">Assigned Service Principals ({sps.length})</div>
                        {sps.length > 0 ? (
                          <ul className="space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-400 mt-1">
                            {sps.map((sp, i) => <li key={i}>• {sp}</li>)}
                          </ul>
                        ) : (
                          <p className="text-slate-500 italic mt-0.5">No service principal assignments listed.</p>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* 3. Permissions and consent */}
              <div className="space-y-2">
                <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                  3. Permissions and Consent
                </div>
                <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-2">
                  <div>
                    <div className="text-[10px] text-slate-500">Resource API: {selectedApp.resourceApi || 'Microsoft Graph'}</div>
                    <div className="text-[10px] text-slate-500">Consent Type: {selectedApp.consentType || 'AllPrincipals (Tenant-wide)'}</div>
                    {selectedApp.grantedBy && (
                      <div className="text-[10px] text-slate-500">Granted By: {selectedApp.grantedBy}</div>
                    )}
                  </div>

                  {selectedApp.delegatedGrants && selectedApp.delegatedGrants.length > 0 && (
                    <div className="pt-1">
                      <div className="font-semibold text-slate-900 dark:text-white">Delegated Grants:</div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {selectedApp.delegatedGrants.map((g, i) => (
                          <Badge key={i} variant="outline" className="text-[10px] font-mono">{g}</Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedApp.applicationPermissions && selectedApp.applicationPermissions.length > 0 && (
                    <div className="pt-1">
                      <div className="font-semibold text-slate-900 dark:text-white">Application Permissions:</div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {selectedApp.applicationPermissions.map((p, i) => (
                          <Badge key={i} className="text-[10px] font-mono bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300 border-purple-200">
                            {p}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* 4. Sign-in and activity */}
              <div className="space-y-2">
                <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                  4. Sign-in and Activity
                </div>
                <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-500">Last Sign-in</span>
                    <span className="font-semibold text-slate-900 dark:text-white">{selectedApp.lastSignIn || selectedApp.lastActivity || 'No recent activity supplied'}</span>
                  </div>

                  {typeof selectedApp.recentSignInCount === 'number' && (
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500">Recent Sign-in Count</span>
                      <span className="font-semibold text-slate-900 dark:text-white">{selectedApp.recentSignInCount}</span>
                    </div>
                  )}

                  {typeof selectedApp.successfulSignIns === 'number' && (
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500">Successful / Failed Sign-ins</span>
                      <span className="font-semibold text-slate-900 dark:text-white">
                        {selectedApp.successfulSignIns} success / {selectedApp.failedSignIns || 0} failed
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Risk Assessment */}
              <div className="space-y-2">
                <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                  Risk Assessment
                </div>
                {selectedApp.risk ? (
                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-900 dark:text-white">Risk Level</span>
                      <Badge className="uppercase font-semibold text-[10px]">{selectedApp.risk}</Badge>
                    </div>
                    {selectedApp.riskFindings && selectedApp.riskFindings.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-[10px] text-slate-500">Contributing Findings:</div>
                        <ul className="space-y-1 text-slate-700 dark:text-slate-300">
                          {selectedApp.riskFindings.map((f, idx) => (
                            <li key={idx}>• {f}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {selectedApp.recommendedAction && (
                      <div className="pt-1 text-[11px] text-slate-600 dark:text-slate-400">
                        <span className="font-semibold">Recommended Action:</span> {selectedApp.recommendedAction}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 text-slate-500 italic">
                    Risk assessment not available
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
