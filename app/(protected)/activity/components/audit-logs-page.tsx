'use client'

import * as React from 'react'
import { ArrowUp, ArrowDown, ArrowUpDown, ChevronRight } from 'lucide-react'
import type { AuditEvent } from '../data/types'
import { SignInDrawer } from './signin-drawer'

function fmtUTC(iso?: string) {
  if (!iso) return 'Not reported'
  const date = new Date(iso)
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
    : 'Not reported'
}

function ResultPill({ result }: { result?: string }) {
  const normalized = String(result ?? '').trim().toLowerCase()
  const isSuccess = normalized === 'success' || normalized === 'succeeded'
  if (isSuccess) {
    return (
      <span className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800">
        Success
      </span>
    )
  }
  if (!normalized || normalized === 'not reported') {
    return (
      <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
        Not reported
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-md bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700 border border-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-800">
      {result || 'Failure'}
    </span>
  )
}

export function AuditLogsPage({
  rows,
  sortField: externalSortField,
  sortOrder: externalSortOrder,
  onSort: externalOnSort,
}: {
  rows: AuditEvent[]
  sortField?: keyof AuditEvent
  sortOrder?: 'asc' | 'desc'
  onSort?: (field: keyof AuditEvent) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [selected, setSelected] = React.useState<AuditEvent | null>(null)

  const [internalSortField, setInternalSortField] =
    React.useState<keyof AuditEvent>('createdAt')
  const [internalSortOrder, setInternalSortOrder] = React.useState<
    'asc' | 'desc'
  >('desc')

  const sortField = externalSortField ?? internalSortField
  const sortOrder = externalSortOrder ?? internalSortOrder

  function handleSort(field: keyof AuditEvent) {
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

      if (sortField === 'actor') {
        valA = `${a.actor || ''} ${a.actorPrincipalName || ''}`
        valB = `${b.actor || ''} ${b.actorPrincipalName || ''}`
      }

      const isMissingA =
        valA === undefined || valA === null || valA === '' || valA === '—'
      const isMissingB =
        valB === undefined || valB === null || valB === '' || valB === '—'

      if (isMissingA && isMissingB) return 0
      if (isMissingA) return 1
      if (isMissingB) return -1

      let cmp = 0
      if (sortField === 'createdAt') {
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

  function onRowClick(r: AuditEvent) {
    setSelected(r)
    setOpen(true)
  }

  function renderSortHeader(
    field: keyof AuditEvent,
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
            audit log event{sortedRows.length === 1 ? '' : 's'}
          </div>
        </div>

        <div className="rounded-lg border bg-background overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-slate-50/80 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 text-muted-foreground">
                <tr>
                  {renderSortHeader('createdAt', 'Date', 'min-w-[150px]')}
                  {renderSortHeader('activity', 'Activity', 'min-w-[200px]')}
                  {renderSortHeader('actor', 'Performed by', 'min-w-[180px]')}
                  {renderSortHeader('target', 'Target', 'min-w-[180px]')}
                  {renderSortHeader('service', 'Service', 'min-w-[140px]')}
                  {renderSortHeader('category', 'Category', 'min-w-[130px]')}
                  {renderSortHeader('result', 'Result', 'min-w-[110px]')}
                  <th scope="col" className="px-3 py-3 w-[44px] min-w-[44px]" />
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {sortedRows.map((row) => (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    role="button"
                    className="group border-b last:border-b-0 hover:bg-slate-100/60 dark:hover:bg-slate-800/50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:bg-slate-100/80 dark:focus-visible:bg-slate-800/80"
                    onClick={() => onRowClick(row)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onRowClick(row)
                      }
                    }}
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-500 dark:text-slate-400 font-mono">
                      {fmtUTC(row.createdAt)}
                    </td>

                    <td className="px-4 py-3 max-w-[220px]">
                      <div
                        className="font-medium text-slate-900 dark:text-slate-100 truncate"
                        title={row.activity}
                      >
                        {row.activity}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                        {row.service ?? row.operationType ?? 'Not reported'}
                      </div>
                    </td>

                    <td className="px-4 py-3 max-w-[200px]">
                      <div
                        className="font-medium text-slate-800 dark:text-slate-200 truncate"
                        title={row.actor ?? 'Not reported'}
                      >
                        {row.actor ?? 'Not reported'}
                      </div>
                      {row.actorPrincipalName ? (
                        <div
                          className="text-xs text-slate-500 dark:text-slate-400 truncate"
                          title={row.actorPrincipalName}
                        >
                          {row.actorPrincipalName}
                        </div>
                      ) : null}
                    </td>

                    <td className="px-4 py-3 max-w-[200px]">
                      <div
                        className="truncate text-slate-700 dark:text-slate-300"
                        title={row.target ?? 'Not reported'}
                      >
                        {row.target ?? 'Not reported'}
                      </div>
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-600 dark:text-slate-300">
                      {row.service ?? row.operationType ?? 'Not reported'}
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
                      {row.category ?? 'Not reported'}
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap">
                      <ResultPill result={row.result} />
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
                      No audit events were reported for the selected range and filters.
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
