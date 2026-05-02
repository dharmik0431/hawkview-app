'use client'

import { useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ShieldCheck, Search, Settings2, ChevronRight } from 'lucide-react'

type CaPolicyOrigin = 'MICROSOFT_TEMPLATE' | 'MICROSOFT_ENFORCED' | 'CUSTOM'
type CaPolicyState = 'ON' | 'REPORT_ONLY' | 'OFF'

export type CaPolicy = {
  id: string
  name: string
  targetSummary: string
  grantSummary: string
  origin: CaPolicyOrigin
  state: CaPolicyState
}

const ORIGIN_LABEL: Record<CaPolicyOrigin, string> = {
  MICROSOFT_TEMPLATE: 'Microsoft template',
  MICROSOFT_ENFORCED: 'Microsoft enforced',
  CUSTOM: 'Custom',
}

function StatePill({ state }: { state: CaPolicyState }) {
  const cls =
    state === 'ON'
      ? 'bg-green-50 text-green-700 border border-green-200'
      : state === 'REPORT_ONLY'
        ? 'bg-orange-50 text-orange-700 border border-orange-200'
        : 'bg-slate-50 text-slate-700 border border-slate-200'
  return (
    <Badge className={`${cls} uppercase tracking-wide`}>
      {state === 'REPORT_ONLY' ? 'Report-only' : state}
    </Badge>
  )
}

function OriginPill({ origin }: { origin: CaPolicyOrigin }) {
  return (
    <Badge className="bg-slate-50 text-slate-700 border border-slate-200">
      {ORIGIN_LABEL[origin]}
    </Badge>
  )
}

function accentBar(p: CaPolicy) {
  if (p.state === 'OFF') return 'bg-slate-300'
  if (p.grantSummary.toLowerCase().includes('block')) return 'bg-red-500'
  if (p.state === 'REPORT_ONLY') return 'bg-orange-500'
  return 'bg-green-500'
}

export default function EntraSection({
  policies,
  onPolicyClick,
}: {
  policies: CaPolicy[]
  onPolicyClick: (p: CaPolicy) => void
}) {
  const [query, setQuery] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)

  const [originFilter, setOriginFilter] = useState<
    Record<CaPolicyOrigin, boolean>
  >({
    MICROSOFT_TEMPLATE: true,
    CUSTOM: true,
    MICROSOFT_ENFORCED: true,
  })

  const [stateFilter, setStateFilter] = useState<
    Record<CaPolicyState, boolean>
  >({
    ON: true,
    REPORT_ONLY: true,
    OFF: false,
  })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return policies.filter((p) => {
      const matchesText =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.targetSummary.toLowerCase().includes(q) ||
        p.grantSummary.toLowerCase().includes(q)

      const matchesOrigin = originFilter[p.origin]
      const matchesState = stateFilter[p.state]
      return matchesText && matchesOrigin && matchesState
    })
  }, [policies, query, originFilter, stateFilter])

  return (
    <Card className="rounded-2xl mt-5 shadow-sm bg-white dark:bg-slate-900">
      <CardContent className="p-0">
        <div className="px-6 pt-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-muted/20 border">
                <ShieldCheck className="h-5 w-5 text-slate-700 dark:text-slate-200" />
              </div>
              <div>
                <div className="text-[15px] font-semibold text-slate-900 dark:text-white">
                  Conditional Access Policies
                </div>
                <div className="text-sm text-muted-foreground">
                  Manage access control logic for your tenant
                </div>
              </div>
            </div>

            <div className="text-sm text-muted-foreground">
              Showing{' '}
              <span className="font-semibold text-slate-900 dark:text-white">
                {filtered.length}
              </span>{' '}
              / {policies.length}
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search policies..."
                className="pl-10"
              />
            </div>

            <div className="relative" data-ca-filters>
              <button
                onClick={() => setFiltersOpen((v) => !v)}
                className="inline-flex items-center gap-2 rounded-xl border bg-white dark:bg-slate-900 px-3 py-2 text-sm font-semibold shadow-sm hover:shadow-md transition"
                title="Filters"
              >
                <Settings2 className="h-4 w-4" />
                Filters
                <Badge className="bg-slate-50 text-slate-700 border border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700">
                  {Object.values(originFilter).filter(Boolean).length +
                    Object.values(stateFilter).filter(Boolean).length}
                </Badge>
              </button>

              {filtersOpen && (
                <div className="absolute right-0 mt-2 w-[320px] rounded-2xl border bg-white dark:bg-slate-900 shadow-lg p-4 z-20">
                  <div className="text-xs font-semibold text-muted-foreground tracking-wide">
                    ORIGIN
                  </div>

                  <div className="mt-2 space-y-2">
                    {(Object.keys(originFilter) as CaPolicyOrigin[]).map(
                      (k) => (
                        <label
                          key={k}
                          className="flex items-center gap-2 text-sm text-slate-900 dark:text-slate-100"
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-slate-300"
                            checked={originFilter[k]}
                            onChange={(e) =>
                              setOriginFilter((p) => ({
                                ...p,
                                [k]: e.target.checked,
                              }))
                            }
                          />
                          {ORIGIN_LABEL[k]}
                        </label>
                      )
                    )}
                  </div>

                  <div className="mt-4 text-xs font-semibold text-muted-foreground tracking-wide">
                    STATUS
                  </div>
                  <div className="mt-2 space-y-2">
                    {(['ON', 'REPORT_ONLY', 'OFF'] as CaPolicyState[]).map(
                      (k) => (
                        <label
                          key={k}
                          className="flex items-center gap-2 text-sm text-slate-900 dark:text-slate-100"
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-slate-300"
                            checked={stateFilter[k]}
                            onChange={(e) =>
                              setStateFilter((p) => ({
                                ...p,
                                [k]: e.target.checked,
                              }))
                            }
                          />
                          {k === 'REPORT_ONLY' ? 'Report-only' : k}
                        </label>
                      )
                    )}
                  </div>

                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => {
                        setQuery('')
                        setOriginFilter({
                          MICROSOFT_TEMPLATE: true,
                          CUSTOM: true,
                          MICROSOFT_ENFORCED: true,
                        })
                        setStateFilter({
                          ON: true,
                          REPORT_ONLY: true,
                          OFF: false,
                        })
                        setFiltersOpen(false)
                      }}
                    >
                      Reset
                    </Button>
                    <Button
                      className="w-full"
                      onClick={() => setFiltersOpen(false)}
                    >
                      Done
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 border-t">
          <div
            className="divide-y bg-white dark:bg-slate-900"
            style={{ maxHeight: 320, overflow: 'auto' }}
          >
            {filtered.length === 0 ? (
              <div className="px-6 py-8 text-sm text-muted-foreground">
                No policies match your search/filters.
              </div>
            ) : (
              filtered.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onPolicyClick(p)}
                  className="w-full text-left px-6 py-4 hover:bg-muted/30 transition flex items-center gap-4"
                >
                  <div className={`h-10 w-1.5 rounded-full ${accentBar(p)}`} />

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                      {p.name}
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span>Target:</span>
                      <span className="text-slate-700 dark:text-slate-200">
                        {p.targetSummary}
                      </span>
                      <span className="text-slate-300">•</span>
                      <span>Grant:</span>
                      <span
                        className={
                          p.grantSummary.toLowerCase().includes('block')
                            ? 'text-red-700 font-semibold'
                            : 'text-green-700 font-semibold'
                        }
                      >
                        {p.grantSummary}
                      </span>
                    </div>

                    <div className="mt-2 flex items-center gap-2">
                      <OriginPill origin={p.origin} />
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <StatePill state={p.state} />
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
