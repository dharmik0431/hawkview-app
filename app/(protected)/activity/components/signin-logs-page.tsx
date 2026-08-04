'use client'

import * as React from 'react'
import { ArrowUp, ArrowDown, ArrowUpDown, ChevronRight } from 'lucide-react'
import type { SignInEvent } from '../data/types'
import { SignInDrawer } from './signin-drawer'

function fmtUTC(iso: string) {
  const s = iso.includes('T') ? iso : new Date(iso).toISOString()
  return s.replace('T', ' ').replace('Z', '').slice(0, 19)
}

function StatusPill({ status }: { status: SignInEvent['status'] }) {
  if (status === 'Success') {
    return (
      <span className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800">
        Success
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-md bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700 border border-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-800">
      Failure
    </span>
  )
}

function compareIPs(ipA?: string, ipB?: string): number {
  if (!ipA && !ipB) return 0
  if (!ipA) return 1
  if (!ipB) return -1
  const partsA = ipA.split('.').map(Number)
  const partsB = ipB.split('.').map(Number)
  if (
    partsA.length === 4 &&
    partsB.length === 4 &&
    partsA.every((n) => !isNaN(n)) &&
    partsB.every((n) => !isNaN(n))
  ) {
    for (let i = 0; i < 4; i++) {
      if (partsA[i] !== partsB[i]) return partsA[i] - partsB[i]
    }
    return 0
  }
  return ipA.localeCompare(ipB, undefined, { sensitivity: 'base' })
}

export function SignInLogsPage({
  rows,
  sortField: externalSortField,
  sortOrder: externalSortOrder,
  onSort: externalOnSort,
}: {
  rows: SignInEvent[]
  sortField?: keyof SignInEvent
  sortOrder?: 'asc' | 'desc'
  onSort?: (field: keyof SignInEvent) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [selected, setSelected] = React.useState<SignInEvent | null>(null)

  const [internalSortField, setInternalSortField] =
    React.useState<keyof SignInEvent>('createdAt')
  const [internalSortOrder, setInternalSortOrder] = React.useState<
    'asc' | 'desc'
  >('desc')

  const sortField = externalSortField ?? internalSortField
  const sortOrder = externalSortOrder ?? internalSortOrder

  function handleSort(field: keyof SignInEvent) {
    if (externalOnSort) {
      externalOnSort(field)
    } else {
      if (internalSortField === field) {
        setInternalSortOrder(internalSortOrder === 'asc' ? 'desc' : 'asc')
      } else {
        setInternalSortField(field)
        setInternalSortOrder('asc')
      }
    }
  }

  const sortedRows = React.useMemo(() => {
    if (externalSortField !== undefined) {
      return rows
    }
    return [...rows].sort((a, b) => {
      let valA: any = a[sortField]
      let valB: any = b[sortField]

      if (sortField === 'userDisplayName') {
        valA = `${a.userDisplayName} ${a.userPrincipalName}`
        valB = `${b.userDisplayName} ${b.userPrincipalName}`
      }

      const isMissingA =
        valA === undefined || valA === null || valA === '' || valA === '—'
      const isMissingB =
        valB === undefined || valB === null || valB === '' || valB === '—'

      if (isMissingA && isMissingB) return 0
      if (isMissingA) return 1
      if (isMissingB) return -1

      let cmp = 0
      if (sortField === 'ipAddress') {
        cmp = compareIPs(String(valA), String(valB))
      } else if (sortField === 'createdAt') {
        const tA = new Date(String(valA)).getTime() || 0
        const tB = new Date(String(valB)).getTime() || 0
        cmp = tA - tB
      } else {
        cmp = String(valA).localeCompare(String(valB), undefined, {
          sensitivity: 'base',
          numeric: true,
        })
      }

      return sortOrder === 'asc' ? cmp : -cmp
    })
  }, [rows, externalSortField, sortField, sortOrder])

  function onRowClick(r: SignInEvent) {
    setSelected(r)
    setOpen(true)
  }

  function renderSortHeader(
    field: keyof SignInEvent,
    label: string,
    className?: string
  ) {
    const isActive = sortField === field
    const ariaSort = isActive
      ? sortOrder === 'asc'
        ? 'ascending'
        : 'descending'
      : 'none'

    return (
      <th
        scope="col"
        aria-sort={ariaSort}
        className={[
          'px-4 py-3 text-left font-medium text-xs uppercase tracking-wider select-none',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <button
          type="button"
          onClick={() => handleSort(field)}
          className="inline-flex items-center gap-1.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1 -mx-1 py-0.5 group cursor-pointer"
          title={`Sort by ${label}`}
        >
          <span>{label}</span>
          {isActive ? (
            sortOrder === 'asc' ? (
              <ArrowUp className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
            ) : (
              <ArrowDown className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
            )
          ) : (
            <ArrowUpDown className="h-3.5 w-3.5 opacity-0 group-hover:opacity-40 transition-opacity shrink-0" />
          )}
        </button>
      </th>
    )
  }

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between px-1 text-xs text-slate-500 dark:text-slate-400">
          <div>
            Showing{' '}
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {sortedRows.length}
            </span>{' '}
            sign-in event{sortedRows.length === 1 ? '' : 's'}
          </div>
        </div>

        <div className="rounded-lg border bg-background overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-slate-50/80 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 text-muted-foreground">
                <tr>
                  {renderSortHeader('createdAt', 'Date', 'min-w-[150px]')}
                  {renderSortHeader('userDisplayName', 'User', 'min-w-[220px]')}
                  {renderSortHeader(
                    'appDisplayName',
                    'Application',
                    'min-w-[170px]'
                  )}
                  {renderSortHeader('status', 'Status', 'min-w-[110px]')}
                  {renderSortHeader(
                    'conditionalAccess',
                    'Conditional Access',
                    'min-w-[150px]'
                  )}
                  {renderSortHeader('ipAddress', 'IP Address', 'min-w-[130px]')}
                  {renderSortHeader('location', 'Location', 'min-w-[140px]')}
                  <th scope="col" className="px-3 py-3 w-[44px] min-w-[44px]" />
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {sortedRows.map((r) => (
                  <tr
                    key={r.id}
                    tabIndex={0}
                    role="button"
                    className="group border-b last:border-b-0 hover:bg-slate-100/60 dark:hover:bg-slate-800/50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:bg-slate-100/80 dark:focus-visible:bg-slate-800/80"
                    onClick={() => onRowClick(r)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onRowClick(r)
                      }
                    }}
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-500 dark:text-slate-400 font-mono">
                      {fmtUTC(r.createdAt)}
                    </td>

                    <td className="px-4 py-3 max-w-[240px]">
                      <div
                        className="font-medium text-slate-900 dark:text-slate-100 truncate"
                        title={r.userDisplayName}
                      >
                        {r.userDisplayName}
                      </div>
                      <div
                        className="text-xs text-slate-500 dark:text-slate-400 truncate"
                        title={r.userPrincipalName}
                      >
                        {r.userPrincipalName}
                      </div>
                    </td>

                    <td className="px-4 py-3 max-w-[200px]">
                      <div
                        className="truncate text-slate-800 dark:text-slate-200"
                        title={r.appDisplayName}
                      >
                        {r.appDisplayName}
                      </div>
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap">
                      <StatusPill status={r.status} />
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap">
                      {r.conditionalAccess === 'Applied' ? (
                        <span className="text-xs font-medium text-blue-600 dark:text-blue-400">
                          Applied
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400 dark:text-slate-500">
                          Not Applied
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap text-xs font-mono text-slate-600 dark:text-slate-300">
                      {r.ipAddress ?? '—'}
                    </td>

                    <td className="px-4 py-3 max-w-[180px]">
                      <div
                        className="truncate text-slate-500 dark:text-slate-400 text-xs"
                        title={r.location ?? '—'}
                      >
                        {r.location ?? '—'}
                      </div>
                    </td>

                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-200 transition-colors" />
                    </td>
                  </tr>
                ))}

                {!sortedRows.length ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-4 py-12 text-center text-muted-foreground"
                    >
                      No sign-in logs match your filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <SignInDrawer
        open={open}
        event={selected}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
