'use client'

import React, { useState, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Users,
  Shield,
  Search,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  X,
  Copy,
  Check,
  Zap,
  Mail,
  Layers,
  Info,
} from 'lucide-react'

export type GroupItem = {
  id?: string
  objectId?: string
  displayName?: string
  name?: string
  description?: string
  type?: string
  groupType?: string
  typeLabel?: string
  membershipLabel?: string
  visibilityLabel?: string
  statusLabel?: string
  membership?: string
  ownersCount?: number
  mail?: string
  email?: string
  visibility?: string
  membershipType?: 'Assigned' | 'Dynamic' | 'Direct' | string
  createdDateTime?: string
  createdDate?: string
  owners?: string[]
  members?: string[]
  membersCount?: number
  assignedLicenses?: string[]
  onPremisesSyncEnabled?: boolean | null
  onPremisesSyncState?: string
  membershipRule?: string
}

interface GroupsSectionProps {
  bundle: any
}

type GroupSortField = 'name' | 'type' | 'membership' | 'members' | 'owners' | 'mail'
type SortOrder = 'asc' | 'desc'

function normalizeLabels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const labels: string[] = []
  const seen = new Set<string>()

  for (const candidate of value) {
    if (typeof candidate !== 'string') continue

    const label = candidate.trim()
    if (!label) continue

    const key = label.toLocaleLowerCase()
    if (seen.has(key)) continue

    seen.add(key)
    labels.push(label)
  }

  return labels
}

export default function GroupsSection({ bundle }: GroupsSectionProps) {
  // Extract real group data from API bundle
  const rawGroups = useMemo<GroupItem[]>(() => {
    if (Array.isArray(bundle?.entra?.groups)) return bundle.entra.groups
    if (Array.isArray(bundle?.exchange?.groups)) return bundle.exchange.groups
    if (Array.isArray(bundle?.groups)) return bundle.groups
    return []
  }, [bundle])

  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [membershipFilter, setMembershipFilter] = useState<string>('all')
  const [sortField, setSortField] = useState<GroupSortField>('name')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')
  const [selectedGroup, setSelectedGroup] = useState<GroupItem | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Normalize group item
  const normalizedGroups = useMemo(() => {
    return rawGroups.map((g, idx) => {
      const name = g.displayName || g.name || `Group ${idx + 1}`
      const email = g.mail || g.email || ''
      const rawType = g.type || g.groupType || 'Unknown'

      let typeLabel = 'Unknown'
      const lower = rawType.toLowerCase()
      if (lower.includes('dynamic') && lower.includes('365')) {
        typeLabel = 'Dynamic Microsoft 365'
      } else if (lower.includes('dynamic') || lower.includes('dynamicdl')) {
        typeLabel = 'Dynamic security'
      } else if (lower.includes('mailenabledsecurity') || lower.includes('mail-enabled security')) {
        typeLabel = 'Mail-enabled security'
      } else if (lower.includes('distribution') || lower.includes('distributionlist')) {
        typeLabel = 'Distribution list'
      } else if (lower.includes('microsoft365') || lower.includes('m365') || lower.includes('unified')) {
        typeLabel = 'Microsoft 365'
      } else if (lower.includes('security')) {
        typeLabel = 'Security'
      } else {
        typeLabel = rawType || 'Unknown'
      }

      const membership = g.membershipType || (lower.includes('dynamic') ? 'Dynamic' : 'Direct')
      const members = normalizeLabels(g.members)
      const owners = normalizeLabels(g.owners)
      const membersCount = typeof g.membersCount === 'number'
        ? g.membersCount
        : members
          ? members.length
          : undefined
      const ownersCount = owners ? owners.length : undefined

      return {
        ...g,
        id: g.id || g.objectId || `grp-${idx}`,
        objectId: g.objectId || g.id || `obj-${idx}`,
        name,
        email,
        typeLabel,
        membership,
        membersCount,
        ownersCount,
        members,
        owners,
      }
    })
  }, [rawGroups])

  // Summary counts
  const summary = useMemo(() => {
    const total = normalizedGroups.length
    const security = normalizedGroups.filter(g => g.typeLabel.includes('Security') || g.typeLabel === 'Mail-enabled security').length
    const m365 = normalizedGroups.filter(g => g.typeLabel.includes('Microsoft 365')).length
    const distribution = normalizedGroups.filter(g => g.typeLabel === 'Distribution list').length
    const dynamic = normalizedGroups.filter(g => g.typeLabel.toLowerCase().includes('dynamic') || g.membership.toLowerCase() === 'dynamic').length

    return { total, security, m365, distribution, dynamic }
  }, [normalizedGroups])

  // Filter & Sort
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return normalizedGroups.filter((g) => {
      const matchesText = !q || g.name.toLowerCase().includes(q) || g.email.toLowerCase().includes(q) || (g.description || '').toLowerCase().includes(q)
      const matchesType = typeFilter === 'all' || g.typeLabel === typeFilter
      const matchesMembership = membershipFilter === 'all' || g.membership.toLowerCase() === membershipFilter.toLowerCase()

      return matchesText && matchesType && matchesMembership
    }).sort((a, b) => {
      let valA: any = a[sortField === 'name' ? 'name' : sortField === 'type' ? 'typeLabel' : sortField === 'mail' ? 'email' : sortField === 'members' ? 'membersCount' : sortField === 'owners' ? 'ownersCount' : 'membership']
      let valB: any = b[sortField === 'name' ? 'name' : sortField === 'type' ? 'typeLabel' : sortField === 'mail' ? 'email' : sortField === 'members' ? 'membersCount' : sortField === 'owners' ? 'ownersCount' : 'membership']

      if (typeof valA === 'string') valA = valA.toLowerCase()
      if (typeof valB === 'string') valB = valB.toLowerCase()

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1
      return 0
    })
  }, [normalizedGroups, query, typeFilter, membershipFilter, sortField, sortOrder])

  const handleSort = (field: GroupSortField) => {
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
    bundle?.sync?.groups?.status === 'succeeded' || rawGroups.length > 0

  return (
    <div className="mt-5 space-y-5">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Total Groups</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.total : '—'}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Security</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.security : '—'}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Microsoft 365</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.m365 : '—'}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Distribution</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.distribution : '—'}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs col-span-2 sm:col-span-1">
          <CardContent className="p-3.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Dynamic</div>
            <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">
              {isSynchronized ? summary.dynamic : '—'}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Table Card */}
      <Card className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm">
        <CardContent className="p-0">
          {/* Filter Bar */}
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="relative w-full sm:w-[280px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search group name or email..."
                  className="pl-9 h-9 text-xs"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Type:</span>
                  <select
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value)}
                    className="h-8 px-2.5 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
                  >
                    <option value="all">All Types</option>
                    <option value="Security">Security</option>
                    <option value="Microsoft 365">Microsoft 365</option>
                    <option value="Distribution list">Distribution list</option>
                    <option value="Mail-enabled security">Mail-enabled security</option>
                    <option value="Dynamic security">Dynamic security</option>
                    <option value="Dynamic Microsoft 365">Dynamic Microsoft 365</option>
                  </select>
                </div>

                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Membership:</span>
                  <select
                    value={membershipFilter}
                    onChange={(e) => setMembershipFilter(e.target.value)}
                    className="h-8 px-2.5 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
                  >
                    <option value="all">All Memberships</option>
                    <option value="direct">Direct / Assigned</option>
                    <option value="dynamic">Dynamic</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="text-xs text-slate-500 dark:text-slate-400">
              Showing <span className="font-semibold text-slate-900 dark:text-white">{filteredGroups.length}</span> of {normalizedGroups.length} groups
            </div>
          </div>

          {/* Table */}
          {!isSynchronized ? (
            <div className="p-8 text-center space-y-2">
              <Info className="mx-auto h-8 w-8 text-slate-400" />
              <div className="text-sm font-semibold text-slate-900 dark:text-white">Group inventory is awaiting collection</div>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                No synchronized group records were found in the current tenant API response. Backend Microsoft Graph group synchronization is required to populate this inventory.
              </p>
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
              No groups match the current search or filter criteria.
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
                        <span>Group</span>
                        <ArrowUpDown className="h-3 w-3 opacity-60" />
                      </button>
                    </th>
                    <th className="py-3 px-3">
                      <button
                        type="button"
                        onClick={() => handleSort('type')}
                        className="inline-flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-white"
                      >
                        <span>Type</span>
                        <ArrowUpDown className="h-3 w-3 opacity-60" />
                      </button>
                    </th>
                    <th className="py-3 px-3">Membership</th>
                    <th className="py-3 px-3">
                      <button
                        type="button"
                        onClick={() => handleSort('members')}
                        className="inline-flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-white"
                      >
                        <span>Members</span>
                        <ArrowUpDown className="h-3 w-3 opacity-60" />
                      </button>
                    </th>
                    <th className="py-3 px-3">Owners</th>
                    <th className="py-3 px-4">
                      <button
                        type="button"
                        onClick={() => handleSort('mail')}
                        className="inline-flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-white"
                      >
                        <span>Mail</span>
                        <ArrowUpDown className="h-3 w-3 opacity-60" />
                      </button>
                    </th>
                    <th className="py-3 px-3">Visibility</th>
                    <th className="py-3 px-3">Status</th>
                    <th className="py-3 px-3 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {filteredGroups.map((g) => (
                    <tr
                      key={g.id}
                      onClick={() => setSelectedGroup(g)}
                      className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white max-w-[200px] truncate">
                        {g.name}
                      </td>
                      <td className="py-3 px-3">
                        <Badge variant="outline" className="text-[10px] bg-slate-50 dark:bg-slate-800/60 font-medium">
                          {g.typeLabel}
                        </Badge>
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">
                        {g.membership}
                      </td>
                      <td className="py-3 px-3 text-slate-700 dark:text-slate-300 font-medium">
                        {g.membersCount ?? '—'}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">
                        {g.ownersCount ?? '—'}
                      </td>
                      <td className="py-3 px-4 text-slate-600 dark:text-slate-400 max-w-[180px] truncate font-mono text-[11px]">
                        {g.email || '—'}
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-400">
                        {g.visibility || '—'}
                      </td>
                      <td className="py-3 px-3">
                        <Badge className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 text-[10px]">
                          Synced
                        </Badge>
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

      {/* Group Detail Drawer */}
      {selectedGroup && (
        <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-xs flex justify-end">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 h-full shadow-2xl border-l border-slate-200 dark:border-slate-800 overflow-y-auto flex flex-col animate-in slide-in-from-right duration-200">
            {/* Header */}
            <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between sticky top-0 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs z-10">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-blue-50 dark:bg-blue-950/50 flex items-center justify-center text-blue-600 dark:text-blue-400 font-bold text-sm">
                  <Users className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-slate-900 dark:text-white leading-tight">
                    {selectedGroup.name}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{selectedGroup.typeLabel}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSelectedGroup(null)}
                className="h-8 w-8 text-slate-500 hover:text-slate-900 dark:hover:text-white"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content */}
            <div className="p-5 space-y-6 flex-1 text-xs text-slate-700 dark:text-slate-300">
              {/* Description */}
              <div className="space-y-1">
                <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                  Description
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200 leading-relaxed">
                  {selectedGroup.description || 'No group description is available.'}
                </div>
              </div>

              {/* Attributes Grid */}
              <div className="space-y-3">
                <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                  Overview Details
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">Group Type</div>
                    <div className="font-semibold text-slate-900 dark:text-white mt-0.5">{selectedGroup.typeLabel}</div>
                  </div>

                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">Membership Type</div>
                    <div className="font-semibold text-slate-900 dark:text-white mt-0.5">{selectedGroup.membership || 'Direct'}</div>
                  </div>

                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">Visibility</div>
                    <div className="font-semibold text-slate-900 dark:text-white mt-0.5">{selectedGroup.visibility || 'Public'}</div>
                  </div>

                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">Created Date</div>
                    <div className="font-semibold text-slate-900 dark:text-white mt-0.5">{selectedGroup.createdDate || selectedGroup.createdDateTime || 'Not provided'}</div>
                  </div>
                </div>
              </div>

              {/* Identifiers */}
              <div className="space-y-3">
                <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                  Identifiers & Contact
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">Email Address</div>
                      <div className="font-mono text-xs font-semibold text-slate-900 dark:text-white">{selectedGroup.email || 'None'}</div>
                    </div>
                    {selectedGroup.email && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCopy(selectedGroup.email!)}
                        className="h-7 text-[11px] gap-1"
                      >
                        {copiedId === selectedGroup.email ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                        Copy
                      </Button>
                    )}
                  </div>

                  <div className="flex items-center justify-between p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">Object ID</div>
                      <div className="font-mono text-xs font-semibold text-slate-900 dark:text-white truncate max-w-[260px]">{selectedGroup.objectId}</div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCopy(selectedGroup.objectId!)}
                      className="h-7 text-[11px] gap-1"
                    >
                      {copiedId === selectedGroup.objectId ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                      Copy
                    </Button>
                  </div>
                </div>
              </div>

              {/* Members & Owners */}
              <div className="space-y-3">
                <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                  Group Membership
                </div>

                <div className="space-y-2">
                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div className="text-[11px] font-semibold text-slate-900 dark:text-white mb-1">
                      Owners ({selectedGroup.ownersCount ?? 'Unavailable'})
                    </div>
                    {Array.isArray(selectedGroup.owners) && selectedGroup.owners.length > 0 ? (
                      <ul className="space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                        {selectedGroup.owners.map((owner) => (
                          <li key={owner.toLocaleLowerCase()} className="truncate">• {owner}</li>
                        ))}
                      </ul>
                    ) : Array.isArray(selectedGroup.owners) ? (
                      <p className="text-[11px] text-slate-500 italic">No owners found.</p>
                    ) : (
                      <p className="text-[11px] text-slate-500 italic">Owner roster unavailable.</p>
                    )}
                  </div>

                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                    <div className="text-[11px] font-semibold text-slate-900 dark:text-white mb-1">
                      Members ({selectedGroup.membersCount ?? 'Unavailable'})
                    </div>
                    {Array.isArray(selectedGroup.members) && selectedGroup.members.length > 0 ? (
                      <ul className="space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                        {selectedGroup.members.map((member) => (
                          <li key={member.toLocaleLowerCase()} className="truncate">• {member}</li>
                        ))}
                      </ul>
                    ) : Array.isArray(selectedGroup.members) ? (
                      <p className="text-[11px] text-slate-500 italic">No members found.</p>
                    ) : typeof selectedGroup.membersCount === 'number' ? (
                      <p className="text-[11px] text-slate-500 italic">{selectedGroup.membersCount} total members. Member roster unavailable.</p>
                    ) : (
                      <p className="text-[11px] text-slate-500 italic">Member roster unavailable.</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Dynamic Membership Rule */}
              {selectedGroup.membershipRule && (
                <div className="space-y-1">
                  <div className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[10px]">
                    Membership Rule
                  </div>
                  <div className="p-3 rounded-xl bg-slate-900 text-slate-100 font-mono text-[11px] overflow-x-auto">
                    {selectedGroup.membershipRule}
                  </div>
                </div>
              )}

              {/* Sync state & Licenses */}
              <div className="space-y-2">
                <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex items-center justify-between">
                  <span className="text-slate-600 dark:text-slate-400">On-premises sync state</span>
                  <span className="font-semibold text-slate-900 dark:text-white">
                    {selectedGroup.onPremisesSyncEnabled ? 'Synced from AD' : 'Cloud-only'}
                  </span>
                </div>

                <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex items-center justify-between">
                  <span className="text-slate-600 dark:text-slate-400">Assigned Licenses</span>
                  <span className="font-semibold text-slate-900 dark:text-white">
                    {selectedGroup.assignedLicenses?.length ? selectedGroup.assignedLicenses.join(', ') : 'None assigned'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
