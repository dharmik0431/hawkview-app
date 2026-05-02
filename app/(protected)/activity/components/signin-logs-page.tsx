'use client'

import * as React from 'react'
import type { SignInEvent } from '../data/types'
import { SignInDrawer } from './signin-drawer'

function fmtUTC(iso: string) {
  const s = iso.includes('T') ? iso : new Date(iso).toISOString()
  return s.replace('T', ' ').replace('Z', '').slice(0, 19)
}

function StatusPill({ status }: { status: SignInEvent['status'] }) {
  if (status === 'Success') {
    return (
      <span className="inline-flex rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
        Success
      </span>
    )
  }
  return (
    <span className="inline-flex rounded-md bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
      Failure
    </span>
  )
}

export function SignInLogsPage({ rows }: { rows: SignInEvent[] }) {
  const [open, setOpen] = React.useState(false)
  const [selected, setSelected] = React.useState<SignInEvent | null>(null)

  function onRowClick(r: SignInEvent) {
    setSelected(r)
    setOpen(true)
  }

  return (
    <>
      <div className="rounded-lg border bg-background overflow-hidden">
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/20 text-xs uppercase tracking-wider text-muted-foreground">
              <tr className="border-b">
                <th className="px-4 py-3 text-left whitespace-nowrap">Date</th>
                <th className="px-4 py-3 text-left">User</th>
                <th className="px-4 py-3 text-left">App</th>
                <th className="px-4 py-3 text-left whitespace-nowrap">
                  Status
                </th>
                <th className="px-4 py-3 text-left whitespace-nowrap">
                  Cond. Access
                </th>
                <th className="px-4 py-3 text-left whitespace-nowrap">
                  IP Address
                </th>
                <th className="px-4 py-3 text-left whitespace-nowrap">
                  Location
                </th>
              </tr>
            </thead>

            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b last:border-b-0 hover:bg-muted/20 cursor-pointer"
                  onClick={() => onRowClick(r)}
                >
                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                    {fmtUTC(r.createdAt)}
                  </td>

                  <td className="px-4 py-3">
                    <div className="font-medium">{r.userDisplayName}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.userPrincipalName}
                    </div>
                  </td>

                  <td className="px-4 py-3">{r.appDisplayName}</td>

                  <td className="px-4 py-3 whitespace-nowrap">
                    <StatusPill status={r.status} />
                  </td>

                  <td className="px-4 py-3 whitespace-nowrap">
                    {r.conditionalAccess === 'Applied' ? (
                      <a className="text-blue-600 hover:underline">Applied</a>
                    ) : (
                      <span className="text-muted-foreground">Not Applied</span>
                    )}
                  </td>

                  <td className="px-4 py-3 whitespace-nowrap">
                    {r.ipAddress ?? '—'}
                  </td>

                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                    {r.location ?? '—'}
                  </td>
                </tr>
              ))}

              {!rows.length ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-10 text-center text-muted-foreground"
                  >
                    No sign-in logs match your filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
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
