'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Clipboard, ExternalLink, Info, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react'

import { apiClient } from '@/lib/api/client'
import {
  ExchangeReadOnlySetupSchema,
  ExchangeReadOnlyVerificationSchema,
  type ExchangeReadOnlySetup,
} from '@/types/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

type Props = {
  tenantId: string
  connectionMode: 'hawkview-managed' | 'customer-managed'
  active?: boolean
  consentResult?: string | null
}

export function ExchangeReadonlySetup({ tenantId, connectionMode, active = true, consentResult = null }: Props) {
  const [setup, setSetup] = useState<ExchangeReadOnlySetup | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [state, setState] = useState<'idle' | 'loading' | 'consenting' | 'verifying'>('idle')
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const loadSetup = useCallback(async () => {
    setState('loading')
    try {
      const raw = await apiClient.get<unknown>(
        `/api/tenants/${encodeURIComponent(tenantId)}/exchange-readonly/setup`,
      )
      setSetup(ExchangeReadOnlySetupSchema.parse(raw))
    } catch {
      setSetup(null)
      setNotice({ kind: 'error', text: 'Exchange read-only setup details could not be loaded.' })
    } finally {
      setState('idle')
    }
  }, [tenantId])

  useEffect(() => {
    if (active) {
      if (!consentResult) setNotice(null)
      void loadSetup()
    }
  }, [active, consentResult, loadSetup])

  useEffect(() => {
    if (consentResult === 'exchange-readonly-consented') {
      setExpanded(true)
      setNotice({
        kind: 'success',
        text: 'Optional Exchange consent was recorded. Complete Step 2, then run the verification probe before collection is enabled.',
      })
    } else if (consentResult === 'exchange-readonly-error') {
      setExpanded(true)
      setNotice({
        kind: 'error',
        text: 'Optional Exchange consent was not confirmed. Review Step 1 and try again.',
      })
    }
  }, [consentResult])

  const grantConsent = async () => {
    setState('consenting')
    setNotice(null)
    try {
      const result = await apiClient.post<{ consentUrl?: string }>(
        `/api/tenants/${encodeURIComponent(tenantId)}/exchange-readonly/consent`,
      )
      if (!result?.consentUrl) throw new Error('Consent URL unavailable')
      window.location.assign(result.consentUrl)
    } catch {
      setNotice({ kind: 'error', text: 'The optional Exchange consent workflow could not be started.' })
      setState('idle')
    }
  }

  const copyScript = async () => {
    if (!setup) return
    try {
      await navigator.clipboard.writeText(setup.setupScript)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setNotice({ kind: 'error', text: 'The setup script could not be copied. Select and copy it manually.' })
    }
  }

  const verifyAndEnable = async () => {
    setState('verifying')
    setNotice(null)
    try {
      const raw = await apiClient.post<unknown>(
        `/api/tenants/${encodeURIComponent(tenantId)}/exchange-readonly/verify`,
      )
      const result = ExchangeReadOnlyVerificationSchema.parse(raw)
      setNotice({
        kind: 'success',
        text: `Exchange read-only mode is enabled. ${result.collectedMailboxes.toLocaleString()} mailbox${result.collectedMailboxes === 1 ? '' : 'es'} verified.`,
      })
      await loadSetup()
    } catch {
      setNotice({
        kind: 'error',
        text: 'Verification failed. Confirm Exchange.ManageAsAppV2 consent and run the Get-Mailbox-only setup script, then try again. Microsoft RBAC changes can take time to propagate.',
      })
      setState('idle')
    }
  }

  const enabled = Boolean(setup?.enabledAt)

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-2xs dark:border-slate-800 dark:bg-slate-900">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-4 p-5 text-left"
        aria-expanded={expanded}
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-lg bg-cyan-50 p-2 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-300">
            <LockKeyhole className="h-4 w-4" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Optional Exchange read-only details</h2>
              <Badge className={enabled ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100' : 'bg-slate-100 text-slate-700 hover:bg-slate-100'}>
                {enabled ? 'Enabled' : 'Not enabled'}
              </Badge>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Adds Send-on-behalf delegates and maximum send size. Standard Graph collection continues normally if you skip this.
            </p>
          </div>
        </div>
        {expanded ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-500" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" />}
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-slate-100 p-5 dark:border-slate-800">
          <div className="flex items-start gap-3 rounded-lg border border-cyan-200 bg-cyan-50/70 p-4 text-cyan-950 dark:border-cyan-900 dark:bg-cyan-950/20 dark:text-cyan-100">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="text-xs font-bold">Target authorization: exactly one Exchange cmdlet</div>
              <p className="mt-1 text-xs leading-relaxed">
              HawkView receives only <code className="font-semibold">Get-Mailbox</code>. Verification also refuses a broader Microsoft Entra directory role or membership in another Exchange role group.
              </p>
            </div>
          </div>

          {notice && (
            <div className={notice.kind === 'success'
              ? 'rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800'
              : 'rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800'}>
              {notice.text}
            </div>
          )}

          {state === 'loading' && !setup ? (
            <div className="flex items-center gap-2 py-4 text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading read-only setup…</div>
          ) : setup ? (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-900 dark:bg-emerald-950/20">
                  <div className="text-xs font-bold text-emerald-900 dark:text-emerald-200">Collected</div>
                  <ul className="mt-2 space-y-1 text-xs text-emerald-800 dark:text-emerald-300">
                    {setup.collectedFields.map((field) => <li key={field}>✓ {field}</li>)}
                  </ul>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-800/40">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-200">Not available from this API</div>
                  <ul className="mt-2 space-y-1 text-xs text-slate-600 dark:text-slate-400">
                    {setup.unavailableFields.map((field) => <li key={field}>— {field}</li>)}
                  </ul>
                </div>
              </div>

              <ol className="grid gap-3 lg:grid-cols-3">
                <li className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Step 1</div>
                  <div className="mt-1 text-xs font-semibold text-slate-900 dark:text-white">Authorize the optional API</div>
                  <p className="mt-1 min-h-10 text-[11px] leading-relaxed text-slate-500">
                    {connectionMode === 'hawkview-managed'
                      ? 'A Microsoft administrator grants Exchange.ManageAsAppV2 to the HawkView connector.'
                      : 'Add Exchange.ManageAsAppV2 application permission and tenant admin consent to your customer-managed app.'}
                  </p>
                  {connectionMode === 'hawkview-managed' ? (
                    <Button type="button" size="sm" variant="outline" className="mt-3 h-8 w-full text-xs" onClick={grantConsent} disabled={state !== 'idle' || setup.consentGranted}>
                      {setup.consentGranted ? <><Check className="mr-1.5 h-3.5 w-3.5" /> Consent recorded</> : 'Grant optional consent'}
                    </Button>
                  ) : (
                    <Badge variant="outline" className="mt-3">Customer-managed app</Badge>
                  )}
                </li>
                <li className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Step 2</div>
                  <div className="mt-1 text-xs font-semibold text-slate-900 dark:text-white">Create the narrow Exchange role</div>
                  <p className="mt-1 min-h-10 text-[11px] leading-relaxed text-slate-500">A human administrator authorized to manage Exchange roles runs the script once. The app is assigned Get-Mailbox only.</p>
                  <Button type="button" size="sm" variant="outline" className="mt-3 h-8 w-full text-xs" onClick={copyScript}>
                    {copied ? <><Check className="mr-1.5 h-3.5 w-3.5" /> Copied</> : <><Clipboard className="mr-1.5 h-3.5 w-3.5" /> Copy setup script</>}
                  </Button>
                </li>
                <li className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Step 3</div>
                  <div className="mt-1 text-xs font-semibold text-slate-900 dark:text-white">Verify before enabling</div>
                  <p className="mt-1 min-h-10 text-[11px] leading-relaxed text-slate-500">HawkView makes a real Get-Mailbox request. Collection is enabled only after it succeeds.</p>
                  <Button type="button" size="sm" className="mt-3 h-8 w-full text-xs" onClick={verifyAndEnable} disabled={state !== 'idle' || enabled}>
                    {state === 'verifying' ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Verifying…</> : enabled ? 'Enabled' : 'Verify and enable'}
                  </Button>
                </li>
              </ol>

              <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-slate-500">
                <span className="flex items-center gap-1.5"><Info className="h-3.5 w-3.5" /> Microsoft labels this API as Preview and says it is not yet available in every organization.</span>
                <a href={setup.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-cyan-700 hover:underline dark:text-cyan-300">
                  Microsoft documentation <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setNotice(null)
                void loadSetup()
              }}
            >
              Retry
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
