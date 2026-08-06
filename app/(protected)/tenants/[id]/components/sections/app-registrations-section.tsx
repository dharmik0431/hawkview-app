'use client'

import React, { useState, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  AppWindow,
  Search,
  ChevronRight,
  ArrowUpDown,
  X,
  Copy,
  Check,
  ShieldAlert,
  Info,
  Key,
  Lock,
  ExternalLink,
} from 'lucide-react'

export type AppRegistrationItem = {
  id?: string
  objectId?: string
  appId?: string
  clientId?: string
  displayName?: string
  name?: string
  description?: string
  createdDateTime?: string
  createdDate?: string
  created?: string
  publisherDomain?: string
  signInAudience?: string
  supportedAccounts?: string
  accounts?: string
  isMultitenant?: boolean
  homepageUrl?: string
  identifierUris?: string[]
  owners?: string[]
  risk?: string | null
  apiPermissions?: Array<{
    name?: string
    resourceApi?: string
    type?: 'Delegated' | 'Application' | string
    consentStatus?: string
    adminConsentRequired?: boolean
    scopeOrRole?: string
  }>
  perms?: any[]
  credentials?: Array<{
    type?: 'Secret' | 'Certificate' | string
    name?: string
    startDate?: string
    endDate?: string
    expirationDate?: string
    status?: 'Active' | 'Expiring' | 'Expired' | string
  }>
  creds?: any[]
  assignedIdentities?: string[]
  consentGrants?: string[]
  riskLevel?: 'high' | 'medium' | 'low' | string
  riskFindings?: string[]
  recommendedAction?: string
}

interface AppRegistrationsSectionProps {
  bundle: any
}

type AppSortField = 'name' | 'appId' | 'accounts' | 'created' | 'risk'
type SortOrder = 'asc' | 'desc'

export default function AppRegistrationsSection({ bundle }: AppRegistrationsSectionProps) {
  const rawApps = useMemo<AppRegistrationItem[]>(() => {
    if (Array.isArray(bundle?.entra?.appRegistrations)) return bundle.entra.appRegistrations
    if (Array.isArray(bundle?.entra?.applications)) return bundle.entra.applications
    if (Array.isArray(bundle?.appRegistrations)) return bundle.appRegistrations
    if (Array.isArray(bundle?.applications)) return bundle.applications
    return []
  }, [bundle])

  const [query, setQuery] = useState('')
  const [accountFilter, setAccountFilter] = useState<string>('all')
  const [riskFilter, setRiskFilter] = useState<string>('all')
  const [sortField, setSortField] = useState<AppSortField>('name')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')
  const [selectedApp, setSelectedApp] = useState<AppRegistrationItem | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const normalizedApps = useMemo(() => {
    return rawApps.map((a, idx) => {
      const name = a.displayName || a.name || `Application ${idx + 1}`
      const appId = a.appId || a.clientId || `app-id-${idx}`
      const objectId = a.objectId || a.id || `obj-id-${idx}`
      const accounts = a.supportedAccounts || a.signInAudience || 'Single tenant'
      const isMultitenant = accounts.toLowerCase().includes('multi')
      const owners = Array.isArray(a.owners) ? a.owners : []
      const creds = Array.isArray(a.credentials) ? a.credentials : []
      const perms = Array.isArray(a.apiPermissions) ? a.apiPermissions : []
      const created = a.createdDate || a.createdDateTime || 'Unknown'
      const risk = a.riskLevel || null // Only if real calculation exists

      return {
        ...a,
        id: objectId,
        objectId,
        appId,
        name,
        accounts,
        isMultitenant,
        owners,
        creds,
        perms,
        created,
        risk,
      }
    })
  }, [rawApps])

  const summary = useMemo(() => {
    const total = normalizedApps.length
    const singleTenant = normalizedApps.filter(a => !a.isMultitenant).length
    const multiTenant = normalizedApps.filter(a => a.isMultitenant).length
    const withCreds = normalizedApps.filter(a => a.creds.length > 0).length
    const requiringAttention = normalizedApps.filter(a => a.risk === 'high' || a.creds.some(c => c.status === 'Expiring' || c.status === 'Expired')).length

    return { total, singleTenant, multiTenant, withCreds, requiringAttention }
  }, [normalizedApps])

  const filteredApps = useMemo(() => {
    const q = query.trim().toLowerCase()
    return normalizedApps.filter((a) => {
      const matchesText = !q || a.name.toLowerCase().includes(q) || a.appId.toLowerCase().includes(q) || a.objectId.toLowerCase().includes(q)
      const matchesAccount = accountFilter === 'all' || (accountFilter === 'single' ? !a.isMultitenant : a.isMultitenant)
      const matchesRisk = riskFilter === 'all' || (a.risk && a.risk.toLowerCase() === riskFilter.toLowerCase())

      return matchesText && matchesAccount && matchesRisk
    }).sort((a, b) => {
      let valA: any = a[sortField === 'name' ? 'name' : sortField === 'appId' ? 'appId' : sortField === 'accounts' ? 'accounts' : sortField === 'created' ? 'created' : 'risk']
      let valB: any = b[sortField === 'name' ? 'name' : sortField === 'appId' ? 'appId' : sortField === 'accounts' ? 'accounts' : sortField === 'created' ? 'created' : 'risk']

      if (typeof valA === 'string') valA = valA.toLowerCase()
      if (typeof valB === 'string') valB = valB.toLowerCase()

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1
      return 0
    })
  }, [normalizedApps, query, accountFilter, riskFilter, sortField, sortOrder])

  const handleSort = (field: AppSortField) => {
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
    bundle?.sync?.applications?.status === 'succeeded' || rawApps.length > 0

  return (
    <div className="mt-5 space-y-5">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Total Registrations</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.total : '—'}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Single-tenant</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.singleTenant : '—'}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Multitenant</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.multiTenant : '—'}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">With Credentials</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.withCreds : '—'}
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
                  placeholder="Search application or client ID..."
                  className="pl-9 h-9 text-xs"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Accounts:</span>
                  <select
                    value={accountFilter}
                    onChange={(e) => setAccountFilter(e.target.value)}
                    className="h-8 px-2.5 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
                  >
                    <option value="all">All Accounts</option>
                    <option value="single">Single-tenant</option>
                    <option value="multi">Multitenant</option>
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
              Showing <span className="font-semibold text-slate-900 dark:text-white">{filteredApps.length}</span> of {normalizedApps.length} registrations
            </div>
          </div>

          {/* Table */}
          {!isSynchronized ? (
            <div className="p-8 text-center space-y-2">
              <Info className="mx-auto h-8 w-8 text-slate-400" />
              <div className="text-sm font-semibold text-slate-900 dark:text-white">App registration inventory is awaiting collection</div>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                No App Registration objects were returned in the current tenant response. Microsoft Graph application synchronization is required for this view.
              </p>
            </div>
          ) : filteredApps.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
              No application registrations match the selected search or filter criteria.
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
                        <span>Application</span>
                        <ArrowUpDown className="h-3 w-3 opacity-60" />
                      </button>
                    </th>
                    <th className="py-3 px-3">
                      <button
                        type="button"
                        onClick={() => handleSort('appId')}
                        className="inline-flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-white"
                      >
                        <span>Application / Client ID</span>
                        <ArrowUpDown className="h-3 w-3 opacity-60" />
                      </button>
                    </th>
                    <th className="py-3 px-3">Supported Accounts</th>
                    <th className="py-3 px-3">Owners</th>
                    <th className="py-3 px-3">Credentials</th>
                    <th className="py-3 px-3">API Permissions</th>
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
                      <td className="py-3 px-3 font-mono text-[11px] text-slate-600 dark:text-slate-400 max-w-[150px] truncate">
                        {a.appId}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">
                        {a.accounts}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">
                        {a.owners.length} owner{a.owners.length === 1 ? '' : 's'}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">
                        {a.creds.length > 0 ? `${a.creds.length} defined` : 'None'}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">
                        {a.perms.length > 0 ? `${a.perms.length} requested` : 'None'}
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

      {/* App Registration Detail Drawer */}
      {selectedApp && (
        <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-xs flex justify-end">
          <div className="w-full max-w-xl bg-white dark:bg-slate-900 h-full shadow-2xl border-l border-slate-200 dark:border-slate-800 overflow-y-auto flex flex-col animate-in slide-in-from-right duration-200">
            {/* Header */}
            <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between sticky top-0 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs z-10">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-purple-50 dark:bg-purple-950/50 flex items-center justify-center text-purple-600 dark:text-purple-400 font-bold text-sm">
                  <AppWindow className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-slate-900 dark:text-white leading-tight">
                    {selectedApp.name}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">App Registration</p>
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

            {/* Content Drawer Tabs/Sections */}
            <div className="p-5 space-y-6 flex-1 text-xs text-slate-700 dark:text-slate-300">
              {/* 1. Overview */}
              <div className="space-y-3">
                <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                  1. Overview
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">Created Date</div>
                    <div className="font-semibold text-slate-900 dark:text-white mt-0.5">{selectedApp.created}</div>
                  </div>

                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">Publisher Domain</div>
                    <div className="font-semibold text-slate-900 dark:text-white mt-0.5">{selectedApp.publisherDomain || 'Unverified'}</div>
                  </div>

                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 col-span-2">
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">Supported Account Types</div>
                    <div className="font-semibold text-slate-900 dark:text-white mt-0.5">{selectedApp.accounts}</div>
                  </div>
                </div>

                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">Application / Client ID</div>
                      <div className="font-mono text-xs font-semibold text-slate-900 dark:text-white">{selectedApp.appId}</div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCopy(selectedApp.appId || '')}
                      className="h-7 text-[11px] gap-1"
                    >
                      {copiedId === selectedApp.appId ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                      Copy
                    </Button>
                  </div>

                  <div className="flex items-center justify-between p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">Object ID</div>
                      <div className="font-mono text-xs font-semibold text-slate-900 dark:text-white">{selectedApp.objectId}</div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCopy(selectedApp.objectId || '')}
                      className="h-7 text-[11px] gap-1"
                    >
                      {copiedId === selectedApp.objectId ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                      Copy
                    </Button>
                  </div>
                </div>
              </div>

              {/* 2. Purpose */}
              <div className="space-y-1.5">
                <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                  2. Purpose
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200 leading-relaxed">
                  {selectedApp.description ? selectedApp.description : 'No application description is available.'}
                </div>
              </div>

              {/* 3. API Permissions */}
              {(() => {
                const perms = selectedApp.perms || []
                const creds = selectedApp.creds || []
                const owners = selectedApp.owners || []
                return (
                  <>
                    <div className="space-y-2">
                      <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                        3. API Permissions ({perms.length})
                      </div>
                      {perms.length > 0 ? (
                        <div className="space-y-2">
                          {perms.map((p, idx) => (
                            <div key={idx} className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="font-semibold text-slate-900 dark:text-white">{p.name || 'Permission'}</span>
                                <Badge variant="outline" className="text-[10px]">
                                  {p.type || 'Delegated'}
                                </Badge>
                              </div>
                              <div className="text-[11px] text-slate-500">Resource API: {p.resourceApi || 'Microsoft Graph'}</div>
                              <div className="text-[11px] text-slate-500">Scope/Role: <code className="font-mono">{p.scopeOrRole || 'Default'}</code></div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 text-slate-500 italic">
                          No API permissions enumerated in current response.
                        </div>
                      )}
                    </div>

                    {/* 4. Credentials (NEVER DISPLAY SECRET VALUES) */}
                    <div className="space-y-2">
                      <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                        4. Credentials ({creds.length})
                      </div>
                      <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-[11px] text-amber-800 dark:text-amber-300 flex items-center gap-2">
                        <Lock className="h-4 w-4 shrink-0" />
                        <span>Credential metadata only. Secret values and private keys are never stored or displayed.</span>
                      </div>
                      {creds.length > 0 ? (
                        <div className="space-y-2">
                          {creds.map((c, idx) => (
                            <div key={idx} className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex items-center justify-between">
                              <div>
                                <div className="font-semibold text-slate-900 dark:text-white">{c.name || `${c.type || 'Credential'} #${idx+1}`}</div>
                                <div className="text-[11px] text-slate-500">Expires: {c.expirationDate || c.endDate || 'Not set'}</div>
                              </div>
                              <Badge className="text-[10px]">
                                {c.status || 'Active'}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 text-slate-500 italic">
                          No credentials defined for this application.
                        </div>
                      )}
                    </div>

                    {/* 5. Access */}
                    <div className="space-y-2">
                      <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                        5. Access & Governance
                      </div>
                      <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-1.5">
                        <div className="font-semibold text-slate-900 dark:text-white">Owners ({owners.length})</div>
                        {owners.length > 0 ? (
                          <ul className="space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                            {owners.map((owner, i) => (
                              <li key={i}>• {owner}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-slate-500 italic">No owners assigned.</p>
                        )}
                      </div>
                    </div>
                  </>
                )
              })()}

              {/* Risk Display */}
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
