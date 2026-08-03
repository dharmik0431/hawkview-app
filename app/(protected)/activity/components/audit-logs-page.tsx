'use client'

import type { AuditEvent } from '../data/types'

function fmtUTC(iso: string) {
  const date = new Date(iso)
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
    : iso
}

export function AuditLogsPage({ rows }: { rows: AuditEvent[] }) {
  return (
    <div className="rounded-lg border bg-background overflow-hidden">
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/20 text-xs uppercase tracking-wider text-muted-foreground">
            <tr className="border-b">
              <th className="px-4 py-3 text-left whitespace-nowrap">Date</th>
              <th className="px-4 py-3 text-left">Activity</th>
              <th className="px-4 py-3 text-left">Actor</th>
              <th className="px-4 py-3 text-left">Target</th>
              <th className="px-4 py-3 text-left">Category</th>
              <th className="px-4 py-3 text-left">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b last:border-b-0 hover:bg-muted/20">
                <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{fmtUTC(row.createdAt)}</td>
                <td className="px-4 py-3">
                  <div className="font-medium">{row.activity}</div>
                  <div className="text-xs text-muted-foreground">{row.service ?? row.operationType ?? 'Microsoft Entra'}</div>
                </td>
                <td className="px-4 py-3">{row.actor ?? 'System'}</td>
                <td className="px-4 py-3">{row.target ?? '—'}</td>
                <td className="px-4 py-3">{row.category ?? '—'}</td>
                <td className="px-4 py-3">
                  <span className={row.result?.toLowerCase() === 'success' ? 'text-emerald-700' : 'text-red-700'}>{row.result ?? 'Unknown'}</span>
                </td>
              </tr>
            ))}
            {!rows.length ? (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">No audit logs match your filters.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}
