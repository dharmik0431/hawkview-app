'use client'

import * as React from 'react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ChangeCategory, ChangeSeverity } from '../data/change-types'

const CATEGORIES: ChangeCategory[] = [
  'Roles',
  'MFA',
  'Conditional Access',
  'Apps',
  'Licenses',
  'Users',
  'Groups',
  'Devices',
]

const SEVERITIES: ChangeSeverity[] = ['High', 'Medium', 'Low']

export type WhatChangedFiltersState = {
  tenant: string // "all" or tenantId
  severity: 'All' | ChangeSeverity
  categories: ChangeCategory[]
  search: string
}

export function WhatChangedFilters({
  tenants,
  value,
  onChange,
}: {
  tenants: { id: string; name: string }[]
  value: WhatChangedFiltersState
  onChange: (next: WhatChangedFiltersState) => void
}) {
  const [showMore, setShowMore] = React.useState(false)

  return (
    <div className="flex flex-col gap-3">
      {/* Row 1: clean + breathable */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={value.tenant}
          onChange={(e) => onChange({ ...value, tenant: e.target.value })}
        >
          <option value="all">All tenants</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>

        <div className="flex-1 min-w-[240px]">
          <Input
            placeholder="Search user, policy, app…"
            value={value.search}
            onChange={(e) => onChange({ ...value, search: e.target.value })}
          />
        </div>

        <Button variant="secondary" onClick={() => setShowMore((v) => !v)}>
          {showMore ? 'Hide filters' : 'More filters'}
        </Button>

        <Button
          variant="ghost"
          onClick={() =>
            onChange({
              tenant: 'all',
              severity: 'All',
              categories: [],
              search: '',
            })
          }
        >
          Reset
        </Button>
      </div>

      {/* Row 2: advanced filters (collapsible) */}
      {showMore && (
        <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={value.severity}
              onChange={(e) =>
                onChange({ ...value, severity: e.target.value as any })
              }
            >
              <option value="All">All severities</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            <div className="text-xs text-muted-foreground">
              Tip: click chips to filter categories.
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {CATEGORIES.map((c) => {
              const active = value.categories.includes(c)
              return (
                <button
                  key={c}
                  onClick={() => {
                    const next = active
                      ? value.categories.filter((x) => x !== c)
                      : [...value.categories, c]
                    onChange({ ...value, categories: next })
                  }}
                >
                  <Badge
                    variant={active ? 'default' : 'secondary'}
                    className={active ? 'bg-blue-600 hover:bg-blue-600' : ''}
                  >
                    {c}
                  </Badge>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
