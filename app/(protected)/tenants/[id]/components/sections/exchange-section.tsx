'use client'

import React, { useMemo, useState, useEffect, useRef } from 'react'
import {
  Mail,
  Users,
  Layers,
  Shield,
  Search,
  ChevronRight,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  Building2,
  Globe,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Filter,
  ExternalLink,
  Archive,
  HardDrive,
  Menu
} from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatTenantTimestamp } from '@/lib/tenant-workspace-state'
import {
  exchangeDatasetStatus,
  type ExchangeDatasetStatus,
} from '@/lib/tenants/exchange-dataset-status'
import {
  classifyExchangeRule,
  compareExchangeRulePriority,
  exchangeRuleEnabledState,
  exchangeRulePriority,
  normalizeExchangeRuleDrawer,
  type ExchangeRuleDrawerFact,
  type ExchangeRuleCategory as RuleCategory,
} from '@/lib/tenants/exchange-rule-drawer'

export type ExchangeSectionProps = {
  bundle: any
  setSelectedMailbox?: (m: any) => void
  setSelectedGroup?: (g: any) => void
  onSync?: () => void
  syncState?: 'idle' | 'syncing' | 'success' | 'fail'
  onOpenMobileNav?: () => void
}

type TabKey = 'overview' | 'mailboxes' | 'rules' | 'domains-groups'
type DomainGroupSubtab = 'domains' | 'groups'

function datasetBadgeClass(status: ExchangeDatasetStatus): string {
  if (status.tone === 'success') {
    return 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
  }
  if (status.tone === 'danger') {
    return 'bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800'
  }
  if (status.tone === 'warning') {
    return 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800'
  }
  return 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
}

function RuleFactList({ facts, emptyText }: { facts: ExchangeRuleDrawerFact[]; emptyText: string }) {
  if (!facts.length) return <p className="text-slate-500 italic">{emptyText}</p>
  return (
    <ul className="space-y-2" role="list">
      {facts.map((fact) => (
        <li
          key={fact.key}
          className={cn(
            'rounded-lg border p-3 space-y-1',
            fact.emphasis === 'destination' && 'border-amber-200 bg-amber-50/70 dark:border-amber-900/70 dark:bg-amber-950/30',
            fact.emphasis === 'destructive' && 'border-red-200 bg-red-50/70 dark:border-red-900/70 dark:bg-red-950/30',
            fact.emphasis === 'standard' && 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900',
          )}
        >
          <div className="font-semibold text-slate-900 dark:text-slate-100">{fact.label}</div>
          {fact.values.length > 0 && (
            <ul className="space-y-1" aria-label={`${fact.label} values`}>
              {fact.values.map((value, index) => (
                <li key={`${fact.key}-${index}`} className="font-mono text-[11px] break-all text-slate-700 dark:text-slate-300">
                  {value}
                </li>
              ))}
            </ul>
          )}
          {fact.truncated && (
            <p className="text-[10px] text-slate-500">Additional Microsoft-provided values were omitted by HawkView&apos;s display limit.</p>
          )}
        </li>
      ))}
    </ul>
  )
}

export default function ExchangePage({
  bundle,
  setSelectedMailbox,
  setSelectedGroup,
  onSync,
  syncState = 'idle',
  onOpenMobileNav,
}: ExchangeSectionProps) {
  // Navigation & Sub-navigation State
  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const [domainGroupSubtab, setDomainGroupSubtab] = useState<DomainGroupSubtab>('domains')

  // Search & Filter States
  const [mbxQuery, setMbxQuery] = useState('')
  const [mbxTypeFilter, setMbxTypeFilter] = useState('all')
  const [mbxArchiveFilter, setMbxArchiveFilter] = useState('all')
  const [mbxRetentionFilter, setMbxRetentionFilter] = useState('all')
  const [mbxSortField, setMbxSortField] = useState<'displayName' | 'mailboxType' | 'sizeGB'>('displayName')
  const [mbxSortOrder, setMbxSortOrder] = useState<'asc' | 'desc'>('asc')

  const [ruleQuery, setRuleQuery] = useState('')
  const [ruleMailboxFilter, setRuleMailboxFilter] = useState('all')
  const [ruleEnabledFilter, setRuleEnabledFilter] = useState('all')
  const [ruleCategoryFilter, setRuleCategoryFilter] = useState('all')

  const [groupQuery, setGroupQuery] = useState('')

  // Drawer Inspection State (Wide 560-680px drawers managed locally for MSP speed & keyboard support)
  const [inspectingMailbox, setInspectingMailbox] = useState<any | null>(null)
  const [inspectingRule, setInspectingRule] = useState<any | null>(null)
  const [inspectingGroup, setInspectingGroup] = useState<any | null>(null)
  const ruleInvestigation = useMemo(
    () => inspectingRule ? normalizeExchangeRuleDrawer(inspectingRule) : null,
    [inspectingRule],
  )

  // Focus Return Reference
  const lastTriggerRef = useRef<HTMLElement | null>(null)
  const ruleDrawerRef = useRef<HTMLDivElement | null>(null)
  const ruleCloseButtonRef = useRef<HTMLButtonElement | null>(null)

  // Handle drawer closing & restoring focus
  const closeDrawers = React.useCallback(() => {
    setInspectingMailbox(null)
    setInspectingRule(null)
    setInspectingGroup(null)
    if (setSelectedMailbox) setSelectedMailbox(null)
    if (setSelectedGroup) setSelectedGroup(null)
    if (lastTriggerRef.current) {
      lastTriggerRef.current.focus()
    }
  }, [setSelectedMailbox, setSelectedGroup])

  // Global Escape key listener for active drawers
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (inspectingMailbox || inspectingRule || inspectingGroup)) {
        closeDrawers()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [inspectingMailbox, inspectingRule, inspectingGroup, closeDrawers])

  // Put keyboard focus inside the rule dialog and keep Tab navigation contained until it closes.
  useEffect(() => {
    if (!inspectingRule || !ruleInvestigation) return
    const drawer = ruleDrawerRef.current
    const closeButton = ruleCloseButtonRef.current
    closeButton?.focus()

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !drawer) return
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden'))
      if (!focusable.length) {
        event.preventDefault()
        drawer.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    drawer?.addEventListener('keydown', trapFocus)
    return () => drawer?.removeEventListener('keydown', trapFocus)
  }, [inspectingRule, ruleInvestigation])

  // Tenant Info
  const tenant = bundle?.tenant ?? {}
  const tenantName = tenant.name || 'Tenant'
  const primaryDomain = tenant.domain || ''

  // Raw Exchange Datasets
  const EXCHANGE_MAILBOXES = useMemo(() => {
    if (Array.isArray(bundle?.exchange?.mailboxes)) return bundle.exchange.mailboxes
    return []
  }, [bundle])

  const EXCHANGE_RULES = useMemo(() => {
    if (Array.isArray(bundle?.exchange?.rules)) return bundle.exchange.rules
    if (Array.isArray(bundle?.exchange?.transportRules)) return bundle.exchange.transportRules
    return []
  }, [bundle])

  const EXCHANGE_GROUPS = useMemo(() => {
    if (Array.isArray(bundle?.exchange?.groups)) return bundle.exchange.groups
    return []
  }, [bundle])

  const EXCHANGE_DOMAINS = useMemo(() => {
    if (Array.isArray(bundle?.exchange?.domains)) return bundle.exchange.domains
    if (Array.isArray(bundle?.exchange?.acceptedDomains)) return bundle.exchange.acceptedDomains
    return []
  }, [bundle])

  // Sync Freshness & Status Metadata
  const exchangeSync = bundle?.exchange?.sync ?? bundle?.sync?.exchange ?? {}
  const freshness = bundle?.syncFreshness?.services?.exchange ?? bundle?.tenant?.syncFreshness?.services?.exchange ?? null

  const isSyncing = syncState === 'syncing' || freshness?.status === 'RUNNING'

  // Last Attempt Timestamp & Formatting
  const lastAttemptRaw =
    freshness?.lastAttemptCompletedAt ||
    freshness?.lastAttemptStartedAt ||
    exchangeSync?.lastAttemptAt ||
    null

  const lastAttemptFormatted = lastAttemptRaw
    ? formatTenantTimestamp(lastAttemptRaw)
    : 'Awaiting first sync'

  // Last Successful Sync Timestamp & Formatting
  const lastSuccessRaw =
    freshness?.lastSuccessfulCollectionAt ||
    exchangeSync?.lastSuccessfulAt ||
    (tenant?.lastSync && freshness?.status !== 'FAILED' ? tenant.lastSync : null) ||
    null

  const lastSuccessFormatted = lastSuccessRaw
    ? formatTenantTimestamp(lastSuccessRaw)
    : 'No successful sync yet'

  // Current Sync Status Label & Indicator
  const rawStatus = freshness?.status || exchangeSync?.status || (syncState === 'fail' ? 'FAILED' : syncState === 'syncing' ? 'RUNNING' : 'UNKNOWN')

  const syncStatusLabel = (() => {
    if (isSyncing || rawStatus === 'RUNNING') return 'Syncing...'
    if (syncState === 'fail' || rawStatus === 'FAILED') return 'Sync failed'
    if (rawStatus === 'PARTIAL') return 'Partial sync'
    if (rawStatus === 'STALE' || freshness?.freshnessStatus === 'STALE') return 'Sync stale'
    if (rawStatus === 'NOT_COLLECTED' || freshness?.freshnessStatus === 'NEVER_SYNCED' || !lastSuccessRaw) return 'Awaiting first sync'
    if (rawStatus === 'SUCCESS' || syncState === 'success' || lastSuccessRaw) return 'Synchronized'
    return 'Unavailable'
  })()

  const syncStatusDotColor = (() => {
    if (isSyncing || rawStatus === 'RUNNING') return 'bg-amber-500 animate-pulse'
    if (syncState === 'fail' || rawStatus === 'FAILED') return 'bg-red-500'
    if (rawStatus === 'PARTIAL' || rawStatus === 'STALE') return 'bg-amber-500'
    if (rawStatus === 'SUCCESS' || syncState === 'success' || lastSuccessRaw) return 'bg-emerald-500'
    return 'bg-slate-400'
  })()

  // Freshness / Coverage Label
  const freshnessLabel = (() => {
    if (isSyncing || rawStatus === 'RUNNING') return 'Populating data...'
    if (syncState === 'fail' || rawStatus === 'FAILED') return 'Collection failed'
    if (rawStatus === 'PARTIAL') {
      const pCount = freshness?.partialFailures?.length ?? 1
      return `Partial data (${pCount} issue${pCount === 1 ? '' : 's'})`
    }
    if (rawStatus === 'STALE' || freshness?.freshnessStatus === 'STALE') return 'Stale dataset'
    if (rawStatus === 'NOT_COLLECTED' || freshness?.freshnessStatus === 'NEVER_SYNCED' || !lastSuccessRaw) return 'No data collected'
    if (freshness?.freshnessStatus === 'CURRENT' || rawStatus === 'SUCCESS' || lastSuccessRaw) return 'Current dataset'
    return 'Unavailable'
  })()

  // Dataset level error / sync states
  const mailboxesSyncStatus = bundle?.sync?.mailboxes || exchangeSync?.mailboxes || bundle?.sync?.exchange
  const rulesSyncStatus = bundle?.sync?.rules || exchangeSync?.inboxRules
  const domainsSyncStatus = bundle?.sync?.domains || exchangeSync?.acceptedDomains
  const groupsSyncStatus = bundle?.sync?.groups || exchangeSync?.groups
  const mailboxDatasetStatus = exchangeDatasetStatus(mailboxesSyncStatus, EXCHANGE_MAILBOXES.length)
  const ruleDatasetStatus = exchangeDatasetStatus(rulesSyncStatus, EXCHANGE_RULES.length)
  const domainDatasetStatus = exchangeDatasetStatus(domainsSyncStatus, EXCHANGE_DOMAINS.length)
  const groupDatasetStatus = exchangeDatasetStatus(groupsSyncStatus, EXCHANGE_GROUPS.length)

  // Extract unique mailbox types dynamically
  const uniqueMailboxTypes = useMemo(() => {
    const set = new Set<string>()
    EXCHANGE_MAILBOXES.forEach((m: any) => {
      if (m?.mailboxType) set.add(m.mailboxType)
    })
    return Array.from(set)
  }, [EXCHANGE_MAILBOXES])

  // Filtered & Sorted Mailboxes
  const mailboxes = useMemo(() => {
    let list = [...EXCHANGE_MAILBOXES]
    const q = mbxQuery.trim().toLowerCase()

    if (q) {
      list = list.filter((m: any) => {
        const aliases = Array.isArray(m.aliases) ? m.aliases.join(' ') : ''
        const text = `${m.displayName ?? ''} ${m.userPrincipalName ?? ''} ${aliases} ${m.mailboxType ?? ''}`.toLowerCase()
        return text.includes(q)
      })
    }

    if (mbxTypeFilter !== 'all') {
      list = list.filter((m: any) => m.mailboxType === mbxTypeFilter)
    }

    if (mbxArchiveFilter !== 'all') {
      if (mbxArchiveFilter === 'enabled') list = list.filter((m: any) => m.archiveEnabled === true)
      if (mbxArchiveFilter === 'disabled') list = list.filter((m: any) => m.archiveEnabled === false)
    }

    if (mbxRetentionFilter !== 'all') {
      if (mbxRetentionFilter === 'applied') list = list.filter((m: any) => Boolean(m.retentionLabel))
      if (mbxRetentionFilter === 'none') list = list.filter((m: any) => !m.retentionLabel)
    }

    list.sort((a: any, b: any) => {
      let valA = a[mbxSortField] ?? ''
      let valB = b[mbxSortField] ?? ''
      if (typeof valA === 'string') valA = valA.toLowerCase()
      if (typeof valB === 'string') valB = valB.toLowerCase()

      if (valA < valB) return mbxSortOrder === 'asc' ? -1 : 1
      if (valA > valB) return mbxSortOrder === 'asc' ? 1 : -1
      return 0
    })

    return list
  }, [EXCHANGE_MAILBOXES, mbxQuery, mbxTypeFilter, mbxArchiveFilter, mbxRetentionFilter, mbxSortField, mbxSortOrder])

  // Filtered Rules
  const rules = useMemo(() => {
    let list = [...EXCHANGE_RULES]
    const q = ruleQuery.trim().toLowerCase()

    if (ruleMailboxFilter !== 'all') {
      list = list.filter((r: any) => r.mailboxUpn === ruleMailboxFilter)
    }

    if (ruleEnabledFilter !== 'all') {
      list = list.filter((r: any) => exchangeRuleEnabledState(r) === ruleEnabledFilter)
    }

    if (ruleCategoryFilter !== 'all') {
      list = list.filter((r: any) => classifyExchangeRule(r) === ruleCategoryFilter)
    }

    if (q) {
      list = list.filter((r: any) => {
        const actions = Array.isArray(r.actions) ? r.actions.join(' ') : String(r.actions || '')
        const conds = Array.isArray(r.conditions) ? r.conditions.join(' ') : String(r.conditions || '')
        const text = `${r.name ?? ''} ${r.mailboxUpn ?? ''} ${r.description ?? ''} ${actions} ${conds}`.toLowerCase()
        return text.includes(q)
      })
    }

    list.sort(compareExchangeRulePriority)
    return list
  }, [EXCHANGE_RULES, ruleQuery, ruleMailboxFilter, ruleEnabledFilter, ruleCategoryFilter])

  // Filtered Groups
  const groups = useMemo(() => {
    let list = [...EXCHANGE_GROUPS]
    const q = groupQuery.trim().toLowerCase()
    if (!q) return list
    return list.filter((g: any) => {
      const text = `${g.name ?? ''} ${g.email ?? ''} ${g.type ?? ''}`.toLowerCase()
      return text.includes(q)
    })
  }, [EXCHANGE_GROUPS, groupQuery])

  // Overview Findings Derivation
  const overviewFindings = useMemo(() => {
    const findings: Array<{
      id: string
      type: 'forward' | 'redirect' | 'delete' | 'permission' | 'domain'
      title: string
      target: string
      reason: string
      count?: number
      onAction: () => void
    }> = []

    // 1. Forwarding / Redirect Rules
    const forwardingRules = EXCHANGE_RULES.filter((r: any) => r.enabled === true && (classifyExchangeRule(r) === 'Forward' || classifyExchangeRule(r) === 'Redirect'))
    if (forwardingRules.length > 0) {
      findings.push({
        id: 'finding-fwd-rules',
        type: 'forward',
        title: 'Forwarding / Redirect rule active',
        target: `${forwardingRules.length} rule${forwardingRules.length > 1 ? 's' : ''} configured`,
        reason: 'Inbox rules configured to forward or redirect incoming messages automatically to alternate recipients.',
        count: forwardingRules.length,
        onAction: () => {
          setActiveTab('rules')
          setRuleCategoryFilter('Forward')
        }
      })
    }

    // 2. Delete / Move Rules
    const deleteMoveRules = EXCHANGE_RULES.filter((r: any) => r.enabled === true && (classifyExchangeRule(r) === 'Delete' || classifyExchangeRule(r) === 'Move'))
    if (deleteMoveRules.length > 0) {
      findings.push({
        id: 'finding-del-rules',
        type: 'delete',
        title: 'Delete or move rule active',
        target: `${deleteMoveRules.length} rule${deleteMoveRules.length > 1 ? 's' : ''} configured`,
        reason: 'Inbox rules configured to move or delete incoming messages automatically upon receipt.',
        count: deleteMoveRules.length,
        onAction: () => {
          setActiveTab('rules')
          setRuleCategoryFilter('Delete')
        }
      })
    }

    // 3. Synchronization / Permission issue
    if (mailboxDatasetStatus.state === 'FAILED' || mailboxesSyncStatus?.lastError) {
      findings.push({
        id: 'finding-perm-error',
        type: 'permission',
        title: 'Exchange synchronization requires attention',
        target: 'Exchange Graph API Collection',
        reason: mailboxesSyncStatus?.lastError || 'Microsoft Graph returned an error or insufficient permissions during collection.',
        onAction: () => {
          if (onSync) onSync()
        }
      })
    }

    // 4. Accepted Domains State
    if (EXCHANGE_DOMAINS.length === 0 && !isSyncing) {
      findings.push({
        id: 'finding-domains-empty',
        type: 'domain',
        title: 'Accepted domains dataset unavailable',
        target: 'Accepted Domains Collection',
        reason: 'No accepted domains have been synchronized for this tenant.',
        onAction: () => {
          setActiveTab('domains-groups')
          setDomainGroupSubtab('domains')
        }
      })
    }

    return findings
  }, [EXCHANGE_RULES, EXCHANGE_DOMAINS, mailboxDatasetStatus.state, mailboxesSyncStatus, isSyncing, onSync])

  // Open Mailbox Drawer
  const openMailboxDrawer = (m: any, e: React.MouseEvent | React.KeyboardEvent) => {
    lastTriggerRef.current = e.currentTarget as HTMLElement
    setInspectingMailbox(m)
    if (setSelectedMailbox) setSelectedMailbox(m)
  }

  // Open Rule Drawer
  const openRuleDrawer = (r: any, e: React.MouseEvent | React.KeyboardEvent) => {
    lastTriggerRef.current = e.currentTarget as HTMLElement
    setInspectingRule(r)
  }

  // Open Group Drawer
  const openGroupDrawer = (g: any, e: React.MouseEvent | React.KeyboardEvent) => {
    lastTriggerRef.current = e.currentTarget as HTMLElement
    setInspectingGroup(g)
    if (setSelectedGroup) setSelectedGroup(g)
  }

  // Clear Mailbox Filters
  const clearMbxFilters = () => {
    setMbxQuery('')
    setMbxTypeFilter('all')
    setMbxArchiveFilter('all')
    setMbxRetentionFilter('all')
  }

  // Clear Rule Filters
  const clearRuleFilters = () => {
    setRuleQuery('')
    setRuleMailboxFilter('all')
    setRuleEnabledFilter('all')
    setRuleCategoryFilter('all')
  }

  return (
    <div className="mt-1 space-y-4 text-slate-900 dark:text-slate-100">
      {/* ================= SINGLE MERGED EXCHANGE WORKSPACE HEADER ================= */}
      <div className="flex flex-col gap-2.5 pb-3 border-b border-slate-200 dark:border-slate-800">
        {/* Top Row: Title, Mobile Trigger, Tenant Chip, Sync Now Button */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {onOpenMobileNav && (
              <button
                type="button"
                onClick={onOpenMobileNav}
                className="md:hidden inline-flex items-center justify-center p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                aria-label="Open navigation menu"
              >
                <Menu className="h-4 w-4" />
              </button>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
                  Exchange
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
                Monitor mailboxes, mail flow, domains, and distribution groups.
              </p>
            </div>
          </div>

          {/* Single Sync Now Button */}
          {onSync && (
            <Button
              type="button"
              size="sm"
              disabled={isSyncing}
              onClick={onSync}
              className="h-8 text-xs font-medium gap-1.5 cursor-pointer shrink-0 self-start sm:self-auto"
              aria-label="Synchronize Exchange dataset"
              aria-live="polite"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isSyncing && "animate-spin")} aria-hidden="true" />
              <span>{isSyncing ? "Syncing..." : syncState === 'success' ? "Synced" : syncState === 'fail' ? "Sync failed" : "Sync Now"}</span>
            </Button>
          )}
        </div>

        {/* Compact Secondary Metadata Status Group */}
        <div className="flex flex-wrap items-center gap-y-1.5 gap-x-3 sm:gap-x-4 text-xs text-slate-600 dark:text-slate-400 bg-slate-50/80 dark:bg-slate-800/50 px-3 py-2 rounded-lg border border-slate-200/80 dark:border-slate-800">
          {/* Status */}
          <div className="flex items-center gap-1.5 font-medium shrink-0">
            <span className={cn("h-2 w-2 rounded-full shrink-0", syncStatusDotColor)} aria-hidden="true" />
            <span className="text-slate-900 dark:text-slate-100 font-semibold">{syncStatusLabel}</span>
          </div>

          <span className="text-slate-300 dark:text-slate-700 hidden sm:inline" aria-hidden="true">•</span>

          {/* Coverage / Freshness */}
          <div className="shrink-0">
            <span className="text-slate-500 dark:text-slate-400">Coverage: </span>
            <span className="font-medium text-slate-800 dark:text-slate-200">{freshnessLabel}</span>
          </div>

          <span className="text-slate-300 dark:text-slate-700 hidden sm:inline" aria-hidden="true">•</span>

          {/* Last Attempt */}
          <div className="shrink-0">
            <span className="text-slate-500 dark:text-slate-400">Last attempt: </span>
            <span className="font-medium text-slate-800 dark:text-slate-200" title={lastAttemptRaw || undefined}>
              {lastAttemptFormatted}
            </span>
          </div>

          <span className="text-slate-300 dark:text-slate-700 hidden sm:inline" aria-hidden="true">•</span>

          {/* Last Success */}
          <div className="shrink-0">
            <span className="text-slate-500 dark:text-slate-400">Last success: </span>
            <span className="font-medium text-slate-800 dark:text-slate-200" title={lastSuccessRaw || undefined}>
              {lastSuccessFormatted}
            </span>
          </div>
        </div>

        {/* Sync Failure Warning Banner */}
        {syncState === 'fail' && (
          <div className="text-xs px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
              <span className="truncate">Synchronization attempt failed. Showing last known dataset.</span>
            </div>
            {onSync && (
              <button
                type="button"
                onClick={onSync}
                className="underline font-semibold shrink-0 hover:text-amber-900 dark:hover:text-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded px-1 cursor-pointer"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      {/* ================= FOUR PRIMARY TABS ================= */}
      <div className="border-b border-slate-200 dark:border-slate-800">
        <div role="tablist" aria-label="Exchange workspace navigation" className="flex gap-2 overflow-x-auto no-scrollbar">
          <button
            type="button"
            role="tab"
            id="tab-overview"
            aria-selected={activeTab === 'overview'}
            aria-controls="panel-overview"
            onClick={() => setActiveTab('overview')}
            className={cn(
              "px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer",
              activeTab === 'overview'
                ? "border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400 font-semibold"
                : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
            )}
          >
            Overview
          </button>
          <button
            type="button"
            role="tab"
            id="tab-mailboxes"
            aria-selected={activeTab === 'mailboxes'}
            aria-controls="panel-mailboxes"
            onClick={() => setActiveTab('mailboxes')}
            className={cn(
              "px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer flex items-center gap-1.5",
              activeTab === 'mailboxes'
                ? "border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400 font-semibold"
                : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
            )}
          >
            <span>Mailboxes</span>
            <span className="text-[11px] px-1.5 py-0.2 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-normal">
              {EXCHANGE_MAILBOXES.length}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            id="tab-rules"
            aria-selected={activeTab === 'rules'}
            aria-controls="panel-rules"
            onClick={() => setActiveTab('rules')}
            className={cn(
              "px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer flex items-center gap-1.5",
              activeTab === 'rules'
                ? "border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400 font-semibold"
                : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
            )}
          >
            <span>Rules & Forwarding</span>
            <span className="text-[11px] px-1.5 py-0.2 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-normal">
              {EXCHANGE_RULES.length}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            id="tab-domains-groups"
            aria-selected={activeTab === 'domains-groups'}
            aria-controls="panel-domains-groups"
            onClick={() => setActiveTab('domains-groups')}
            className={cn(
              "px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer",
              activeTab === 'domains-groups'
                ? "border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400 font-semibold"
                : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
            )}
          >
            Domains & Groups
          </button>
        </div>
      </div>

      {/* ================= TAB 1: OVERVIEW ================= */}
      {activeTab === 'overview' && (
        <div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview" className="space-y-5">
          {/* Top Operational Metrics */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            {/* User Mailboxes Metric */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-medium">
                <span>User Mailboxes</span>
                <Mail className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
              </div>
              <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                {EXCHANGE_MAILBOXES.filter((m: any) => m.mailboxType === 'User').length}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                Individual user inboxes
              </div>
            </div>

            {/* Shared Mailboxes Metric */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-medium">
                <span>Shared Mailboxes</span>
                <Users className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              </div>
              <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                {EXCHANGE_MAILBOXES.filter((m: any) => m.mailboxType === 'Shared').length}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                Shared & team inboxes
              </div>
            </div>

            {/* Distribution Groups Metric */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-medium">
                <span>Distribution Groups</span>
                <Layers className="h-4 w-4 text-purple-600 dark:text-purple-400" aria-hidden="true" />
              </div>
              <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                {EXCHANGE_GROUPS.length}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                Mail lists & security groups
              </div>
            </div>

            {/* Mail Rules Metric */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-medium">
                <span>Mail Rules</span>
                <Shield className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
              </div>
              <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                {EXCHANGE_RULES.length}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                Synchronized inbox rules
              </div>
            </div>
          </div>

          {/* Exchange Attention Section */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs space-y-3">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-2.5">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />
                <span>Exchange Attention</span>
              </h2>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {overviewFindings.length} item{overviewFindings.length === 1 ? '' : 's'} identified
              </span>
            </div>

            {overviewFindings.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {overviewFindings.map((finding) => (
                  <div
                    key={finding.id}
                    className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 flex flex-col justify-between gap-2 text-xs"
                  >
                    <div>
                      <div className="flex items-center justify-between font-semibold text-slate-900 dark:text-slate-100">
                        <span>{finding.title}</span>
                        <Badge className="bg-amber-100 dark:bg-amber-950/80 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800 text-[10px] uppercase">
                          {finding.type === 'forward' ? 'Forwarding' : finding.type === 'delete' ? 'Delete/Move' : 'Review'}
                        </Badge>
                      </div>
                      <div className="mt-1 font-medium text-slate-700 dark:text-slate-300">
                        {finding.target}
                      </div>
                      <p className="mt-1 text-slate-500 dark:text-slate-400 leading-relaxed">
                        {finding.reason}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={finding.onAction}
                      className="inline-flex items-center gap-1 font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 transition-colors self-start mt-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1 cursor-pointer"
                    >
                      <span>Investigate in tab</span>
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-slate-500 dark:text-slate-400 flex flex-col items-center gap-2">
                <CheckCircle2 className="h-6 w-6 text-emerald-500" aria-hidden="true" />
                <span>Exchange data is synchronized. No review findings were identified from the currently available dataset.</span>
              </div>
            )}
          </div>

          {/* Dataset Status Matrix */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs space-y-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Dataset Synchronization Status
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              {/* Mailboxes dataset */}
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-800/20">
                <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center justify-between">
                  <span>Mailboxes</span>
                  <Badge className={datasetBadgeClass(mailboxDatasetStatus)}>
                    {mailboxDatasetStatus.label}
                  </Badge>
                </div>
                <div className="mt-2 text-slate-500 dark:text-slate-400">
                  Record count: <span className="font-semibold text-slate-800 dark:text-slate-200">{EXCHANGE_MAILBOXES.length}</span>
                </div>
              </div>

              {/* Rules dataset */}
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-800/20">
                <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center justify-between">
                  <span>Inbox Rules</span>
                  <Badge className={datasetBadgeClass(ruleDatasetStatus)}>
                    {ruleDatasetStatus.label}
                  </Badge>
                </div>
                <div className="mt-2 text-slate-500 dark:text-slate-400">
                  Record count: <span className="font-semibold text-slate-800 dark:text-slate-200">{EXCHANGE_RULES.length}</span>
                </div>
              </div>

              {/* Accepted Domains dataset */}
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-800/20">
                <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center justify-between">
                  <span>Accepted Domains</span>
                  <Badge className={datasetBadgeClass(domainDatasetStatus)}>
                    {domainDatasetStatus.label}
                  </Badge>
                </div>
                <div className="mt-2 text-slate-500 dark:text-slate-400">
                  Record count: <span className="font-semibold text-slate-800 dark:text-slate-200">{EXCHANGE_DOMAINS.length}</span>
                </div>
              </div>

              {/* Groups dataset */}
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-800/20">
                <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center justify-between">
                  <span>Distribution Groups</span>
                  <Badge className={datasetBadgeClass(groupDatasetStatus)}>
                    {groupDatasetStatus.label}
                  </Badge>
                </div>
                <div className="mt-2 text-slate-500 dark:text-slate-400">
                  Record count: <span className="font-semibold text-slate-800 dark:text-slate-200">{EXCHANGE_GROUPS.length}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 2: MAILBOXES ================= */}
      {activeTab === 'mailboxes' && (
        <div role="tabpanel" id="panel-mailboxes" aria-labelledby="tab-mailboxes" className="space-y-4">
          {/* Dense Toolbar */}
          <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[280px]">
              {/* Search input */}
              <div className="relative flex-1 min-w-[200px] max-w-[320px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                <Input
                  type="text"
                  value={mbxQuery}
                  onChange={(e) => setMbxQuery(e.target.value)}
                  placeholder="Search display name, UPN, alias..."
                  className="pl-8 h-8 text-xs bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 focus-visible:ring-blue-500"
                  aria-label="Search mailboxes"
                />
              </div>

              {/* Type Filter */}
              <select
                value={mbxTypeFilter}
                onChange={(e) => setMbxTypeFilter(e.target.value)}
                className="h-8 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 text-xs bg-slate-50 dark:bg-slate-800/60 text-slate-800 dark:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
                aria-label="Filter by mailbox type"
              >
                <option value="all">All Types</option>
                {uniqueMailboxTypes.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>

              {/* Archive Filter */}
              <select
                value={mbxArchiveFilter}
                onChange={(e) => setMbxArchiveFilter(e.target.value)}
                className="h-8 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 text-xs bg-slate-50 dark:bg-slate-800/60 text-slate-800 dark:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
                aria-label="Filter by archive state"
              >
                <option value="all">All Archive States</option>
                <option value="enabled">Archive Enabled</option>
                <option value="disabled">Archive Off</option>
              </select>

              {/* Retention Filter */}
              <select
                value={mbxRetentionFilter}
                onChange={(e) => setMbxRetentionFilter(e.target.value)}
                className="h-8 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 text-xs bg-slate-50 dark:bg-slate-800/60 text-slate-800 dark:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
                aria-label="Filter by retention label"
              >
                <option value="all">All Retention</option>
                <option value="applied">Retention Applied</option>
                <option value="none">No Retention Policy</option>
              </select>

              {/* Clear Filters Button */}
              {(mbxQuery || mbxTypeFilter !== 'all' || mbxArchiveFilter !== 'all' || mbxRetentionFilter !== 'all') && (
                <button
                  type="button"
                  onClick={clearMbxFilters}
                  className="h-8 px-2 text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 flex items-center gap-1 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                  <span>Clear filters</span>
                </button>
              )}
            </div>

            {/* Result Count Indicator */}
            <div className="text-slate-500 dark:text-slate-400 font-medium shrink-0">
              Showing <span className="font-semibold text-slate-800 dark:text-slate-200">{mailboxes.length}</span> of {EXCHANGE_MAILBOXES.length} mailboxes
            </div>
          </div>

          {/* Mailboxes Dense Operational Table */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-2xs">
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left border-collapse min-w-[700px]">
                <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 font-semibold uppercase tracking-wider border-b border-slate-200 dark:border-slate-800 z-10 backdrop-blur-xs">
                  <tr>
                    <th scope="col" className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => {
                          if (mbxSortField === 'displayName') setMbxSortOrder(mbxSortOrder === 'asc' ? 'desc' : 'asc')
                          else { setMbxSortField('displayName'); setMbxSortOrder('asc') }
                        }}
                        className="flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 rounded cursor-pointer"
                      >
                        <span>Mailbox</span>
                        <ArrowUpDown className="h-3 w-3 text-slate-400" />
                      </button>
                    </th>
                    <th scope="col" className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => {
                          if (mbxSortField === 'mailboxType') setMbxSortOrder(mbxSortOrder === 'asc' ? 'desc' : 'asc')
                          else { setMbxSortField('mailboxType'); setMbxSortOrder('asc') }
                        }}
                        className="flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 rounded cursor-pointer"
                      >
                        <span>Type</span>
                        <ArrowUpDown className="h-3 w-3 text-slate-400" />
                      </button>
                    </th>
                    <th scope="col" className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => {
                          if (mbxSortField === 'sizeGB') setMbxSortOrder(mbxSortOrder === 'asc' ? 'desc' : 'asc')
                          else { setMbxSortField('sizeGB'); setMbxSortOrder('asc') }
                        }}
                        className="flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 rounded cursor-pointer"
                      >
                        <span>Size</span>
                        <ArrowUpDown className="h-3 w-3 text-slate-400" />
                      </button>
                    </th>
                    <th scope="col" className="px-4 py-3">Retention</th>
                    <th scope="col" className="px-4 py-3">Archive</th>
                    <th scope="col" className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80">
                  {mailboxes.map((m: any) => {
                    const aliases = Array.isArray(m.aliases) ? m.aliases : []
                    return (
                      <tr
                        key={m.id}
                        tabIndex={0}
                        onClick={(e) => openMailboxDrawer(m, e)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            openMailboxDrawer(m, e)
                          }
                        }}
                        className="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:bg-blue-50/50 dark:focus-visible:bg-slate-800"
                      >
                        {/* Mailbox Display Name & UPN */}
                        <td className="px-4 py-3">
                          <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2 max-w-[280px]">
                            <span className="truncate" title={m.displayName}>{m.displayName}</span>
                            {m.mailboxType === 'Shared' && (
                              <Badge className="bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800 text-[10px]">
                                Shared
                              </Badge>
                            )}
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[280px]" title={m.userPrincipalName}>
                            {m.userPrincipalName}
                          </div>
                          {aliases.length > 0 && (
                            <div className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500 truncate max-w-[280px]" title={aliases.join(', ')}>
                              Aliases: {aliases.slice(0, 2).join(', ')}{aliases.length > 2 ? '…' : ''}
                            </div>
                          )}
                        </td>

                        {/* Mailbox Type */}
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300 font-medium">
                          {m.mailboxType || 'Not provided by Microsoft'}
                        </td>

                        {/* Size */}
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300 font-medium">
                          {typeof m.sizeGB === 'number' ? `${m.sizeGB.toFixed(1)} GB` : 'Not collected by HawkView'}
                        </td>

                        {/* Retention */}
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-400">
                          {m.retentionLabel ? (
                            <span className="font-medium text-slate-800 dark:text-slate-200 truncate max-w-[160px] inline-block" title={m.retentionLabel}>
                              {m.retentionLabel}
                            </span>
                          ) : (
                            <span className="text-slate-400 italic">No retention label</span>
                          )}
                        </td>

                        {/* Archive */}
                        <td className="px-4 py-3">
                          {typeof m.archiveEnabled === 'boolean' ? (
                            <Badge className={m.archiveEnabled ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700"}>
                              {m.archiveEnabled ? 'Enabled' : 'Off'}
                            </Badge>
                          ) : (
                            <span className="text-slate-400 italic text-[11px]">Not collected</span>
                          )}
                        </td>

                        {/* Row Disclosure */}
                        <td className="px-4 py-3 text-right">
                          <ChevronRight className="h-4 w-4 inline-block text-slate-400 group-hover:text-slate-600" aria-hidden="true" />
                        </td>
                      </tr>
                    )
                  })}

                  {mailboxes.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
                        {EXCHANGE_MAILBOXES.length === 0 ? 'Awaiting first synchronization or no mailbox records found.' : 'No mailboxes match active filters.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 3: RULES & FORWARDING ================= */}
      {activeTab === 'rules' && (
        <div role="tabpanel" id="panel-rules" aria-labelledby="tab-rules" className="space-y-4">
          {/* Rules Toolbar */}
          <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[280px]">
              {/* Search Rules */}
              <div className="relative flex-1 min-w-[200px] max-w-[320px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                <Input
                  type="text"
                  value={ruleQuery}
                  onChange={(e) => setRuleQuery(e.target.value)}
                  placeholder="Search rule name, action, condition..."
                  className="pl-8 h-8 text-xs bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 focus-visible:ring-blue-500"
                  aria-label="Search rules"
                />
              </div>

              {/* Mailbox Filter */}
              <select
                value={ruleMailboxFilter}
                onChange={(e) => setRuleMailboxFilter(e.target.value)}
                className="h-8 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 text-xs bg-slate-50 dark:bg-slate-800/60 text-slate-800 dark:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer max-w-[180px]"
                aria-label="Filter by mailbox"
              >
                <option value="all">All Mailboxes</option>
                {EXCHANGE_MAILBOXES.map((m: any) => (
                  <option key={m.id} value={m.userPrincipalName}>{m.displayName || m.userPrincipalName}</option>
                ))}
              </select>

              {/* Category Filter */}
              <select
                value={ruleCategoryFilter}
                onChange={(e) => setRuleCategoryFilter(e.target.value)}
                className="h-8 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 text-xs bg-slate-50 dark:bg-slate-800/60 text-slate-800 dark:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
                aria-label="Filter by action category"
              >
                <option value="all">All Categories</option>
                <option value="Forward">Forwarding Rules</option>
                <option value="Redirect">Redirect Rules</option>
                <option value="Delete">Delete / Reject Rules</option>
                <option value="Move">Move Rules</option>
                <option value="Other">Other Rules</option>
              </select>

              {/* Enabled Filter */}
              <select
                value={ruleEnabledFilter}
                onChange={(e) => setRuleEnabledFilter(e.target.value)}
                className="h-8 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 text-xs bg-slate-50 dark:bg-slate-800/60 text-slate-800 dark:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
                aria-label="Filter by enabled state"
              >
                <option value="all">All Statuses</option>
                <option value="enabled">Enabled Only</option>
                <option value="disabled">Disabled Only</option>
                <option value="unknown">Not Provided</option>
              </select>

              {/* Clear Filters */}
              {(ruleQuery || ruleMailboxFilter !== 'all' || ruleCategoryFilter !== 'all' || ruleEnabledFilter !== 'all') && (
                <button
                  type="button"
                  onClick={clearRuleFilters}
                  className="h-8 px-2 text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 flex items-center gap-1 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                  <span>Clear filters</span>
                </button>
              )}
            </div>

            {/* Result Count */}
            <div className="text-slate-500 dark:text-slate-400 font-medium shrink-0">
              Showing <span className="font-semibold text-slate-800 dark:text-slate-200">{rules.length}</span> of {EXCHANGE_RULES.length} rules
            </div>
          </div>

          {/* Rules Investigation Table */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-2xs">
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left border-collapse min-w-[700px]">
                <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 font-semibold uppercase tracking-wider border-b border-slate-200 dark:border-slate-800 z-10 backdrop-blur-xs">
                  <tr>
                    <th scope="col" className="px-4 py-3">Rule Name & Category</th>
                    <th scope="col" className="px-4 py-3">Mailbox / Owner</th>
                    <th scope="col" className="px-4 py-3">Status</th>
                    <th scope="col" className="px-4 py-3">Priority</th>
                    <th scope="col" className="px-4 py-3">Conditions / Actions Summary</th>
                    <th scope="col" className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80">
                  {rules.map((r: any) => {
                    const category = classifyExchangeRule(r)
                    const enabledState = exchangeRuleEnabledState(r)
                    const priority = exchangeRulePriority(r)
                    return (
                      <tr
                        key={r.id}
                        tabIndex={0}
                        onClick={(e) => openRuleDrawer(r, e)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            openRuleDrawer(r, e)
                          }
                        }}
                        className="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:bg-blue-50/50 dark:focus-visible:bg-slate-800"
                      >
                        {/* Rule Name & Category */}
                        <td className="px-4 py-3">
                          <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                            <span className="truncate max-w-[220px]" title={r.name}>{r.name}</span>
                            <Badge className={cn(
                              "text-[10px]",
                              category === 'Forward' || category === 'Redirect'
                                ? "bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800"
                                : category === 'Delete'
                                  ? "bg-red-50 dark:bg-red-950/60 text-red-800 dark:text-red-300 border-red-200 dark:border-red-800"
                                  : "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700"
                            )}>
                              {category}
                            </Badge>
                          </div>
                        </td>

                        {/* Mailbox / Owner */}
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                          <span className="truncate max-w-[200px] inline-block font-mono text-[11px]" title={r.mailboxUpn}>
                            {r.mailboxUpn}
                          </span>
                        </td>

                        {/* Status */}
                        <td className="px-4 py-3">
                          <Badge className={enabledState === 'enabled' ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700"}>
                            {enabledState === 'enabled' ? 'Enabled' : enabledState === 'disabled' ? 'Disabled' : 'Not provided'}
                          </Badge>
                        </td>

                        {/* Priority */}
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-400 font-medium">
                          {priority === null ? 'Not provided' : `Priority ${priority}`}
                        </td>

                        {/* Summary */}
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-400 max-w-[280px]">
                          <div className="truncate text-[11px]" title={r.description || (Array.isArray(r.actions) ? r.actions.join(', ') : '')}>
                            {r.description || (Array.isArray(r.actions) ? r.actions.join(', ') : 'Rule action configured')}
                          </div>
                        </td>

                        {/* Action */}
                        <td className="px-4 py-3 text-right">
                          <ChevronRight className="h-4 w-4 inline-block text-slate-400" aria-hidden="true" />
                        </td>
                      </tr>
                    )
                  })}

                  {rules.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
                        {EXCHANGE_RULES.length === 0 ? 'No rules found or awaiting first synchronization.' : 'No rules match active filters.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 4: DOMAINS & GROUPS ================= */}
      {activeTab === 'domains-groups' && (
        <div role="tabpanel" id="panel-domains-groups" aria-labelledby="tab-domains-groups" className="space-y-4">
          {/* Secondary Segmented Control */}
          <div className="inline-flex p-1 rounded-lg bg-slate-100 dark:bg-slate-800/80 text-xs font-medium border border-slate-200 dark:border-slate-700/60">
            <button
              type="button"
              onClick={() => setDomainGroupSubtab('domains')}
              className={cn(
                "px-3 py-1.5 rounded-md transition-all cursor-pointer",
                domainGroupSubtab === 'domains'
                  ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-2xs font-semibold"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              )}
            >
              Accepted Domains ({EXCHANGE_DOMAINS.length})
            </button>
            <button
              type="button"
              onClick={() => setDomainGroupSubtab('groups')}
              className={cn(
                "px-3 py-1.5 rounded-md transition-all cursor-pointer",
                domainGroupSubtab === 'groups'
                  ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-2xs font-semibold"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              )}
            >
              Distribution Groups ({EXCHANGE_GROUPS.length})
            </button>
          </div>

          {/* SUBVIEW 1: ACCEPTED DOMAINS */}
          {domainGroupSubtab === 'domains' && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-2xs">
              <div className="p-3 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300">
                Accepted Domains Inventory
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left border-collapse">
                  <thead className="bg-slate-50 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 font-semibold uppercase tracking-wider border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th scope="col" className="px-4 py-3">Domain Name</th>
                      <th scope="col" className="px-4 py-3">Domain Type</th>
                      <th scope="col" className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {EXCHANGE_DOMAINS.map((d: any) => (
                      <tr key={d.id || d.domain} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                        <td className="px-4 py-3 font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                          <Globe className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />
                          <span>{d.domain}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300 font-medium">
                          {d.type || 'Authoritative'}
                        </td>
                        <td className="px-4 py-3">
                          {d.isDefault ? (
                            <Badge className="bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800">
                              Default Domain
                            </Badge>
                          ) : (
                            <Badge className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700">
                              Active
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}

                    {EXCHANGE_DOMAINS.length === 0 && (
                      <tr>
                        <td colSpan={3} className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
                          Accepted domains data is not collected or awaiting first synchronization.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SUBVIEW 2: DISTRIBUTION GROUPS */}
          {domainGroupSubtab === 'groups' && (
            <div className="space-y-3">
              {/* Toolbar */}
              <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-3 text-xs">
                <div className="relative flex-1 max-w-[320px]">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                  <Input
                    type="text"
                    value={groupQuery}
                    onChange={(e) => setGroupQuery(e.target.value)}
                    placeholder="Search group name, email, type..."
                    className="pl-8 h-8 text-xs bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 focus-visible:ring-blue-500"
                    aria-label="Search distribution groups"
                  />
                </div>
                <div className="text-slate-500 dark:text-slate-400 font-medium">
                  Showing <span className="font-semibold text-slate-800 dark:text-slate-200">{groups.length}</span> of {EXCHANGE_GROUPS.length} groups
                </div>
              </div>

              {/* Table */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-2xs">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead className="bg-slate-50 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 font-semibold uppercase tracking-wider border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th scope="col" className="px-4 py-3">Group Name</th>
                        <th scope="col" className="px-4 py-3">Email Address</th>
                        <th scope="col" className="px-4 py-3">Group Type</th>
                        <th scope="col" className="px-4 py-3">Members Count</th>
                        <th scope="col" className="px-4 py-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {groups.map((g: any) => (
                        <tr
                          key={g.id}
                          tabIndex={0}
                          onClick={(e) => openGroupDrawer(g, e)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              openGroupDrawer(g, e)
                            }
                          }}
                          className="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:bg-blue-50/50 dark:focus-visible:bg-slate-800"
                        >
                          <td className="px-4 py-3 font-semibold text-slate-900 dark:text-slate-100">
                            {g.name}
                          </td>
                          <td className="px-4 py-3 text-slate-600 dark:text-slate-400 font-mono text-[11px]">
                            {g.email || 'Not provided'}
                          </td>
                          <td className="px-4 py-3 text-slate-700 dark:text-slate-300 font-medium">
                            {g.type || 'DistributionList'}
                          </td>
                          <td className="px-4 py-3 text-slate-700 dark:text-slate-300 font-medium">
                            {typeof g.membersCount === 'number' ? `${g.membersCount} members` : 'Not provided'}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <ChevronRight className="h-4 w-4 inline-block text-slate-400" aria-hidden="true" />
                          </td>
                        </tr>
                      ))}

                      {groups.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
                            {EXCHANGE_GROUPS.length === 0 ? 'No distribution groups found or awaiting first synchronization.' : 'No groups match search query.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ================= MAILBOX DETAIL DRAWER (560-680px WIDE) ================= */}
      {inspectingMailbox && (
        <div className="fixed inset-0 z-[100] flex justify-end" role="dialog" aria-modal="true" aria-labelledby="mailbox-drawer-title">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity"
            onClick={closeDrawers}
            aria-hidden="true"
          />

          {/* Drawer Container (560-680px wide on desktop) */}
          <div className="relative z-10 w-full max-w-[640px] h-full bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-200 dark:border-slate-800 flex flex-col focus-visible:outline-none">
            {/* Drawer Header */}
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0 bg-slate-50/50 dark:bg-slate-800/40">
              <div className="flex items-center gap-2.5 min-w-0">
                <Mail className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <h2 id="mailbox-drawer-title" className="text-sm font-bold text-slate-900 dark:text-white truncate">
                    {inspectingMailbox.displayName}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    {inspectingMailbox.userPrincipalName}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={closeDrawers}
                className="h-8 w-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                aria-label="Close drawer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Drawer Body */}
            <div className="p-5 overflow-y-auto space-y-5 text-xs">
              {/* Identity Section */}
              <div className="space-y-2 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-wider text-slate-500">
                  Mailbox Identity
                </h3>
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div>
                    <span className="text-slate-500 dark:text-slate-400 block text-[11px]">Display Name</span>
                    <span className="font-semibold text-slate-900 dark:text-slate-100">{inspectingMailbox.displayName}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 dark:text-slate-400 block text-[11px]">Mailbox Type</span>
                    <Badge className="mt-0.5 bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800">
                      {inspectingMailbox.mailboxType || 'User'}
                    </Badge>
                  </div>
                  <div className="col-span-2">
                    <span className="text-slate-500 dark:text-slate-400 block text-[11px]">Primary Address (UPN)</span>
                    <span className="font-mono text-slate-800 dark:text-slate-200">{inspectingMailbox.userPrincipalName}</span>
                  </div>
                </div>
              </div>

              {/* Mailbox Data Section */}
              <div className="space-y-2 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-wider text-slate-500">
                  Mailbox Data & Configuration
                </h3>
                <div className="grid grid-cols-3 gap-3 pt-1">
                  <div>
                    <span className="text-slate-500 dark:text-slate-400 block text-[11px]">Mailbox Size</span>
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      {typeof inspectingMailbox.sizeGB === 'number' ? `${inspectingMailbox.sizeGB.toFixed(1)} GB` : 'Not collected by HawkView'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 dark:text-slate-400 block text-[11px]">Archive State</span>
                    <Badge className={inspectingMailbox.archiveEnabled ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700"}>
                      {typeof inspectingMailbox.archiveEnabled === 'boolean' ? (inspectingMailbox.archiveEnabled ? 'Enabled' : 'Off') : 'Not collected'}
                    </Badge>
                  </div>
                  <div>
                    <span className="text-slate-500 dark:text-slate-400 block text-[11px]">Retention Policy</span>
                    <span className="font-medium text-slate-800 dark:text-slate-200">
                      {inspectingMailbox.retentionLabel || 'Not provided by Microsoft'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Related Rules Section */}
              <div className="space-y-2.5 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-wider text-slate-500">
                  Associated Mail Rules
                </h3>
                {(() => {
                  const mailboxRules = EXCHANGE_RULES.filter(
                    (r: any) => r.mailboxUpn === inspectingMailbox.userPrincipalName || r.mailboxUpn === 'all'
                  )
                  if (mailboxRules.length === 0) {
                    return <p className="text-slate-500 italic">No rules found for this mailbox.</p>
                  }
                  return (
                    <div className="space-y-2">
                      {mailboxRules.map((rule: any) => (
                        <div key={rule.id} className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-800 flex items-center justify-between">
                          <div>
                            <div className="font-semibold text-slate-900 dark:text-slate-100">{rule.name}</div>
                            <div className="text-[11px] text-slate-500">{rule.description || 'Inbox rule'}</div>
                          </div>
                          <Badge className={rule.enabled ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700"}>
                            {rule.enabled ? 'Enabled' : 'Off'}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>

              {/* Optional Aliases & Delegation */}
              {Array.isArray(inspectingMailbox.aliases) && inspectingMailbox.aliases.length > 0 && (
                <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-2">
                  <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-wider text-slate-500">
                    Mailbox Aliases
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {inspectingMailbox.aliases.map((alias: string) => (
                      <span key={alias} className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 font-mono text-[11px]">
                        {alias}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================= RULE DETAIL DRAWER ================= */}
      {inspectingRule && ruleInvestigation && (
        <div className="fixed inset-0 z-[100] flex justify-end" role="dialog" aria-modal="true" aria-labelledby="rule-drawer-title">
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity" onClick={closeDrawers} aria-hidden="true" />
          <div ref={ruleDrawerRef} tabIndex={-1} className="relative z-10 w-full max-w-[640px] h-full bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-200 dark:border-slate-800 flex flex-col focus-visible:outline-none">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0 bg-slate-50/50 dark:bg-slate-800/40">
              <div className="flex items-center gap-2.5 min-w-0">
                <Shield className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <h2 id="rule-drawer-title" className="text-sm font-bold text-slate-900 dark:text-white truncate">
                    {ruleInvestigation.name}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    {ruleInvestigation.mailboxUpn || 'Mailbox not provided by Microsoft'}
                  </p>
                </div>
              </div>
              <button
                ref={ruleCloseButtonRef}
                type="button"
                onClick={closeDrawers}
                className="h-8 w-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                aria-label="Close drawer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">Current rule state</span>
                  <Badge className={ruleInvestigation.enabled === true ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700"}>
                    {ruleInvestigation.enabled === null ? 'Not provided' : ruleInvestigation.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <span className="text-slate-500 block text-[11px]">Mailbox</span>
                    <span className="font-mono text-slate-800 dark:text-slate-200 break-all">{ruleInvestigation.mailboxUpn || 'Not provided by Microsoft'}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[11px]">Priority / sequence</span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {ruleInvestigation.priority === null ? 'Not provided by Microsoft' : ruleInvestigation.priority}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[11px]">Read-only rule</span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {ruleInvestigation.isReadOnly === null ? 'Not provided by Microsoft' : ruleInvestigation.isReadOnly ? 'Yes' : 'No'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[11px]">Microsoft error state</span>
                    <span className={cn(
                      'font-semibold',
                      ruleInvestigation.hasError === true ? 'text-red-700 dark:text-red-300' : 'text-slate-800 dark:text-slate-200',
                    )}>
                      {ruleInvestigation.hasError === null ? 'Not provided by Microsoft' : ruleInvestigation.hasError ? 'Rule has an error' : 'No error reported'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="p-3.5 rounded-xl border border-amber-200 dark:border-amber-900/70 bg-amber-50/60 dark:bg-amber-950/20 space-y-3">
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
                  <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-wider">
                    Destinations
                  </h3>
                </div>
                {ruleInvestigation.destinations.length === 0 ? (
                  <p className="text-slate-600 dark:text-slate-400 italic">Microsoft did not provide a destination action for this rule.</p>
                ) : (
                  <ul className="space-y-2" role="list">
                    {ruleInvestigation.destinations.map((destination) => (
                      <li key={destination.key} className="rounded-lg border border-amber-200/80 dark:border-amber-900/70 bg-white/80 dark:bg-slate-900/60 p-3 space-y-1.5">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">{destination.label}</div>
                        <ul className="space-y-1" aria-label={`${destination.label} values`}>
                          {destination.values.map((value, index) => (
                            <li key={`${destination.key}-${index}`} className="font-mono text-[11px] break-all text-slate-800 dark:text-slate-200">{value}</li>
                          ))}
                        </ul>
                        {destination.kind === 'folder' && (
                          <p className="text-[11px] text-slate-500 dark:text-slate-400">Folder display name: Not collected with current permission</p>
                        )}
                        {destination.truncated && (
                          <p className="text-[10px] text-slate-500">Additional Microsoft-provided destinations were omitted by HawkView&apos;s display limit.</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-2">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-wider text-slate-500">
                  What triggers this rule
                </h3>
                <RuleFactList
                  facts={ruleInvestigation.conditions}
                  emptyText="Microsoft did not provide condition values for this rule."
                />
                {ruleInvestigation.exceptions.length > 0 && (
                  <div className="pt-2 space-y-2">
                    <h4 className="font-semibold text-slate-700 dark:text-slate-300">Exceptions reported by Microsoft</h4>
                    <RuleFactList facts={ruleInvestigation.exceptions} emptyText="" />
                  </div>
                )}
              </div>

              {ruleInvestigation.otherActions.length > 0 && (
              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-2">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-wider text-slate-500">
                  Other actions
                </h3>
                <RuleFactList
                  facts={ruleInvestigation.otherActions}
                  emptyText="Microsoft did not provide action values for this rule."
                />
              </div>
              )}

              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-3">
                <div className="flex items-center gap-2">
                  <Archive className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                  <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-wider text-slate-500">
                    Microsoft object history
                  </h3>
                </div>
                <dl className="divide-y divide-slate-200 dark:divide-slate-800">
                  <div className="py-2 flex items-start justify-between gap-4"><dt className="text-slate-500">Created</dt><dd className="font-medium text-right text-slate-800 dark:text-slate-200">Not provided by Microsoft Graph</dd></div>
                  <div className="py-2 flex items-start justify-between gap-4"><dt className="text-slate-500">Last modified</dt><dd className="font-medium text-right text-slate-800 dark:text-slate-200">Not provided by Microsoft Graph</dd></div>
                  <div className="py-2 flex items-start justify-between gap-4"><dt className="text-slate-500">Actor</dt><dd className="font-medium text-right text-slate-800 dark:text-slate-200">Not provided by Microsoft Graph</dd></div>
                  <div className="py-2 flex items-start justify-between gap-4"><dt className="text-slate-500">Configuration collected by HawkView</dt><dd className="font-medium text-right text-slate-800 dark:text-slate-200">{ruleInvestigation.configurationCollectedAt ? formatTenantTimestamp(ruleInvestigation.configurationCollectedAt) : 'Not available'}</dd></div>
                </dl>
                <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">Microsoft Unified Audit may contain separate mailbox-rule change events. HawkView does not correlate those events to this object or use them as its creation time or actor.</p>
              </div>

              <div className="p-3.5 rounded-xl border border-blue-200 dark:border-blue-900/60 bg-blue-50/50 dark:bg-blue-950/30 text-blue-800 dark:text-blue-300 flex items-start gap-2">
                <Info className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400 mt-0.5" />
                <span>These are mailbox-rule settings reported by Microsoft. HawkView does not infer who created the rule, why it was created, or whether the rule indicates compromise.</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================= GROUP DETAIL DRAWER ================= */}
      {inspectingGroup && (
        <div className="fixed inset-0 z-[100] flex justify-end" role="dialog" aria-modal="true" aria-labelledby="group-drawer-title">
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity" onClick={closeDrawers} aria-hidden="true" />
          <div className="relative z-10 w-full max-w-[640px] h-full bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-200 dark:border-slate-800 flex flex-col focus-visible:outline-none">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0 bg-slate-50/50 dark:bg-slate-800/40">
              <div className="flex items-center gap-2.5 min-w-0">
                <Layers className="h-5 w-5 text-purple-600 dark:text-purple-400 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <h2 id="group-drawer-title" className="text-sm font-bold text-slate-900 dark:text-white truncate">
                    {inspectingGroup.name}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    {inspectingGroup.email || 'No email address'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeDrawers}
                className="h-8 w-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                aria-label="Close drawer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-2">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <span className="text-slate-500 block text-[11px]">Group Type</span>
                    <span className="font-semibold text-slate-900 dark:text-slate-100">{inspectingGroup.type || 'DistributionList'}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[11px]">Members Count</span>
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      {typeof inspectingGroup.membersCount === 'number' ? `${inspectingGroup.membersCount} members` : 'Not provided'}
                    </span>
                  </div>
                </div>
              </div>

              {inspectingGroup.description && (
                <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-1">
                  <span className="text-slate-500 block text-[11px]">Description</span>
                  <p className="text-slate-800 dark:text-slate-200">{inspectingGroup.description}</p>
                </div>
              )}

              {Array.isArray(inspectingGroup.owners) && inspectingGroup.owners.length > 0 && (
                <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-2">
                  <span className="text-slate-500 block text-[11px]">Group Owners</span>
                  <div className="space-y-1">
                    {inspectingGroup.owners.map((owner: string) => (
                      <div key={owner} className="font-mono text-slate-800 dark:text-slate-200">{owner}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
