'use client'

import React, { useMemo, useState } from 'react'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

import { Mail, Users, Layers, Shield, Search, ChevronRight } from 'lucide-react'

type ExchangeSectionProps = {
  bundle: any
  setSelectedMailbox: (m: any) => void
  setSelectedRule: (r: any) => void
  setSelectedGroup: (g: any) => void
}

type CollectionState = {
  state?: string
  message?: string | null
  isStale?: boolean
}

function collectionLabel(field?: CollectionState) {
  if (field?.isStale || field?.state === 'STALE') return 'Last value is stale'
  if (/recipient management|exchange rbac|exchange role/i.test(field?.message ?? '')) {
    return 'Exchange access role required'
  }
  switch (field?.state) {
    case 'AVAILABLE': return 'Available'
    case 'PENDING': return 'Sync pending'
    case 'NOT_LICENSED': return 'Requires Microsoft license'
    case 'PERMISSION_REQUIRED': return 'Additional permission required'
    case 'UNSUPPORTED': return 'Not available from Microsoft'
    case 'NOT_CONFIGURED': return 'Not configured'
    case 'FAILED': return 'Collection failed'
    default: return 'Unavailable'
  }
}

export default function ExchangePage({
  bundle,
  setSelectedMailbox,
  setSelectedRule,
  setSelectedGroup,
}: ExchangeSectionProps) {
  const [mbxQuery, setMbxQuery] = useState('')
  const [ruleQuery, setRuleQuery] = useState('')
  const [groupQuery, setGroupQuery] = useState('')
  const [ruleMailboxFilter, setRuleMailboxFilter] = useState<'all' | string>(
    'all'
  )
  const exchangeSync = bundle?.exchange?.sync ?? {}
  const failedModules = Object.entries(exchangeSync).filter(
    ([, value]: [string, any]) => value?.status === 'failed'
  )
  const hasNeverSynced = Object.values(exchangeSync).some(
    (value: any) => value?.status === 'never-synced'
  )

  // ✅ Pull from mock bundle (NOT hardcoded)
  const EXCHANGE_MAILBOXES = useMemo(
    () =>
      Array.isArray(bundle?.exchange?.mailboxes)
        ? bundle.exchange.mailboxes
        : [],
    [bundle]
  )

  const EXCHANGE_RULES = useMemo(
    () =>
      Array.isArray(bundle?.exchange?.rules)
        ? bundle.exchange.rules
        : Array.isArray(bundle?.exchange?.transportRules)
          ? bundle.exchange.transportRules
          : [],
    [bundle]
  )

  const EXCHANGE_GROUPS = useMemo(
    () =>
      Array.isArray(bundle?.exchange?.groups) ? bundle.exchange.groups : [],
    [bundle]
  )

  const EXCHANGE_DOMAINS = Array.isArray(bundle?.exchange?.domains)
    ? bundle.exchange.domains
    : Array.isArray(bundle?.exchange?.acceptedDomains)
      ? bundle.exchange.acceptedDomains
      : []
  const mailboxCollection = bundle?.exchange?.collection ?? {}
  const countOrCollection = (
    count: number,
    field?: CollectionState,
    hasCollectedMailboxTypes = false
  ) => {
    // Mailbox type is collected independently through Microsoft Graph.  Do not
    // hide a valid Graph-derived count merely because the separate, deeper
    // Exchange configuration dataset is unavailable.
    if (hasCollectedMailboxTypes) return count
    return field?.state && !['AVAILABLE', 'STALE'].includes(field.state)
      ? collectionLabel(field)
      : count
  }

  const hasCollectedMailboxTypes = EXCHANGE_MAILBOXES.some(
    (mailbox: any) => typeof mailbox?.mailboxType === 'string'
  )

  const mailboxes = useMemo(() => {
    const base = Array.isArray(EXCHANGE_MAILBOXES) ? EXCHANGE_MAILBOXES : []
    const q = mbxQuery.trim().toLowerCase()
    if (!q) return base
    return base.filter((m: any) => {
      const aliases = Array.isArray(m.aliases) ? m.aliases : []
      const hay =
        `${m.displayName ?? ''} ${m.userPrincipalName ?? ''} ${aliases.join(' ')} ${m.mailboxType ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [mbxQuery, EXCHANGE_MAILBOXES])

  const rules = useMemo(() => {
    const base = Array.isArray(EXCHANGE_RULES) ? EXCHANGE_RULES : []
    const q = ruleQuery.trim().toLowerCase()

    return base
      .filter((r: any) =>
        ruleMailboxFilter === 'all' ? true : r.mailboxUpn === ruleMailboxFilter
      )
      .filter((r: any) => {
        if (!q) return true
        const actions = Array.isArray(r.actions) ? r.actions : []
        const conditions = Array.isArray(r.conditions) ? r.conditions : []
        const hay =
          `${r.name ?? ''} ${r.description ?? ''} ${actions.join(' ')} ${conditions.join(' ')}`.toLowerCase()
        return hay.includes(q)
      })
      .sort((a: any, b: any) => (a.priority ?? 0) - (b.priority ?? 0))
  }, [ruleQuery, ruleMailboxFilter, EXCHANGE_RULES])

  const groups = useMemo(() => {
    const base = Array.isArray(EXCHANGE_GROUPS) ? EXCHANGE_GROUPS : []
    const q = groupQuery.trim().toLowerCase()
    if (!q) return base
    return base.filter((g: any) => {
      const hay =
        `${g.name ?? ''} ${g.email ?? ''} ${g.type ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [groupQuery, EXCHANGE_GROUPS])

  return (
    <div className="mt-6 space-y-6">
      {(failedModules.length > 0 || hasNeverSynced) && (
        <Card className="rounded-2xl border-amber-200 bg-amber-50/60 shadow-sm">
          <CardContent className="p-5">
            <div className="font-semibold">
              Exchange synchronization needs attention
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              HawkView keeps each Exchange dataset independent so available data
              remains visible.
            </div>
            {failedModules.map(([name, value]: [string, any]) => (
              <div key={name} className="mt-2 text-sm text-red-700">
                {name}: {value?.lastError || 'Microsoft rejected this dataset.'}
              </div>
            ))}
            {failedModules.length === 0 && hasNeverSynced && (
              <div className="mt-2 text-sm text-amber-800">
                Run tenant synchronization to collect Exchange data.
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {/* Top stats */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        {/* Total User Mailboxes */}
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Total User Mailboxes
                </div>
                <div className="mt-1 text-2xl font-bold">
                  {countOrCollection(
                    EXCHANGE_MAILBOXES.filter(
                      (m: any) => m.mailboxType === 'User'
                    ).length,
                    mailboxCollection.configuration,
                    hasCollectedMailboxTypes
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Active user mailboxes
                </div>
              </div>

              <div className="h-10 w-10 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center">
                <Mail className="h-5 w-5 text-blue-700" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Total Shared Mailboxes */}
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Total Shared Mailboxes
                </div>
                <div className="mt-1 text-2xl font-bold">
                  {countOrCollection(
                    EXCHANGE_MAILBOXES.filter(
                      (m: any) => m.mailboxType === 'Shared'
                    ).length,
                    mailboxCollection.configuration,
                    hasCollectedMailboxTypes
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Shared/support/team inboxes
                </div>
              </div>

              <div className="h-10 w-10 rounded-2xl bg-emerald-50 border border-emerald-100 flex items-center justify-center">
                <Users className="h-5 w-5 text-emerald-700" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Total Distribution Groups */}
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Total Distribution Groups
                </div>
                <div className="mt-1 text-2xl font-bold">
                  {
                    EXCHANGE_GROUPS.filter(
                      (g: any) =>
                        g.type === 'DistributionList' || g.type === 'DynamicDL'
                    ).length
                  }
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  DLs + Dynamic DLs
                </div>
              </div>

              <div className="h-10 w-10 rounded-2xl bg-purple-50 border border-purple-100 flex items-center justify-center">
                <Layers className="h-5 w-5 text-purple-700" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Mail Flow Rules Count */}
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Inbox Rules Count
                </div>
                <div className="mt-1 text-2xl font-bold">
                  {EXCHANGE_RULES.length}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  User mailbox inbox rules
                </div>
              </div>

              <div className="h-10 w-10 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center">
                <Shield className="h-5 w-5 text-amber-700" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Mailboxes */}
      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-0">
          <div className="flex items-center remind justify-between px-6 py-5 border-b">
            <div className="text-lg font-semibold">Mailboxes</div>
            <div className="relative w-full max-w-[320px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={mbxQuery}
                onChange={(e) => setMbxQuery(e.target.value)}
                placeholder="Search name, UPN, alias..."
                className="pl-10"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted-foreground bg-muted/30">
                <tr>
                  <th className="text-left px-6 py-3">Mailbox</th>
                  <th className="text-left px-6 py-3">Type</th>
                  <th className="text-left px-6 py-3">Size</th>
                  <th className="text-left px-6 py-3">Retention</th>
                  <th className="text-left px-6 py-3">Archive</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {(Array.isArray(mailboxes) ? mailboxes : []).map((m: any) => {
                  const aliases = Array.isArray(m.aliases) ? m.aliases : []
                  return (
                    <tr
                      key={m.id}
                      className="border-b cursor-pointer hover:bg-muted/40 transition"
                      onClick={() => setSelectedMailbox(m)}
                    >
                      <td className="px-6 py-4">
                        <div className="font-semibold flex items-center gap-2">
                          {m.displayName}
                          {m.mailboxType === 'Shared' && (
                            <Badge className="bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                              Shared
                            </Badge>
                          )}
                          {m.archiveEnabled && (
                            <Badge className="bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                              Archive
                            </Badge>
                          )}
                        </div>

                        <div className="mt-1 flex flex-wrap gap-2">
                          {m.delegation?.fullAccess?.length ? (
                            <Badge className="bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800">
                              Delegation
                            </Badge>
                          ) : null}
                          {m.retentionLabel ? (
                            <Badge className="bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                              Retention
                            </Badge>
                          ) : null}
                        </div>

                        <div className="text-xs text-muted-foreground">
                          {m.userPrincipalName}
                        </div>

                        {aliases.length ? (
                          <div className="mt-1 text-xs text-muted-foreground">
                            Aliases: {aliases.slice(0, 2).join(', ')}
                            {aliases.length > 2 ? '…' : ''}
                          </div>
                        ) : null}
                      </td>

                      <td className="px-6 py-4 text-muted-foreground">
                        {m.mailboxType ?? collectionLabel(m.collection?.configuration ?? mailboxCollection.configuration)}
                      </td>

                      <td className="px-6 py-4 text-muted-foreground">
                        {typeof m.sizeGB === 'number'
                          ? `${m.sizeGB.toFixed(1)} GB`
                          : collectionLabel(m.collection?.usage ?? mailboxCollection.usage)}
                      </td>

                      <td className="px-6 py-4 text-muted-foreground">
                        {m.retentionLabel || collectionLabel(m.collection?.configuration ?? mailboxCollection.configuration)}
                      </td>

                      <td className="px-6 py-4">
                        {typeof m.archiveEnabled === 'boolean' ? (
                          <Badge
                            className={
                              m.archiveEnabled
                                ? 'bg-green-50 dark:bg-green-950/60 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800'
                                : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700'
                            }
                          >
                            {m.archiveEnabled ? 'Enabled' : 'Off'}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">
                            {collectionLabel(m.collection?.configuration ?? mailboxCollection.configuration)}
                          </span>
                        )}
                      </td>

                      <td className="px-6 py-4 text-right">
                        <ChevronRight className="h-4 w-4 inline-block text-muted-foreground" />
                      </td>
                    </tr>
                  )
                })}

                {mailboxes.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-6 py-8 text-center text-muted-foreground"
                    >
                      No mailboxes found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Rules + Domains + Groups */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* Mail rules */}
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold">Mail Rules</div>
                <div className="text-sm text-muted-foreground">
                  Search rules and click to view details.
                </div>
              </div>
            </div>

            <div className="mt-4 flex gap-2">
              <select
                value={ruleMailboxFilter}
                onChange={(e) => setRuleMailboxFilter(e.target.value)}
                className="rounded-xl border border-slate-200 dark:border-slate-800 px-3 py-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              >
                <option value="all">All mailboxes</option>
                {mailboxes.map((m: any) => (
                  <option key={m.id} value={m.userPrincipalName}>
                    {m.displayName}
                  </option>
                ))}
              </select>

              <div className="relative w-full">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={ruleQuery}
                  onChange={(e) => setRuleQuery(e.target.value)}
                  placeholder="Search rule name, action, condition..."
                  className="pl-10"
                />
              </div>
            </div>

            <div className="mt-4 max-h-[420px] overflow-y-auto space-y-3">
              {rules.map((r: any) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedRule(r)}
                  className="w-full text-left rounded-xl border bg-muted/20 px-4 py-3 hover:bg-muted/30 transition flex gap-3"
                >
                  {/* Accent bar */}
                  <div
                    className={`w-1.5 rounded-full ${
                      r.enabled
                        ? 'bg-green-500'
                        : 'bg-slate-300 dark:bg-slate-700'
                    }`}
                  />

                  <div className="flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">
                          {r.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {r.mailboxUpn} • Priority {r.priority}
                        </div>
                      </div>

                      <Badge
                        className={
                          r.enabled
                            ? 'bg-green-50 dark:bg-green-950/60 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800 uppercase'
                            : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 uppercase'
                        }
                      >
                        {r.enabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </div>

                    <div className="mt-2 text-xs text-muted-foreground line-clamp-2">
                      {r.description}
                    </div>
                  </div>
                </button>
              ))}

              {rules.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-6">
                  No rules found.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Domains + Groups */}
        <div className="space-y-6">
          <Card className="rounded-2xl shadow-sm">
            <CardContent className="p-6">
              <div className="font-semibold">Accepted Domains</div>
              <div className="mt-4 space-y-3">
                {EXCHANGE_DOMAINS.map((d: any) => (
                  <div
                    key={d.id}
                    className="rounded-xl border bg-muted/20 px-4 py-3 flex items-center justify-between"
                  >
                    <div>
                      <div className="text-sm font-semibold">{d.domain}</div>
                      <div className="text-xs text-muted-foreground">
                        {d.type}
                      </div>
                    </div>
                    {d.isDefault ? (
                      <Badge className="bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                        Default
                      </Badge>
                    ) : (
                      <Badge className="bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                        Active
                      </Badge>
                    )}
                  </div>
                ))}
                {EXCHANGE_DOMAINS.length === 0 && (
                  <div className="text-sm text-muted-foreground py-4">
                    Accepted domains have not been synchronized.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-2xl shadow-sm">
            <CardContent className="p-6">
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold">Groups & Distribution</div>
                <div className="relative w-full max-w-[260px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={groupQuery}
                    onChange={(e) => setGroupQuery(e.target.value)}
                    placeholder="Search groups..."
                    className="pl-10"
                  />
                </div>
              </div>

              <div className="mt-4 max-h-[360px] overflow-y-auto space-y-3">
                {groups.map((g: any) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setSelectedGroup(g)}
                    className="w-full text-left rounded-xl border bg-muted/20 px-4 py-3 hover:bg-muted/30 transition"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">
                          {g.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {g.email}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {g.type} • {g.membersCount} members
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground mt-1" />
                    </div>
                  </button>
                ))}

                {groups.length === 0 && (
                  <div className="text-sm text-muted-foreground text-center py-6">
                    No groups found.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
