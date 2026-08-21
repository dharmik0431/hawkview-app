'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, ExternalLink, ShieldCheck, Terminal } from 'lucide-react'
import { apiClient } from '@/lib/api/client'
import {
  ExchangeRbacSetupResponseSchema,
  type ExchangeRbacSetupResponse,
} from '@/types/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function ExchangeRbacSetup({
  tenantId,
  onDone,
  className,
}: {
  tenantId: string
  onDone?: () => void
  className?: string
}) {
  const [setup, setSetup] = useState<ExchangeRbacSetupResponse | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setState('loading')
    try {
      const response = await apiClient.get<unknown>(
        `/api/tenants/${encodeURIComponent(tenantId)}/exchange-rbac-setup`
      )
      setSetup(ExchangeRbacSetupResponseSchema.parse(response))
      setState('ready')
    } catch {
      setSetup(null)
      setState('error')
    }
  }, [tenantId])

  useEffect(() => {
    void load()
  }, [load])

  const copyScript = async () => {
    if (!setup) return
    await navigator.clipboard.writeText(setup.setupScript)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2500)
  }

  return (
    <section className={cn('space-y-4', className)} aria-labelledby="exchange-rbac-title">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div>
          <h2 id="exchange-rbac-title" className="text-lg font-bold text-slate-950 dark:text-white">
            Add least-privilege Exchange access
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Exchange consent and Exchange RBAC are separate. This one-time setup gives the HawkView application one read-only cmdlet: Get-Mailbox.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/40">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Custom role</p>
          <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">HawkView Exchange Read Only</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/40">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Allowed cmdlet</p>
          <p className="mt-1 text-sm font-semibold text-emerald-700 dark:text-emerald-300">Get-Mailbox only</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/40">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Write access</p>
          <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">None</p>
        </div>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200">
        <div className="flex gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Do not assign Recipient Management, Exchange Administrator, or Global Administrator to the HawkView application. A customer Exchange Administrator runs this script, but that administrator role is not granted to the app.
          </p>
        </div>
      </div>

      {state === 'loading' && (
        <p className="text-sm text-slate-500">Preparing the tenant-specific setup script…</p>
      )}
      {state === 'error' && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          The Exchange setup details could not be loaded. No permission was changed.
          <Button type="button" variant="outline" size="sm" className="ml-3" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}
      {setup && state === 'ready' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
              <Terminal className="h-4 w-4" />
              Run in Exchange Online PowerShell
            </div>
            <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => void copyScript()}>
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy setup script'}
            </Button>
          </div>
          <pre className="max-h-64 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs leading-5 text-slate-100">
            <code>{setup.setupScript}</code>
          </pre>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
            <p>
              Requires Exchange.ManageAsAppV2 admin consent. Microsoft permission propagation can take time; HawkView confirms access on the next eligible Exchange collection.
            </p>
            <a href={setup.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-blue-600 hover:underline dark:text-blue-400">
              Microsoft documentation <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      )}

      {onDone && (
        <div className="flex justify-end border-t border-slate-200 pt-4 dark:border-slate-800">
          <Button type="button" onClick={onDone}>Finish for now</Button>
        </div>
      )}
    </section>
  )
}
