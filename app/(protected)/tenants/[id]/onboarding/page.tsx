'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clipboard,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { apiClient } from '@/lib/api/client'
import {
  onboardingNextStep,
  ReportVisibilityVerificationSchema,
  TenantOnboardingSchema,
  type TenantOnboarding,
} from '@/lib/tenants/tenant-onboarding'
import {
  ExchangeReadOnlyConsentResponseSchema,
  ExchangeReadOnlySetupSchema,
  ExchangeReadOnlyVerificationSchema,
  MicrosoftConsentResponseSchema,
  type ExchangeReadOnlySetup,
} from '@/types/api'
import { Button } from '@/components/ui/button'
import { microsoftConsentErrorMessage } from '@/lib/tenants/microsoft-consent-errors'

type BusyAction =
  | 'core-consent'
  | 'exchange-consent'
  | 'exchange-verify'
  | 'exchange-defer'
  | 'report-verify'
  | 'report-defer'
  | 'complete'
  | null

const statusLabel = (status: string) => status === 'VERIFIED'
  ? 'Complete'
  : status === 'DEFERRED'
    ? 'Finish later'
    : status === 'RBAC_REQUIRED'
      ? 'RBAC setup required'
      : status === 'PERMISSION_REQUIRED'
        ? 'Read permission required'
        : status === 'ERROR'
          ? 'Needs attention'
          : 'Action required'

export default function TenantOnboardingPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const tenantId = String(params.id)
  const [state, setState] = useState<TenantOnboarding | null>(null)
  const [exchangeSetup, setExchangeSetup] = useState<ExchangeReadOnlySetup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [copied, setCopied] = useState(false)
  const loadGeneration = useRef(0)

  const loadState = useCallback(async () => {
    const generation = ++loadGeneration.current
    setError(null)
    try {
      const raw = await apiClient.get<unknown>(
        `/api/tenants/${encodeURIComponent(tenantId)}/onboarding`,
      )
      const parsed = TenantOnboardingSchema.parse(raw)
      if (generation !== loadGeneration.current) return
      setState(parsed)

      if (parsed.steps.exchangeReadOnly.status === 'RBAC_REQUIRED') {
        const rawSetup = await apiClient.get<unknown>(
          `/api/tenants/${encodeURIComponent(tenantId)}/exchange-readonly/setup`,
        )
        if (generation !== loadGeneration.current) return
        setExchangeSetup(ExchangeReadOnlySetupSchema.parse(rawSetup))
      } else {
        setExchangeSetup(null)
      }
    } catch {
      if (generation !== loadGeneration.current) return
      setError('Tenant setup could not be loaded. Please retry.')
    }
  }, [tenantId])

  useEffect(() => {
    const currentUrl = new URL(window.location.href)
    const consentResult = currentUrl.searchParams.get('microsoftConsent')
    const consentError = currentUrl.searchParams.get('error')

    // A tenant-discovery popup hands the durable setup route back to the main
    // app. Progress is server-owned, so closing this window loses nothing.
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.location.assign(currentUrl.href)
        window.close()
        return
      } catch {
        // Continue in this tab if the opener is no longer accessible.
      }
    }

    if (consentResult === 'success') {
      setNotice('Microsoft access was verified. Continue with the optional data-quality steps.')
    } else if (consentResult === 'exchange-readonly-consented') {
      setNotice('Exchange consent was verified. Complete the least-privilege RBAC step below.')
    } else if (consentResult) {
      setError(microsoftConsentErrorMessage(consentError))
    }
    if (consentResult) {
      currentUrl.searchParams.delete('microsoftConsent')
      currentUrl.searchParams.delete('error')
      currentUrl.searchParams.delete('tenantId')
      window.history.replaceState({}, '', currentUrl)
    }
    void loadState()
    return () => { loadGeneration.current += 1 }
  }, [loadState])

  const run = async (action: BusyAction, operation: () => Promise<void>) => {
    setBusy(action)
    setError(null)
    setNotice(null)
    try {
      await operation()
    } catch {
      setError('This setup action could not be completed. Please retry.')
    } finally {
      setBusy(null)
    }
  }

  const beginCoreConsent = () => run('core-consent', async () => {
    const raw = await apiClient.post<unknown>(
      `/api/tenants/${encodeURIComponent(tenantId)}/microsoft-consent`,
    )
    const consent = MicrosoftConsentResponseSchema.parse(raw)
    window.location.assign(consent.consentUrl)
  })

  const beginExchangeConsent = () => run('exchange-consent', async () => {
    const raw = await apiClient.post<unknown>(
      `/api/tenants/${encodeURIComponent(tenantId)}/exchange-readonly/consent`,
    )
    const consent = ExchangeReadOnlyConsentResponseSchema.parse(raw)
    window.location.assign(consent.consentUrl)
  })

  const deferExchange = () => run('exchange-defer', async () => {
    const raw = await apiClient.post<unknown>(
      `/api/tenants/${encodeURIComponent(tenantId)}/onboarding/exchange-readonly/defer`,
    )
    setState(TenantOnboardingSchema.parse(raw))
  })

  const verifyExchange = () => run('exchange-verify', async () => {
    const raw = await apiClient.post<unknown>(
      `/api/tenants/${encodeURIComponent(tenantId)}/exchange-readonly/verify`,
    )
    ExchangeReadOnlyVerificationSchema.parse(raw)
    setNotice('HawkView verified Get-Mailbox-only access. No broader Exchange role was accepted.')
    await loadState()
  })

  const verifyReportVisibility = () => run('report-verify', async () => {
    const raw = await apiClient.post<unknown>(
      `/api/tenants/${encodeURIComponent(tenantId)}/onboarding/report-visibility/verify`,
    )
    const result = ReportVisibilityVerificationSchema.parse(raw)
    setState(result.onboarding)
    if (result.verification.status === 'READY') {
      setNotice('Microsoft confirms identifiable report names are available.')
    } else if (result.verification.status === 'IDENTIFIERS_CONCEALED') {
      setError('Microsoft still reports that names are concealed. Save the setting in Microsoft 365, wait a few minutes, then verify again.')
    } else if (result.verification.status === 'MISSING_PERMISSION') {
      setError('ReportSettings.Read.All has not been granted to HawkView. Re-authorize Microsoft access, then retry this check.')
    } else {
      setError(`Microsoft could not verify the report setting (${result.verification.status}). ${result.verification.retryable ? 'Retry in a moment.' : 'Review Microsoft access.'}`)
    }
  })

  const deferReport = () => run('report-defer', async () => {
    const raw = await apiClient.post<unknown>(
      `/api/tenants/${encodeURIComponent(tenantId)}/onboarding/report-visibility/defer`,
    )
    setState(TenantOnboardingSchema.parse(raw))
  })

  const finish = () => run('complete', async () => {
    const raw = await apiClient.post<unknown>(
      `/api/tenants/${encodeURIComponent(tenantId)}/onboarding/complete`,
    )
    TenantOnboardingSchema.parse(raw)
    router.replace(`/tenants/${encodeURIComponent(tenantId)}`)
  })

  const copyScript = async () => {
    if (!exchangeSetup) return
    try {
      await navigator.clipboard.writeText(exchangeSetup.setupScript)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('The setup script could not be copied. Select the script manually and copy it.')
    }
  }

  const next = useMemo(() => state ? onboardingNextStep(state) : null, [state])

  if (!state && !error) {
    return <div className="flex min-h-[60vh] items-center justify-center gap-3 text-slate-600"><Loader2 className="h-5 w-5 animate-spin" /> Loading tenant setup…</div>
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 md:px-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-600">Microsoft 365 onboarding</p>
          <h1 className="mt-1 text-2xl font-bold text-slate-950 dark:text-white">Finish setting up {state?.tenant.name ?? 'this tenant'}</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600 dark:text-slate-400">
            Your progress is saved after every verified action. You can close this page, lose connectivity, or restart your computer and resume here safely.
          </p>
        </div>
        {state && <Link href="/tenants" className="text-sm font-semibold text-blue-600 hover:underline">Back to tenants</Link>}
      </div>

      {error && (
        <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <div className="flex gap-2"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>
          <button type="button" onClick={() => void loadState()} className="font-semibold underline">Reload</button>
        </div>
      )}
      {notice && <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{notice}</div>}

      {state && (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              ['1', 'Microsoft access', state.steps.microsoftAccess.status],
              ['2', 'Exchange details', state.steps.exchangeReadOnly.status],
              ['3', 'Report names', state.steps.reportVisibility.status],
            ].map(([number, label, status]) => (
              <div key={number} className={`rounded-xl border p-4 ${status === 'VERIFIED' ? 'border-emerald-200 bg-emerald-50/60' : status === 'DEFERRED' ? 'border-slate-200 bg-slate-50' : 'border-blue-200 bg-blue-50/50'}`}>
                <div className="flex items-center gap-3">
                  <span className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${status === 'VERIFIED' ? 'bg-emerald-600 text-white' : 'bg-white text-blue-700 ring-1 ring-blue-200'}`}>{status === 'VERIFIED' ? <Check className="h-4 w-4" /> : number}</span>
                  <div><p className="font-semibold text-slate-900">{label}</p><p className="text-xs text-slate-500">{statusLabel(status)}</p></div>
                </div>
              </div>
            ))}
          </div>

          <section className={`rounded-2xl border bg-white p-5 shadow-sm dark:bg-slate-900 ${next === 'microsoftAccess' ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200 dark:border-slate-800'}`}>
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 text-blue-600" />
              <div className="flex-1"><h2 className="font-bold text-slate-950 dark:text-white">1. Add HawkView to the Microsoft tenant</h2><p className="mt-1 text-sm text-slate-600 dark:text-slate-400">A Microsoft administrator reviews the read-only application permissions. Microsoft creates the HawkView enterprise application in this tenant; the customer does not create a second app registration.</p></div>
            </div>
            {state.steps.microsoftAccess.status !== 'VERIFIED' && <div className="mt-4"><Button disabled={busy !== null} onClick={() => void beginCoreConsent()}>{busy === 'core-consent' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Review and authorize with Microsoft</Button></div>}
          </section>

          <section className={`rounded-2xl border bg-white p-5 shadow-sm dark:bg-slate-900 ${next === 'exchangeReadOnly' ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200 dark:border-slate-800'}`}>
            <div className="flex items-start gap-3"><Info className="mt-0.5 h-5 w-5 text-amber-600" /><div><h2 className="font-bold text-slate-950 dark:text-white">2. Optional Exchange read-only details</h2><p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Adds recipient type, maximum send size, and Send-on-behalf delegates. Standard Exchange inventory continues if you skip this step.</p></div></div>
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><strong>Important:</strong> {state.steps.exchangeReadOnly.disclaimer}</div>
            {state.steps.exchangeReadOnly.status === 'CONSENT_REQUIRED' && <div className="mt-4 flex flex-wrap gap-2"><Button disabled={busy !== null} onClick={() => void beginExchangeConsent()}>Grant optional Exchange consent</Button><Button variant="outline" disabled={busy !== null} onClick={() => void deferExchange()}>Finish later</Button></div>}
            {state.steps.exchangeReadOnly.status === 'RBAC_REQUIRED' && (
              <div className="mt-4 space-y-4">
                <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600"><li>Open Exchange Online PowerShell as an Exchange administrator.</li><li>Run the generated tenant-specific script.</li><li>Return here and let HawkView verify the effective access.</li></ol>
                {exchangeSetup ? <><div className="relative"><pre className="max-h-64 overflow-auto rounded-xl bg-slate-950 p-4 pr-12 text-xs text-slate-100"><code>{exchangeSetup.setupScript}</code></pre><button type="button" onClick={() => void copyScript()} className="absolute right-3 top-3 rounded-lg bg-white/10 p-2 text-white hover:bg-white/20" aria-label="Copy Exchange setup script">{copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}</button></div><div className="flex flex-wrap gap-2"><Button disabled={busy !== null} onClick={() => void verifyExchange()}>{busy === 'exchange-verify' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Verify read-only access</Button><Button variant="outline" disabled={busy !== null} onClick={() => void deferExchange()}>Finish later</Button></div></> : <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading verified setup script…</div>}
              </div>
            )}
          </section>

          <section className={`rounded-2xl border bg-white p-5 shadow-sm dark:bg-slate-900 ${next === 'reportVisibility' ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200 dark:border-slate-800'}`}>
            <div className="flex items-start gap-3"><Circle className="mt-0.5 h-5 w-5 text-violet-600" /><div><h2 className="font-bold text-slate-950 dark:text-white">3. Show names in Microsoft 365 usage reports</h2><p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Without this Microsoft setting, site and user identifiers are concealed and HawkView cannot match report activity to discovered SharePoint sites.</p></div></div>
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"><p>{state.steps.reportVisibility.disclaimer}</p><p className="mt-2 font-semibold">{state.steps.reportVisibility.settingPath.join(' → ')}</p><p className="mt-1">Enable: “{state.steps.reportVisibility.settingLabel}”</p></div>
            <div className="mt-4 flex flex-wrap gap-2">
              {state.steps.reportVisibility.status === 'PERMISSION_REQUIRED' ? <Button disabled={busy !== null} onClick={() => void beginCoreConsent()}>Grant read-only setting verification</Button> : <>
                <Button asChild variant="outline"><a href={state.steps.reportVisibility.adminCenterUrl} target="_blank" rel="noopener noreferrer">Open Microsoft 365 settings <ExternalLink className="ml-2 h-4 w-4" /></a></Button>
                <Button disabled={busy !== null} onClick={() => void verifyReportVisibility()}>{busy === 'report-verify' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Verify setting</Button>
              </>}
              {state.steps.reportVisibility.status !== 'VERIFIED' && <Button variant="ghost" disabled={busy !== null} onClick={() => void deferReport()}>Finish later</Button>}
            </div>
          </section>

          <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="font-semibold text-slate-900">Setup choices are saved</p><p className="text-sm text-slate-600">Optional steps can be completed later from Tenant Settings.</p></div>
            <Button disabled={!state.canFinish || busy !== null} onClick={() => void finish()}>{busy === 'complete' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Finish onboarding <ChevronRight className="ml-2 h-4 w-4" /></Button>
          </div>
        </>
      )}
    </div>
  )
}
