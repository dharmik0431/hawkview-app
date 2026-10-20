'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowLeft,
  Building2,
  Cloud,
  Fingerprint,
  FolderOpen,
  Grid2X2,
  Layers3,
  ListChecks,
  Mail,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useAuth } from '@/components/providers/auth-provider'
import { apiClient } from '@/lib/api/client'
import { canManagePolicies } from '@/lib/auth/policy-access'

type Check = {
  id: string
  title: string
  service: string
  recommendation: string
  choiceGroup: string | null
  source: string
  expected: string
  guidance: string
  resourceType: string | null
  parameterKind?:
    | 'approvedDomains'
    | 'approvedDomainGuids'
    | 'minimumDays'
    | 'requiredDomains'
}
type CheckSettings = {
  'sharepoint-approved-partner-domains-v1'?: { approvedDomains: string[] }
  'onedrive-sync-approved-domain-guids-v1'?: { approvedDomainGuids: string[] }
  'onedrive-deleted-user-retention-minimum-v1'?: { minimumDays: number }
  'm365-required-verified-domains-v1'?: { requiredDomains: string[] }
}
type Baseline = {
  id: string
  name: string
  checkIds: string[]
  checkSettings?: CheckSettings
  revision: number
  updatedAt: string
  assignedTenantCount: number
}
type Starter = {
  id: string
  name: string
  description: string
  boundary: string
  checkIds: string[]
}
type Library = {
  items: Baseline[]
  total: number
  page: number
  pageSize: number
  catalog: Check[]
  starter: Starter
}
type Assignment = {
  tenantId: string
  name: string
  domain: string | null
  assignedAt: string
}
type Detail = {
  baseline: Baseline
  catalog: Check[]
  starter: Starter
  checks: Check[]
  assignments: Assignment[]
  matchingTenants: number
  page: number
  pageSize: number
  revisions: Array<{
    revision: number
    createdAt: string
    name: string
    checkIds: string[]
    checkSettings: CheckSettings
  }>
}
type Choice = {
  id: string
  displayName: string | null
  primaryDomain: string | null
  baselineId: string | null
}
type Choices = {
  items: Choice[]
  total: number
  page: number
  pageSize: number
}

const services = [
  'Entra',
  'SharePoint',
  'OneDrive',
  'Exchange',
  'Microsoft 365',
]
const service = (check: Check) => check.service
// These are generic Lucide symbols, not Microsoft product logos or brand marks.
const serviceStyles = {
  Entra: {
    icon: Fingerprint,
    mark: 'bg-violet-100 text-violet-700 ring-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:ring-violet-800',
    card: 'border-violet-200 bg-violet-50/60 dark:border-violet-900 dark:bg-violet-950/30',
    pill: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
    accent: 'border-l-violet-400',
  },
  SharePoint: {
    icon: FolderOpen,
    mark: 'bg-teal-100 text-teal-700 ring-teal-200 dark:bg-teal-950 dark:text-teal-200 dark:ring-teal-800',
    card: 'border-teal-200 bg-teal-50/60 dark:border-teal-900 dark:bg-teal-950/30',
    pill: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200',
    accent: 'border-l-teal-400',
  },
  OneDrive: {
    icon: Cloud,
    mark: 'bg-sky-100 text-sky-700 ring-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-800',
    card: 'border-sky-200 bg-sky-50/60 dark:border-sky-900 dark:bg-sky-950/30',
    pill: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
    accent: 'border-l-sky-400',
  },
  Exchange: {
    icon: Mail,
    mark: 'bg-amber-100 text-amber-700 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800',
    card: 'border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30',
    pill: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
    accent: 'border-l-amber-400',
  },
  'Microsoft 365': {
    icon: Grid2X2,
    mark: 'bg-fuchsia-100 text-fuchsia-700 ring-fuchsia-200 dark:bg-fuchsia-950 dark:text-fuchsia-200 dark:ring-fuchsia-800',
    card: 'border-fuchsia-200 bg-fuchsia-50/60 dark:border-fuchsia-900 dark:bg-fuchsia-950/30',
    pill: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-200',
    accent: 'border-l-fuchsia-400',
  },
} as const
type ServiceName = keyof typeof serviceStyles
const fallbackStyle = {
  icon: ShieldCheck,
  mark: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700',
  card: 'border-slate-200 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-800/30',
  pill: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  accent: 'border-l-slate-400',
} as const
const styleFor = (name: string) =>
  serviceStyles[name as ServiceName] ?? fallbackStyle

function ServiceMark({
  name,
  small = false,
}: {
  name: string
  small?: boolean
}) {
  const style = styleFor(name)
  const Icon = style.icon
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-lg ring-1 ${small ? 'h-7 w-7' : 'h-10 w-10'} ${style.mark}`}
    >
      <Icon size={small ? 15 : 21} strokeWidth={1.9} />
    </span>
  )
}

function ServicePill({ name }: { name: string }) {
  const style = styleFor(name)
  const Icon = style.icon
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${style.pill}`}
    >
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      {name}
    </span>
  )
}
const panel =
  'rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
const field =
  'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950'
const secondary =
  'rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-slate-700'
const primary =
  'rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50'
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'The request could not be completed.'
const formatDate = (value: string) => new Date(value).toLocaleDateString()
const listText = (values?: string[]) => values?.join('\n') ?? ''
const parseListText = (value: string) =>
  value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
const settingSummary = (check: Check, settings: CheckSettings) => {
  if (check.parameterKind === 'approvedDomains')
    return `Approved partner domains: ${settings['sharepoint-approved-partner-domains-v1']?.approvedDomains?.join(', ') || 'Not set'}`
  if (check.parameterKind === 'approvedDomainGuids')
    return `Approved sync domain GUIDs: ${settings['onedrive-sync-approved-domain-guids-v1']?.approvedDomainGuids?.join(', ') || 'Not set'}`
  if (check.parameterKind === 'minimumDays')
    return `Minimum: ${settings['onedrive-deleted-user-retention-minimum-v1']?.minimumDays ?? 'Not set'} days`
  if (check.parameterKind === 'requiredDomains')
    return `Required verified domains: ${settings['m365-required-verified-domains-v1']?.requiredDomains?.join(', ') || 'Not set'}`
  return null
}

function Pager({
  page,
  total,
  size,
  change,
}: {
  page: number
  total: number
  size: number
  change: (page: number) => void
}) {
  const last = Math.max(1, Math.ceil(total / size))
  return (
    <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-800">
      <span className="text-slate-500">
        {total
          ? `${(page - 1) * size + 1}–${Math.min(page * size, total)} of ${total}`
          : 'No results'}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={secondary}
          disabled={page <= 1}
          onClick={() => change(page - 1)}
        >
          Previous
        </button>
        <span>
          {page} / {last}
        </span>
        <button
          type="button"
          className={secondary}
          disabled={page >= last}
          onClick={() => change(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  )
}

export default function BaselinesPage() {
  const { session, isLoading: sessionLoading } = useAuth()
  const router = useRouter()
  const query = useSearchParams()
  const workspaces = useMemo(
    () =>
      (session?.user.memberships ?? [])
        .filter(
          (m) =>
            m.status === 'ACTIVE' &&
            m.organization.status === 'ACTIVE' &&
            (m.role === 'MSP_OWNER' || m.role === 'MSP_ADMIN')
        )
        .map((m) => m.organization),
    [session]
  )
  const workspace =
    workspaces.find((item) => item.id === query.get('workspace')) ??
    workspaces[0]
  const baselineId = query.get('baseline')
  const url = workspace
    ? `/api/policies/workspaces/${encodeURIComponent(workspace.id)}/baselines`
    : null
  const [library, setLibrary] = useState<Library | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [choices, setChoices] = useState<Choices | null>(null)
  const [listPage, setListPage] = useState(1)
  const [assignedPage, setAssignedPage] = useState(1)
  const [choicePage, setChoicePage] = useState(1)
  const [listSearch, setListSearch] = useState('')
  const [listFilter, setListFilter] = useState('')
  const [assignedSearch, setAssignedSearch] = useState('')
  const [assignedFilter, setAssignedFilter] = useState('')
  const [choiceSearch, setChoiceSearch] = useState('')
  const [choiceFilter, setChoiceFilter] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [formStep, setFormStep] = useState<'requirements' | 'review'>(
    'requirements'
  )
  const [assignOpen, setAssignOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [checkIds, setCheckIds] = useState<string[]>([])
  const [checkSettings, setCheckSettings] = useState<CheckSettings>({})
  const [partnerDomainDraft, setPartnerDomainDraft] = useState('')
  const [syncGuidDraft, setSyncGuidDraft] = useState('')
  const [requiredDomainDraft, setRequiredDomainDraft] = useState('')
  const [catalogSearch, setCatalogSearch] = useState('')
  const [catalogService, setCatalogService] = useState('All')
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const navigate = (id: string | null, workspaceId = workspace?.id) => {
    const params = new URLSearchParams()
    if (workspaceId) params.set('workspace', workspaceId)
    if (id) params.set('baseline', id)
    router.push(`/policies/baselines?${params}`)
  }
  const loadLibrary = useCallback(
    async (signal?: AbortSignal) => {
      if (!url) return
      const result = await apiClient.get<Library>(url, {
        params: { page: String(listPage), search: listFilter },
        signal,
      })
      if (!signal?.aborted) setLibrary(result)
    },
    [url, listPage, listFilter]
  )
  const loadDetail = useCallback(
    async (signal?: AbortSignal) => {
      if (!url || !baselineId) return
      const result = await apiClient.get<Detail>(
        `${url}/${encodeURIComponent(baselineId)}`,
        {
          params: { page: String(assignedPage), search: assignedFilter },
          signal,
        }
      )
      if (!signal?.aborted) setDetail(result)
    },
    [url, baselineId, assignedPage, assignedFilter]
  )
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    setError(null)
    setLoading(true)
    void (
      baselineId
        ? loadDetail(controller.signal)
        : loadLibrary(controller.signal)
    )
      .catch((caught) => {
        if (!controller.signal.aborted) setError(errorText(caught))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [url, baselineId, loadDetail, loadLibrary])
  useEffect(() => {
    setDetail(null)
  }, [baselineId, url])
  useEffect(() => {
    if (!assignOpen || !url) return
    const controller = new AbortController()
    void apiClient
      .get<Choices>(`${url}/tenant-choices`, {
        params: { page: String(choicePage), search: choiceFilter },
        signal: controller.signal,
      })
      .then((result) => {
        if (!controller.signal.aborted) setChoices(result)
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(errorText(caught))
      })
    return () => controller.abort()
  }, [assignOpen, url, choicePage, choiceFilter])
  const start = (starter: boolean) => {
    setError(null)
    setEditing(false)
    setFormOpen(true)
    setFormStep('requirements')
    setName(starter ? 'HawkView Essentials copy' : '')
    setCheckIds(starter ? [...(library?.starter.checkIds ?? [])] : [])
    setCheckSettings({})
    setPartnerDomainDraft('')
    setSyncGuidDraft('')
    setRequiredDomainDraft('')
    setCatalogSearch('')
    setCatalogService('All')
    setSelectedOnly(false)
  }
  const edit = () => {
    if (detail) {
      setError(null)
      setEditing(true)
      setFormOpen(true)
      setFormStep('requirements')
      setName(detail.baseline.name)
      setCheckIds([...detail.baseline.checkIds])
      setCheckSettings(detail.baseline.checkSettings ?? {})
      setPartnerDomainDraft(
        listText(
          detail.baseline.checkSettings?.[
            'sharepoint-approved-partner-domains-v1'
          ]?.approvedDomains
        )
      )
      setSyncGuidDraft(
        listText(
          detail.baseline.checkSettings?.[
            'onedrive-sync-approved-domain-guids-v1'
          ]?.approvedDomainGuids
        )
      )
      setRequiredDomainDraft(
        listText(
          detail.baseline.checkSettings?.['m365-required-verified-domains-v1']
            ?.requiredDomains
        )
      )
      setCatalogSearch('')
      setCatalogService('All')
      setSelectedOnly(false)
    }
  }
  const save = async () => {
    if (!url || busy) return
    setBusy(true)
    setError(null)
    try {
      const selectedSettings = Object.fromEntries(
        Object.entries(checkSettings).filter(([id]) => checkIds.includes(id))
      ) as CheckSettings
      if (editing && baselineId) {
        await apiClient.patch(`${url}/${encodeURIComponent(baselineId)}`, {
          name,
          checkIds,
          checkSettings: selectedSettings,
          expectedRevision: detail?.baseline.revision,
        })
        await loadDetail()
      } else {
        const created = await apiClient.post<{ id: string }>(url, {
          name,
          checkIds,
          checkSettings: selectedSettings,
        })
        navigate(created.id)
        setChoices(null)
        setChoicePage(1)
        setAssignOpen(true)
      }
      setFormOpen(false)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }
  const apply = async (tenantId: string) => {
    if (!url || !baselineId || busy) return
    setBusy(true)
    setError(null)
    try {
      await apiClient.put(
        `${url}/${encodeURIComponent(baselineId)}/assignments/${encodeURIComponent(tenantId)}`,
        {}
      )
      setChoices(
        await apiClient.get<Choices>(`${url}/tenant-choices`, {
          params: { page: String(choicePage), search: choiceFilter },
        })
      )
      await loadDetail()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  if (sessionLoading)
    return (
      <div role="status" className={panel + ' p-6'}>
        Loading policies…
      </div>
    )
  if (!canManagePolicies(session) || !workspace)
    return (
      <div role="alert" className={panel + ' p-6'}>
        Baseline policies are available to MSP owners and admins in their active
        workspaces.
      </div>
    )
  const catalog = detail?.catalog ?? library?.catalog ?? []
  const catalogServices = Array.from(
    new Set([...services, ...catalog.map(service)])
  )
  const recommendedIds =
    detail?.starter.checkIds ?? library?.starter.checkIds ?? []
  const normalizedCatalogSearch = catalogSearch.trim().toLocaleLowerCase()
  const visibleChecks = catalog.filter(
    (check) =>
      (catalogService === 'All' || service(check) === catalogService) &&
      (!selectedOnly || checkIds.includes(check.id)) &&
      (!normalizedCatalogSearch ||
        `${check.title} ${check.expected} ${check.guidance}`
          .toLocaleLowerCase()
          .includes(normalizedCatalogSearch))
  )
  const unsupportedSelectedIds = checkIds.filter(
    (id) => !catalog.some((check) => check.id === id)
  )
  const missingSelectedSettings = catalog.some((check) => {
    if (!checkIds.includes(check.id)) return false
    if (check.parameterKind === 'approvedDomains')
      return !checkSettings['sharepoint-approved-partner-domains-v1']
        ?.approvedDomains.length
    if (check.parameterKind === 'approvedDomainGuids')
      return !checkSettings['onedrive-sync-approved-domain-guids-v1']
        ?.approvedDomainGuids.length
    if (check.parameterKind === 'requiredDomains')
      return !checkSettings['m365-required-verified-domains-v1']
        ?.requiredDomains.length
    if (check.parameterKind === 'minimumDays') {
      const days =
        checkSettings['onedrive-deleted-user-retention-minimum-v1']?.minimumDays
      return !Number.isInteger(days) || (days ?? 0) < 30 || (days ?? 0) > 3650
    }
    return false
  })
  return (
    <div className="space-y-5 pb-8">
      <header className="relative overflow-hidden rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-cyan-50 p-5 dark:border-indigo-900 dark:from-indigo-950/60 dark:via-slate-900 dark:to-cyan-950/40 sm:p-6">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-12 -top-20 h-52 w-52 rounded-full border-[24px] border-indigo-100/70 dark:border-indigo-900/30"
        />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <span
              aria-hidden="true"
              className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 to-cyan-600 text-white shadow-lg shadow-indigo-200/70 dark:shadow-none"
            >
              <ShieldCheck size={28} strokeWidth={1.8} />
            </span>
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.15em] text-indigo-700 dark:text-indigo-200">
                Policies / Baseline
              </p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 dark:text-white">
                {baselineId && detail
                  ? detail.baseline.name
                  : 'Baseline library'}
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300">
                Define the minimum settings your MSP expects. HawkView
                recommends checks; your team chooses and applies them.
                Assessments read stored evidence and never change Microsoft
                settings.
              </p>
            </div>
          </div>
          {workspaces.length > 1 && (
            <label className="text-sm">
              MSP workspace{' '}
              <select
                className={field + ' ml-2'}
                value={workspace.id}
                onChange={(event) => {
                  setLibrary(null)
                  setDetail(null)
                  setListPage(1)
                  navigate(null, event.target.value)
                }}
              >
                {workspaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </header>
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}{' '}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => {
              setError(null)
              void (baselineId ? loadDetail() : loadLibrary()).catch((caught) =>
                setError(errorText(caught))
              )
            }}
          >
            Retry
          </button>
        </div>
      )}
      {loading && (
        <p role="status" className="text-sm text-slate-500">
          Loading baseline data…
        </p>
      )}
      {!baselineId && library && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div
              className={
                panel +
                ' border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-900 dark:bg-indigo-950/25'
              }
            >
              <div className="flex items-center justify-between text-xs font-semibold uppercase text-indigo-700 dark:text-indigo-200">
                {listFilter ? 'Matching baselines' : 'Named baselines'}
                <Layers3 size={19} aria-hidden="true" />
              </div>
              <div className="mt-2 text-3xl font-bold text-indigo-950 dark:text-white">
                {library.total}
              </div>
            </div>
            <div
              className={
                panel +
                ' border-cyan-200 bg-cyan-50/60 p-4 dark:border-cyan-900 dark:bg-cyan-950/25'
              }
            >
              <div className="flex items-center justify-between text-xs font-semibold uppercase text-cyan-800 dark:text-cyan-200">
                Offered checks
                <ListChecks size={19} aria-hidden="true" />
              </div>
              <div className="mt-2 text-3xl font-bold text-cyan-950 dark:text-white">
                {library.catalog.length}
              </div>
            </div>
            <div
              className={
                panel +
                ' border-fuchsia-200 bg-fuchsia-50/50 p-4 dark:border-fuchsia-900 dark:bg-fuchsia-950/25 sm:col-span-2 xl:col-span-1'
              }
            >
              <div className="flex items-center justify-between text-xs font-semibold uppercase text-fuchsia-800 dark:text-fuchsia-200">
                Assessable categories
                <Grid2X2 size={19} aria-hidden="true" />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {services
                  .filter((category) =>
                    library.catalog.some((check) => check.service === category)
                  )
                  .map((category) => (
                    <span
                      key={category}
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${styleFor(category).pill}`}
                    >
                      {category}
                    </span>
                  ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Exchange threat policy and broader Microsoft 365 controls need
                additional evidence.
              </p>
            </div>
          </div>
          <section
            className={
              panel +
              ' flex flex-wrap items-start justify-between gap-4 border-indigo-200 bg-gradient-to-r from-indigo-50 via-white to-sky-50 p-5 dark:border-indigo-900 dark:from-indigo-950/35 dark:via-slate-900 dark:to-sky-950/25'
            }
            aria-label="HawkView starter template"
          >
            <div className="flex max-w-3xl items-start gap-4">
              <span
                aria-hidden="true"
                className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-md shadow-indigo-200 dark:shadow-none"
              >
                <Sparkles size={23} strokeWidth={1.8} />
              </span>
              <div>
                <p className="text-xs font-semibold uppercase text-blue-700 dark:text-blue-300">
                  Built-in template · not assigned automatically
                </p>
                <h2 className="mt-1 text-lg font-semibold">
                  {library.starter.name}
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                  {library.starter.description}
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  {library.starter.boundary}
                </p>
                <p className="mt-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                  {library.starter.checkIds.length} selected SharePoint checks.
                  Review, name, and assign a copy to each tenant you choose.
                </p>
              </div>
            </div>
            <button
              type="button"
              className={primary}
              onClick={() => start(true)}
            >
              Create from template
            </button>
          </section>
          <section className={panel} aria-label="Baseline library">
            <div className="flex flex-wrap justify-between gap-3 border-b border-slate-200 p-4 dark:border-slate-800">
              <form
                className="flex min-w-0 flex-1 gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  setListPage(1)
                  setListFilter(listSearch)
                }}
              >
                <label htmlFor="baseline-search" className="sr-only">
                  Search baselines
                </label>
                <input
                  id="baseline-search"
                  className={field + ' min-w-0 flex-1 sm:max-w-sm'}
                  placeholder="Search baselines"
                  value={listSearch}
                  onChange={(event) => setListSearch(event.target.value)}
                />
                <button className={secondary}>Search</button>
              </form>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={primary}
                  onClick={() => start(false)}
                >
                  Create baseline
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-950">
                  <tr>
                    <th className="px-4 py-3">Baseline</th>
                    <th className="px-4 py-3">Services</th>
                    <th className="px-4 py-3">Required checks</th>
                    <th className="px-4 py-3">Applied tenants</th>
                    <th className="px-4 py-3">Version · Updated</th>
                    <th className="px-4 py-3">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {library.items.map((item) => (
                    <tr
                      key={item.id}
                      className="hover:bg-slate-50 dark:hover:bg-slate-800/50"
                    >
                      <td className="px-4 py-4 font-semibold">
                        <button
                          type="button"
                          className="text-left text-blue-700 hover:underline dark:text-blue-300"
                          onClick={() => navigate(item.id)}
                        >
                          {item.name}
                        </button>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-wrap gap-1.5">
                          {Array.from(
                            new Set(
                              item.checkIds
                                .map((id) =>
                                  catalog.find((check) => check.id === id)
                                )
                                .filter((check): check is Check =>
                                  Boolean(check)
                                )
                                .map(service)
                            )
                          ).map((category) => (
                            <ServicePill key={category} name={category} />
                          ))}
                          {!item.checkIds.some((id) =>
                            catalog.some((check) => check.id === id)
                          ) && (
                            <span className="text-slate-500">
                              Unsupported checks
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-4">{item.checkIds.length}</td>
                      <td className="px-4 py-4">{item.assignedTenantCount}</td>
                      <td className="px-4 py-4">
                        v{item.revision} · {formatDate(item.updatedAt)}
                      </td>
                      <td className="px-4 py-4">
                        <button
                          type="button"
                          className="text-blue-700 hover:underline dark:text-blue-300"
                          onClick={() => navigate(item.id)}
                        >
                          Overview →
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!library.items.length && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-10 text-center text-slate-500"
                      >
                        {listFilter
                          ? 'No baselines match this search.'
                          : 'No baselines yet. Create one from offered checks or HawkView’s starter.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <Pager
              page={library.page}
              total={library.total}
              size={library.pageSize}
              change={setListPage}
            />
          </section>
        </>
      )}
      {baselineId && detail && (
        <>
          <button
            type="button"
            className="inline-flex items-center gap-2 text-sm font-medium text-blue-700 hover:underline dark:text-blue-300"
            onClick={() => navigate(null)}
          >
            <ArrowLeft size={16} /> All baselines
          </button>
          <div className="grid gap-3 sm:grid-cols-3">
            <div
              className={
                panel +
                ' border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-900 dark:bg-indigo-950/25'
              }
            >
              <div className="flex items-center justify-between text-xs font-semibold uppercase text-indigo-700 dark:text-indigo-200">
                Required checks
                <ListChecks size={19} aria-hidden="true" />
              </div>
              <div className="mt-2 text-2xl font-bold">
                {detail.baseline.checkIds.length}
              </div>
            </div>
            <div
              className={
                panel +
                ' border-teal-200 bg-teal-50/60 p-4 dark:border-teal-900 dark:bg-teal-950/25'
              }
            >
              <div className="flex items-center justify-between text-xs font-semibold uppercase text-teal-700 dark:text-teal-200">
                Applied tenants
                <Building2 size={19} aria-hidden="true" />
              </div>
              <div className="mt-2 text-2xl font-bold">
                {detail.baseline.assignedTenantCount}
              </div>
            </div>
            <div
              className={
                panel +
                ' border-fuchsia-200 bg-fuchsia-50/50 p-4 dark:border-fuchsia-900 dark:bg-fuchsia-950/25'
              }
            >
              <div className="flex items-center justify-between text-xs font-semibold uppercase text-fuchsia-700 dark:text-fuchsia-200">
                Current version
                <Layers3 size={19} aria-hidden="true" />
              </div>
              <div className="mt-2 font-medium">
                v{detail.baseline.revision} ·{' '}
                {formatDate(detail.baseline.updatedAt)}
              </div>
            </div>
          </div>
          <section className={panel + ' p-5'}>
            <div className="flex flex-wrap justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Overview</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Edits to this standard affect every assigned tenant.
                </p>
              </div>
              <button type="button" className={secondary} onClick={edit}>
                Edit requirements
              </button>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {Array.from(
                new Set([...services, ...detail.checks.map(service)])
              ).map((category) => {
                const checks = detail.checks.filter(
                  (check) => service(check) === category
                )
                return (
                  <div
                    key={category}
                    className={`rounded-xl border p-4 ${styleFor(category).card}`}
                  >
                    <div className="flex items-center gap-3">
                      <ServiceMark name={category} />
                      <h3 className="min-w-0 flex-1 font-semibold">
                        {category}
                      </h3>
                      <span className="rounded-full bg-white/80 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-900/70 dark:text-slate-200">
                        {checks.length}{' '}
                        {checks.length === 1 ? 'check' : 'checks'}
                      </span>
                    </div>
                    {checks.length ? (
                      <ul className="mt-4 space-y-2 text-sm">
                        {checks.map((check) => (
                          <li key={check.id} className="flex items-start gap-2">
                            <span
                              aria-hidden="true"
                              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-50"
                            />
                            {check.title}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-3 text-sm text-slate-500">
                        {category === 'Exchange'
                          ? 'No evidence-backed minimum-setting check is offered yet.'
                          : 'No checks selected.'}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
          <section className={panel + ' p-5'}>
            <h2 className="text-lg font-semibold">Required settings</h2>
            <p className="mt-1 text-sm text-slate-500">
              Missing or stale evidence is “Unable to assess,” never a pass.
            </p>
            <div className="mt-4 space-y-3">
              {detail.checks.map((check) => (
                <article
                  key={check.id}
                  className={`rounded-lg border border-l-4 border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900 ${styleFor(service(check)).accent}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <ServicePill name={service(check)} />
                    <h3 className="font-semibold">{check.title}</h3>
                  </div>
                  <p className="mt-2 text-sm">
                    Minimum expected: {check.expected}
                  </p>
                  {settingSummary(
                    check,
                    detail.baseline.checkSettings ?? {}
                  ) && (
                    <p className="mt-1 text-sm font-medium text-blue-800 dark:text-blue-200">
                      MSP choice:{' '}
                      {settingSummary(
                        check,
                        detail.baseline.checkSettings ?? {}
                      )}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-slate-500">
                    Evidence: {check.source}. {check.guidance}
                  </p>
                </article>
              ))}
            </div>
          </section>
          <section className={panel + ' p-5'} aria-label="Baseline versions">
            <h2 className="font-semibold">Version history</h2>
            <p className="mt-1 text-sm text-slate-500">
              Each save records a definition version. The current version
              applies to all assigned tenants.
            </p>
            <ol className="mt-3 space-y-2 text-sm">
              {detail.revisions.map((revision) => (
                <li
                  key={revision.revision}
                  className="rounded border border-slate-200 px-3 py-2 dark:border-slate-700"
                >
                  <details>
                    <summary className="cursor-pointer font-medium">
                      v{revision.revision} · {formatDate(revision.createdAt)} ·{' '}
                      {revision.checkIds.length} checks
                    </summary>
                    <p className="mt-2 text-slate-500">{revision.name}</p>
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {revision.checkIds.map((id) => {
                        const check = catalog.find((item) => item.id === id)
                        return (
                          <li key={id}>
                            {check?.title ?? `Retired check: ${id}`}
                            {check &&
                            settingSummary(check, revision.checkSettings)
                              ? ` · ${settingSummary(check, revision.checkSettings)}`
                              : ''}
                          </li>
                        )
                      })}
                    </ul>
                  </details>
                </li>
              ))}
            </ol>
          </section>
          <section className={panel} aria-label="Applied tenants">
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <h2 className="text-lg font-semibold">
                  Applied tenants ({detail.baseline.assignedTenantCount})
                </h2>
                <p className="text-sm text-slate-500">
                  Search assignments; assess one tenant’s stored evidence on
                  demand.
                </p>
              </div>
              <button
                type="button"
                className={primary}
                onClick={() => {
                  setError(null)
                  setChoices(null)
                  setAssignOpen(true)
                  setChoicePage(1)
                }}
              >
                Apply to tenant
              </button>
            </div>
            <form
              className="flex gap-2 border-t border-slate-200 p-4 dark:border-slate-800"
              onSubmit={(event) => {
                event.preventDefault()
                setAssignedPage(1)
                setAssignedFilter(assignedSearch)
              }}
            >
              <label htmlFor="assigned-search" className="sr-only">
                Search applied tenants
              </label>
              <input
                id="assigned-search"
                className={field + ' min-w-0 flex-1 sm:max-w-sm'}
                placeholder="Search name or domain"
                value={assignedSearch}
                onChange={(event) => setAssignedSearch(event.target.value)}
              />
              <button className={secondary}>Search</button>
            </form>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[540px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-950">
                  <tr>
                    <th className="px-4 py-3">Tenant</th>
                    <th className="px-4 py-3">Domain</th>
                    <th className="px-4 py-3">Applied</th>
                    <th className="px-4 py-3">Assessment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {detail.assignments.map((item) => (
                    <tr key={item.tenantId}>
                      <td className="px-4 py-3 font-medium">{item.name}</td>
                      <td className="px-4 py-3">
                        {item.domain ?? 'Not reported'}
                      </td>
                      <td className="px-4 py-3">
                        {formatDate(item.assignedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <a
                          className="text-blue-700 hover:underline dark:text-blue-300"
                          href={`/policies/baselines/assess?tenant=${encodeURIComponent(item.tenantId)}&workspace=${encodeURIComponent(workspace.id)}`}
                        >
                          Assess →
                        </a>
                      </td>
                    </tr>
                  ))}
                  {!detail.assignments.length && (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-4 py-8 text-center text-slate-500"
                      >
                        {assignedFilter
                          ? 'No assigned tenants match.'
                          : 'No tenants assigned yet.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <Pager
              page={detail.page}
              total={detail.matchingTenants}
              size={detail.pageSize}
              change={setAssignedPage}
            />
          </section>
        </>
      )}
      {formOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
          role="presentation"
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="baseline-form"
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-slate-900"
          >
            <h2 id="baseline-form" className="text-xl font-semibold">
              {editing ? 'Edit baseline' : 'Create baseline'}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Choose the minimum settings your MSP expects. HawkView Essentials
              is a starting template, not a complete Microsoft 365 assessment.
            </p>
            <nav
              aria-label="Baseline creation steps"
              className="mt-5 flex flex-wrap gap-2 text-sm"
            >
              <span
                aria-current={formStep === 'requirements' ? 'step' : undefined}
                className={`rounded-full px-3 py-1.5 ${formStep === 'requirements' ? 'bg-blue-600 font-semibold text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}
              >
                1 · Requirements
              </span>
              <span
                aria-current={formStep === 'review' ? 'step' : undefined}
                className={`rounded-full px-3 py-1.5 ${formStep === 'review' ? 'bg-blue-600 font-semibold text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}
              >
                2 · Review
              </span>
              {!editing && (
                <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  3 · Apply to tenants
                </span>
              )}
            </nav>
            <p className="mt-2 text-sm text-slate-500">
              {checkIds.length} required settings selected from {catalog.length}{' '}
              available checks. This is your chosen standard, not a tenant
              security score.
            </p>
            {editing && (
              <p className="mt-2 text-sm font-medium text-amber-700">
                Saving creates version{' '}
                {detail ? detail.baseline.revision + 1 : ''} and changes the
                assessment for {detail?.baseline.assignedTenantCount ?? 0}{' '}
                assigned tenants.
              </p>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-700">
                {error}
              </p>
            )}
            <label
              htmlFor="baseline-name"
              className="mt-5 block text-sm font-medium"
            >
              Name
            </label>
            <input
              id="baseline-name"
              className={field + ' mt-1 w-full'}
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Standard customer baseline"
            />
            {unsupportedSelectedIds.length > 0 && (
              <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                <p className="font-semibold">
                  This baseline contains {unsupportedSelectedIds.length} retired
                  requirement{unsupportedSelectedIds.length === 1 ? '' : 's'}.
                </p>
                <p className="mt-1">
                  Remove each retired requirement and choose a currently offered
                  check before saving. Nothing changes for assigned tenants
                  until you save.
                </p>
                <ul className="mt-3 space-y-2">
                  {unsupportedSelectedIds.map((id) => (
                    <li
                      key={id}
                      className="flex flex-wrap items-center justify-between gap-2"
                    >
                      <code className="break-all text-xs">{id}</code>
                      <button
                        type="button"
                        className="rounded border border-amber-500 px-2 py-1 font-medium"
                        onClick={() =>
                          setCheckIds((current) =>
                            current.filter((item) => item !== id)
                          )
                        }
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {formStep === 'requirements' && (
              <div className="mt-5 space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-56 flex-1">
                    <label
                      htmlFor="catalog-search"
                      className="block text-sm font-medium"
                    >
                      Find a requirement
                    </label>
                    <input
                      id="catalog-search"
                      type="search"
                      className={field + ' mt-1 w-full'}
                      value={catalogSearch}
                      onChange={(event) => setCatalogSearch(event.target.value)}
                      placeholder="Search settings or expected values"
                    />
                  </div>
                  <button
                    type="button"
                    aria-pressed={selectedOnly}
                    className={`${secondary} ${selectedOnly ? 'border-blue-600 bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200' : ''}`}
                    onClick={() => setSelectedOnly((current) => !current)}
                  >
                    Selected only ({checkIds.length})
                  </button>
                </div>
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label="Filter requirements by service"
                >
                  {['All', ...catalogServices].map((category) => (
                    <button
                      key={category}
                      type="button"
                      aria-pressed={catalogService === category}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium ${
                        catalogService === category
                          ? 'border-blue-600 bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200'
                          : 'border-slate-200 text-slate-600 hover:border-blue-300 dark:border-slate-700 dark:text-slate-300'
                      }`}
                      onClick={() => setCatalogService(category)}
                    >
                      {category !== 'All' && (
                        <ServiceMark name={category} small />
                      )}
                      {category}{' '}
                      {category === 'All'
                        ? catalog.length
                        : catalog.filter((check) => service(check) === category)
                            .length}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-500" role="status">
                  Showing {visibleChecks.length} of {catalog.length} available
                  checks. Filters only change this list; they do not change your
                  selection.
                </p>
                {visibleChecks.length === 0 && (
                  <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-slate-700">
                    {catalogService !== 'All' &&
                    !catalog.some((check) => service(check) === catalogService)
                      ? 'No assessable minimum-setting check is offered for this service yet.'
                      : 'No checks match these filters. Clear the search or show all checks.'}
                  </p>
                )}
                {(catalogService === 'All'
                  ? catalogServices
                  : [catalogService]
                ).map((category) => {
                  const checks = visibleChecks.filter(
                    (check) => service(check) === category
                  )
                  if (!checks.length) return null
                  return (
                    <fieldset
                      key={category}
                      className={`rounded-xl border p-4 ${styleFor(category).card}`}
                    >
                      <legend className="px-1 font-semibold">{category}</legend>
                      {checks.map((check) => (
                        <div
                          key={check.id}
                          className="mt-3 rounded-lg border border-white bg-white/90 p-3 dark:border-slate-700 dark:bg-slate-900/90"
                        >
                          <label className="flex cursor-pointer gap-3 text-sm">
                            <input
                              type="checkbox"
                              checked={checkIds.includes(check.id)}
                              onChange={(event) =>
                                setCheckIds((current) =>
                                  event.target.checked
                                    ? [
                                        ...current.filter(
                                          (id) =>
                                            !check.choiceGroup ||
                                            catalog.find(
                                              (candidate) => candidate.id === id
                                            )?.choiceGroup !== check.choiceGroup
                                        ),
                                        check.id,
                                      ]
                                    : current.filter((id) => id !== check.id)
                                )
                              }
                            />
                            <span>
                              <span className="block font-medium">
                                {check.title}{' '}
                                {recommendedIds.includes(check.id) && (
                                  <span className="ml-1 text-xs font-semibold text-blue-700 dark:text-blue-300">
                                    HawkView starter
                                  </span>
                                )}
                                {check.recommendation === 'STRICT_OPTION' && (
                                  <span className="ml-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
                                    Stricter option
                                  </span>
                                )}
                              </span>
                              <span className="block text-slate-500">
                                {check.expected}
                              </span>
                            </span>
                          </label>
                          {checkIds.includes(check.id) &&
                            check.parameterKind === 'approvedDomains' && (
                              <label className="mt-3 block pl-7 text-sm font-medium">
                                Approved partner domains · one per line
                                <textarea
                                  className={field + ' mt-1 w-full font-mono'}
                                  rows={3}
                                  maxLength={10000}
                                  value={partnerDomainDraft}
                                  onChange={(event) => {
                                    setPartnerDomainDraft(event.target.value)
                                    setCheckSettings((current) => ({
                                      ...current,
                                      'sharepoint-approved-partner-domains-v1':
                                        {
                                          approvedDomains: parseListText(
                                            event.target.value
                                          ),
                                        },
                                    }))
                                  }}
                                  placeholder={'example.com\npartner.org'}
                                />
                              </label>
                            )}
                          {checkIds.includes(check.id) &&
                            check.parameterKind === 'approvedDomainGuids' && (
                              <label className="mt-3 block pl-7 text-sm font-medium">
                                Approved Microsoft domain GUIDs · one per line
                                <textarea
                                  className={field + ' mt-1 w-full font-mono'}
                                  rows={3}
                                  maxLength={10000}
                                  value={syncGuidDraft}
                                  onChange={(event) => {
                                    setSyncGuidDraft(event.target.value)
                                    setCheckSettings((current) => ({
                                      ...current,
                                      'onedrive-sync-approved-domain-guids-v1':
                                        {
                                          approvedDomainGuids: parseListText(
                                            event.target.value
                                          ),
                                        },
                                    }))
                                  }}
                                  placeholder="00000000-0000-0000-0000-000000000000"
                                />
                              </label>
                            )}
                          {checkIds.includes(check.id) &&
                            check.parameterKind === 'minimumDays' && (
                              <label className="mt-3 block pl-7 text-sm font-medium">
                                Minimum deleted-user OneDrive retention · days
                                <input
                                  type="number"
                                  min={30}
                                  max={3650}
                                  step={1}
                                  className={field + ' mt-1 block w-40'}
                                  value={
                                    checkSettings[
                                      'onedrive-deleted-user-retention-minimum-v1'
                                    ]?.minimumDays ?? ''
                                  }
                                  onChange={(event) =>
                                    setCheckSettings((current) => ({
                                      ...current,
                                      'onedrive-deleted-user-retention-minimum-v1':
                                        {
                                          minimumDays: Number(
                                            event.target.value
                                          ),
                                        },
                                    }))
                                  }
                                />
                                <span className="mt-1 block text-xs font-normal text-slate-500">
                                  Microsoft accepts 30–3650 days. This is a
                                  tenant setting, not a Purview retention
                                  guarantee.
                                </span>
                              </label>
                            )}
                          {checkIds.includes(check.id) &&
                            check.parameterKind === 'requiredDomains' && (
                              <label className="mt-3 block pl-7 text-sm font-medium">
                                Required Microsoft verified domains · one per
                                line
                                <textarea
                                  className={field + ' mt-1 w-full font-mono'}
                                  rows={3}
                                  maxLength={10000}
                                  value={requiredDomainDraft}
                                  onChange={(event) => {
                                    setRequiredDomainDraft(event.target.value)
                                    setCheckSettings((current) => ({
                                      ...current,
                                      'm365-required-verified-domains-v1': {
                                        requiredDomains: parseListText(
                                          event.target.value
                                        ),
                                      },
                                    }))
                                  }}
                                  placeholder={
                                    'customer.example\nbrand.example'
                                  }
                                />
                                <span className="mt-1 block text-xs font-normal text-slate-500">
                                  This checks Microsoft&apos;s verified-domain
                                  inventory, not SPF, DKIM, DMARC, or Exchange
                                  accepted-domain type.
                                </span>
                              </label>
                            )}
                        </div>
                      ))}
                    </fieldset>
                  )
                })}
              </div>
            )}
            {formStep === 'review' && (
              <div
                className="mt-5 space-y-4"
                aria-label="Review baseline before saving"
              >
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
                  <p className="font-semibold">Read-only assessment</p>
                  <p className="mt-1">
                    This baseline compares stored tenant evidence with your
                    chosen requirements. It does not change Microsoft settings,
                    send alerts, or create tickets. Missing or stale evidence
                    will be shown as unable to assess.
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 p-4 text-sm dark:border-slate-700">
                  <p>
                    <span className="font-semibold">Name:</span> {name.trim()}
                  </p>
                  <p className="mt-1">
                    <span className="font-semibold">Requirements:</span>{' '}
                    {checkIds.length}
                  </p>
                  <p className="mt-1">
                    <span className="font-semibold">Tenant scope:</span>{' '}
                    {editing
                      ? `${detail?.baseline.assignedTenantCount ?? 0} currently assigned; changes will affect them when saved.`
                      : 'No tenants assigned yet. Choose tenants after saving.'}
                  </p>
                </div>
                {catalogServices.map((category) => {
                  const selected = catalog.filter(
                    (check) =>
                      service(check) === category && checkIds.includes(check.id)
                  )
                  if (!selected.length) return null
                  return (
                    <section
                      key={category}
                      className={`rounded-xl border p-4 ${styleFor(category).card}`}
                    >
                      <div className="flex items-center gap-3">
                        <ServiceMark name={category} small />
                        <h3 className="font-semibold">
                          {category} · {selected.length}
                        </h3>
                      </div>
                      <ul className="mt-3 space-y-3">
                        {selected.map((check) => (
                          <li key={check.id} className="text-sm">
                            <p className="font-medium">{check.title}</p>
                            <p className="text-slate-600 dark:text-slate-300">
                              Minimum: {check.expected}
                            </p>
                            {settingSummary(check, checkSettings) && (
                              <p className="font-medium text-blue-800 dark:text-blue-200">
                                Your choice:{' '}
                                {settingSummary(check, checkSettings)}
                              </p>
                            )}
                            <p className="text-xs text-slate-500">
                              Evidence: {check.source}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )
                })}
              </div>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                className={secondary}
                onClick={() =>
                  formStep === 'review'
                    ? setFormStep('requirements')
                    : setFormOpen(false)
                }
              >
                {formStep === 'review' ? 'Back to requirements' : 'Cancel'}
              </button>
              <button
                type="button"
                className={primary}
                disabled={
                  busy ||
                  name.trim().length < 2 ||
                  !checkIds.length ||
                  unsupportedSelectedIds.length > 0 ||
                  missingSelectedSettings
                }
                onClick={() =>
                  formStep === 'requirements'
                    ? setFormStep('review')
                    : void save()
                }
              >
                {formStep === 'requirements'
                  ? 'Review baseline'
                  : busy
                    ? 'Saving…'
                    : editing
                      ? 'Save changes'
                      : 'Save and choose tenants'}
              </button>
            </div>
          </section>
        </div>
      )}
      {assignOpen && baselineId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
          role="presentation"
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="assign-title"
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-slate-900"
          >
            <div className="flex justify-between gap-3">
              <div>
                <h2 id="assign-title" className="text-xl font-semibold">
                  Apply baseline to tenants
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  One baseline per tenant. Replacing another changes that
                  tenant’s standard.
                </p>
              </div>
              <button
                type="button"
                className={secondary}
                onClick={() => setAssignOpen(false)}
              >
                Close
              </button>
            </div>
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-700">
                {error}
              </p>
            )}
            <form
              className="mt-4 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                setChoicePage(1)
                setChoiceFilter(choiceSearch)
              }}
            >
              <label htmlFor="choice-search" className="sr-only">
                Search tenants
              </label>
              <input
                id="choice-search"
                className={field + ' min-w-0 flex-1'}
                placeholder="Search tenant name or domain"
                value={choiceSearch}
                onChange={(event) => setChoiceSearch(event.target.value)}
              />
              <button className={secondary}>Search</button>
            </form>
            <div className="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
              {choices?.items.map((tenant) => (
                <div
                  key={tenant.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                >
                  <div>
                    <div className="font-medium">
                      {tenant.displayName ||
                        tenant.primaryDomain ||
                        'Unnamed tenant'}
                    </div>
                    <div className="text-xs text-slate-500">
                      {tenant.primaryDomain ?? 'Domain not reported'} ·{' '}
                      {tenant.baselineId === baselineId
                        ? 'Already applied'
                        : tenant.baselineId
                          ? 'Another baseline assigned'
                          : 'No baseline'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={secondary}
                    disabled={busy || tenant.baselineId === baselineId}
                    onClick={() => void apply(tenant.id)}
                  >
                    {tenant.baselineId === baselineId
                      ? 'Applied'
                      : tenant.baselineId
                        ? 'Replace'
                        : 'Apply'}
                  </button>
                </div>
              ))}
              {choices && !choices.items.length && (
                <p className="p-6 text-center text-sm text-slate-500">
                  No tenants match this search.
                </p>
              )}
            </div>
            {choices && (
              <Pager
                page={choices.page}
                total={choices.total}
                size={choices.pageSize}
                change={setChoicePage}
              />
            )}
          </section>
        </div>
      )}
    </div>
  )
}
