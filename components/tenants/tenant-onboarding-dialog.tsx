'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Check,
  Clipboard,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { apiClient } from '@/lib/api/client'
import {
  modalOnboardingCanComplete,
  modalOnboardingStep,
  modalStepStatus,
  tenantSetupDismissedKey,
  type ModalOnboardingStep,
} from '@/lib/tenants/modal-tenant-onboarding'
import {
  executeReportVisibilityVerification,
  type ReportVerificationFeedback,
} from '@/lib/tenants/report-visibility-verification'
import {
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

type BusyAction =
  | 'loading'
  | 'exchange-consent'
  | 'exchange-verify'
  | 'exchange-skip'
  | 'report-consent'
  | 'report-verify'
  | 'complete'
  | null

type Props = {
  open: boolean
  tenantId: string | null
  onClose: () => void
  onCompleted: (tenantId: string) => void
}

const stepLabels: Record<ModalOnboardingStep, string> = {
  1: 'Microsoft app installed',
  2: 'Set up Exchange access',
  3: 'Show names in Microsoft 365 reports',
}

const feedbackClasses: Record<ReportVerificationFeedback['tone'], string> = {
  info: 'border-blue-200 bg-blue-50 text-blue-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-950',
  error: 'border-red-200 bg-red-50 text-red-900',
}

function formatLastChecked(value: string | null) {
  if (!value) return 'Not checked yet'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Not reported'
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
}

function safeStepAnnouncement(step: ModalOnboardingStep) {
  return `Step ${step} of 3: ${stepLabels[step]}`
}

export function TenantOnboardingDialog({
  open,
  tenantId,
  onClose,
  onCompleted,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const priorFocusRef = useRef<HTMLElement | null>(null)
  const loadGeneration = useRef(0)
  const [state, setState] = useState<TenantOnboarding | null>(null)
  const [exchangeSetup, setExchangeSetup] = useState<ExchangeReadOnlySetup | null>(null)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [reportFeedback, setReportFeedback] = useState<ReportVerificationFeedback | null>(null)
  const [copied, setCopied] = useState(false)

  const activeStep = useMemo(
    () => state ? modalOnboardingStep(state) : 1,
    [state],
  )

  const loadExchangeSetup = useCallback(async (id: string, generation: number) => {
    try {
      const raw = await apiClient.get<unknown>(
        `/api/tenants/${encodeURIComponent(id)}/exchange-readonly/setup`,
      )
      if (generation !== loadGeneration.current) return
      setExchangeSetup(ExchangeReadOnlySetupSchema.parse(raw))
    } catch {
      if (generation !== loadGeneration.current) return
      setExchangeSetup(null)
      setError('The Exchange read-only setup script could not be loaded. Retry this step or finish later.')
    }
  }, [])

  const loadState = useCallback(async (showLoading = true) => {
    if (!tenantId) return null
    const generation = ++loadGeneration.current
    if (showLoading) setBusy('loading')
    setError(null)
    try {
      const raw = await apiClient.get<unknown>(
        `/api/tenants/${encodeURIComponent(tenantId)}/onboarding`,
      )
      const parsed = TenantOnboardingSchema.parse(raw)
      if (generation !== loadGeneration.current) return null
      setState(parsed)
      const nextStep = modalOnboardingStep(parsed)
      setStatusMessage(safeStepAnnouncement(nextStep))
      if (parsed.steps.microsoftAccess.status !== 'VERIFIED') {
        setError('HawkView could not confirm that the Microsoft app installation is complete. Retry the check or use the full setup page for recovery.')
      }
      if (parsed.steps.exchangeReadOnly.status === 'RBAC_REQUIRED') {
        await loadExchangeSetup(tenantId, generation)
      } else {
        setExchangeSetup(null)
      }
      return parsed
    } catch {
      if (generation !== loadGeneration.current) return null
      setState(null)
      setExchangeSetup(null)
      setError('HawkView could not load the authoritative tenant setup state. Check your connection and retry.')
      return null
    } finally {
      if (generation === loadGeneration.current && showLoading) setBusy(null)
    }
  }, [loadExchangeSetup, tenantId])

  useEffect(() => {
    if (!open || !tenantId) return
    setState(null)
    setExchangeSetup(null)
    setReportFeedback(null)
    setError(null)
    setStatusMessage('Checking the Microsoft app installation with HawkView…')
    setCopied(false)
    void loadState()
    return () => {
      loadGeneration.current += 1
    }
  }, [loadState, open, tenantId])

  useEffect(() => {
    if (!open) return
    priorFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusTimer = window.setTimeout(() => titleRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(focusTimer)
      document.body.style.overflow = previousOverflow
      priorFocusRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!busy) onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getAttribute('aria-hidden') !== 'true')
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onClose, open])

  const startExchangeConsent = async () => {
    if (!tenantId) return
    setBusy('exchange-consent')
    setError(null)
    try {
      window.sessionStorage.removeItem(tenantSetupDismissedKey(tenantId))
      const raw = await apiClient.post<unknown>(
        `/api/tenants/${encodeURIComponent(tenantId)}/exchange-readonly/consent`,
      )
      const consent = ExchangeReadOnlyConsentResponseSchema.parse(raw)
      window.location.assign(consent.consentUrl)
    } catch {
      setError('The optional Exchange consent workflow could not be started. Retry or skip Exchange for now.')
      setBusy(null)
    }
  }

  const copySetupScript = async () => {
    if (!exchangeSetup) return
    try {
      await navigator.clipboard.writeText(exchangeSetup.setupScript)
      setCopied(true)
      setStatusMessage('Exchange setup script copied.')
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('The setup script could not be copied. Select the script and copy it manually.')
    }
  }

  const verifyExchange = async () => {
    if (!tenantId) return
    setBusy('exchange-verify')
    setError(null)
    try {
      const raw = await apiClient.post<unknown>(
        `/api/tenants/${encodeURIComponent(tenantId)}/exchange-readonly/verify`,
      )
      ExchangeReadOnlyVerificationSchema.parse(raw)
      setStatusMessage('Get-Mailbox-only access was verified. Moving to step 3.')
      await loadState(false)
    } catch {
      setError('Exchange verification did not succeed. Confirm optional consent, run the Get-Mailbox-only setup script, allow Microsoft RBAC time to propagate, and retry.')
    } finally {
      setBusy(null)
    }
  }

  const skipExchange = async () => {
    if (!tenantId) return
    setBusy('exchange-skip')
    setError(null)
    try {
      const raw = await apiClient.post<unknown>(
        `/api/tenants/${encodeURIComponent(tenantId)}/onboarding/exchange-readonly/defer`,
      )
      const parsed = TenantOnboardingSchema.parse(raw)
      setState(parsed)
      setExchangeSetup(null)
      setStatusMessage('Optional Exchange setup was skipped for now. Moving to step 3.')
    } catch {
      setError('HawkView could not save the Exchange skip choice. Retry or finish later without changing the tenant connection.')
    } finally {
      setBusy(null)
    }
  }

  const startReportConsent = async () => {
    if (!tenantId) return
    setBusy('report-consent')
    setError(null)
    try {
      window.sessionStorage.removeItem(tenantSetupDismissedKey(tenantId))
      const raw = await apiClient.post<unknown>(
        `/api/tenants/${encodeURIComponent(tenantId)}/microsoft-consent`,
      )
      const consent = MicrosoftConsentResponseSchema.parse(raw)
      window.location.assign(consent.consentUrl)
    } catch {
      setError('Microsoft re-consent could not be started. Retry or use the full setup page for recovery.')
      setBusy(null)
    }
  }

  const verifyReportSetting = async () => {
    if (!tenantId) return
    setBusy('report-verify')
    setError(null)
    try {
      const result = await executeReportVisibilityVerification({
        request: async () => {
          const raw = await apiClient.post<unknown>(
            `/api/tenants/${encodeURIComponent(tenantId)}/onboarding/report-visibility/verify`,
          )
          return ReportVisibilityVerificationSchema.parse(raw)
        },
        onFeedback: (feedback) => {
          setReportFeedback(feedback)
          setStatusMessage(`${feedback.title}. ${feedback.message}`)
        },
      })
      setState(result.onboarding)
    } catch {
      // The shared helper publishes the bounded, status-specific error.
    } finally {
      setBusy(null)
    }
  }

  const completeSetup = async () => {
    if (!tenantId) return
    setBusy('complete')
    setError(null)
    try {
      const rawCurrent = await apiClient.get<unknown>(
        `/api/tenants/${encodeURIComponent(tenantId)}/onboarding`,
      )
      const current = TenantOnboardingSchema.parse(rawCurrent)
      setState(current)
      if (!modalOnboardingCanComplete(current)) {
        setError('HawkView refreshed the setup state and found an unfinished step. Complete the current step before finishing.')
        setStatusMessage(safeStepAnnouncement(modalOnboardingStep(current)))
        return
      }
      const rawCompleted = await apiClient.post<unknown>(
        `/api/tenants/${encodeURIComponent(tenantId)}/onboarding/complete`,
      )
      const completed = TenantOnboardingSchema.parse(rawCompleted)
      if (!completed.completedAt) {
        setError('HawkView did not confirm setup completion. No completion state was assumed; retry safely.')
        return
      }
      onCompleted(tenantId)
    } catch {
      setError('HawkView could not complete tenant setup. Your verified progress is saved; retry or finish later.')
    } finally {
      setBusy(null)
    }
  }

  if (!open || !tenantId) return null

  const exchangeStatus = state?.steps.exchangeReadOnly.status ?? null
  const reportStatus = state?.steps.reportVisibility.status ?? null
  const canComplete = state ? modalOnboardingCanComplete(state) : false

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/65 p-2 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tenant-setup-title"
        aria-describedby="tenant-setup-description"
        className="relative flex max-h-[calc(100dvh-1rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl outline-none motion-safe:animate-in motion-safe:zoom-in-95 motion-reduce:transition-none dark:border-slate-800 dark:bg-slate-950 sm:max-h-[calc(100dvh-2rem)]"
      >
        <header className="shrink-0 border-b border-slate-200 px-4 py-4 pr-14 dark:border-slate-800 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-600">Microsoft 365 tenant setup</p>
          <h2
            ref={titleRef}
            id="tenant-setup-title"
            tabIndex={-1}
            className="mt-1 text-xl font-bold text-slate-950 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-white sm:text-2xl"
          >
            Finish setting up HawkView
          </h2>
          <p id="tenant-setup-description" className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {state
              ? `${state.tenant.name}${state.tenant.primaryDomain ? ` (${state.tenant.primaryDomain})` : ''}`
              : 'Checking the connected Microsoft tenant…'}
          </p>
          <button
            type="button"
            aria-label="Close tenant setup"
            disabled={Boolean(busy)}
            onClick={onClose}
            className="absolute right-3 top-3 rounded-lg p-2 text-slate-500 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:hover:bg-slate-800 sm:right-5 sm:top-5"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          <ol aria-label="Tenant setup progress" className="grid gap-2 sm:grid-cols-3">
            {([1, 2, 3] as const).map((step) => {
              const stepStatus = modalStepStatus(state, step)
              const current = activeStep === step
              return (
                <li
                  key={step}
                  aria-current={current ? 'step' : undefined}
                  className={`rounded-xl border p-3 ${current ? 'border-blue-400 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/30' : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900'}`}
                >
                  <div className="flex items-start gap-2">
                    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${stepStatus === 'Complete' ? 'bg-emerald-600 text-white' : stepStatus === 'Skipped' ? 'bg-slate-600 text-white' : current ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-300 dark:bg-slate-950 dark:text-slate-300 dark:ring-slate-700'}`}>
                      {stepStatus === 'Complete' ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : step}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-slate-900 dark:text-white">{stepLabels[step]}</span>
                      <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-400">{stepStatus}</span>
                    </span>
                  </div>
                </li>
              )
            })}
          </ol>

          <div className="sr-only" aria-live="polite" aria-atomic="true">{statusMessage}</div>

          {error && (
            <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <section
            aria-labelledby={`tenant-setup-step-${activeStep}`}
            className="mt-5"
          >
            <h3 id={`tenant-setup-step-${activeStep}`} className="text-lg font-bold text-slate-950 dark:text-white">
              Step {activeStep}: {stepLabels[activeStep]}
            </h3>

            {activeStep === 1 && (
              <div className="mt-3 space-y-4">
                <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">
                  HawkView confirms the Microsoft app installation from the saved tenant connection. A callback URL by itself never marks this step complete.
                </p>
                {busy === 'loading' || !state ? (
                  <div role="status" className="flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
                    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    Checking the Microsoft app installation…
                  </div>
                ) : (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                    Server status: {state.steps.microsoftAccess.status === 'ERROR' ? 'Needs attention' : 'Administrator consent required'}.
                  </div>
                )}
                <Button type="button" disabled={Boolean(busy)} onClick={() => void loadState()}>
                  <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                  Retry confirmation
                </Button>
              </div>
            )}

            {activeStep === 2 && state && (
              <div className="mt-3 space-y-4">
                <div className="rounded-xl border border-cyan-200 bg-cyan-50/70 p-4 text-sm text-cyan-950 dark:border-cyan-900 dark:bg-cyan-950/20 dark:text-cyan-100">
                  <div className="flex items-start gap-2">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <p>HawkView requests optional Exchange application consent, then an Exchange administrator runs a tenant-specific script that limits the app to <strong>Get-Mailbox only</strong>. Standard Microsoft Graph collection continues if you skip this step.</p>
                  </div>
                </div>

                {exchangeStatus === 'CONSENT_REQUIRED' && (
                  <Button type="button" disabled={Boolean(busy)} onClick={() => void startExchangeConsent()}>
                    {busy === 'exchange-consent' && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                    Set up Exchange access
                  </Button>
                )}

                {exchangeStatus === 'RBAC_REQUIRED' && (
                  <div className="space-y-4">
                    <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
                      <li>Open Exchange Online PowerShell as an Exchange administrator.</li>
                      <li>Run the tenant-specific script below.</li>
                      <li>Return here and verify the effective Get-Mailbox access.</li>
                    </ol>
                    {exchangeSetup ? (
                      <>
                        <div className="relative">
                          <pre className="max-h-52 overflow-auto rounded-xl bg-slate-950 p-4 pr-12 text-xs text-slate-100"><code>{exchangeSetup.setupScript}</code></pre>
                          <button
                            type="button"
                            onClick={() => void copySetupScript()}
                            className="absolute right-3 top-3 rounded-lg bg-white/10 p-2 text-white outline-none hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-blue-400"
                            aria-label="Copy Exchange setup script"
                          >
                            {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Clipboard className="h-4 w-4" aria-hidden="true" />}
                          </button>
                        </div>
                        <Button type="button" disabled={Boolean(busy)} onClick={() => void verifyExchange()}>
                          {busy === 'exchange-verify' && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                          Verify Exchange access
                        </Button>
                      </>
                    ) : (
                      <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void loadState()}>
                        Retry setup details
                      </Button>
                    )}
                  </div>
                )}

                <div>
                  <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void skipExchange()}>
                    {busy === 'exchange-skip' && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                    Skip for now
                  </Button>
                </div>
              </div>
            )}

            {activeStep === 3 && state && (
              <div className="mt-3 space-y-4">
                <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">
                  Identifiable names let HawkView match Microsoft usage reports to discovered users and SharePoint sites. HawkView can read this setting but cannot change it.
                </p>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
                  <p className="font-semibold">{state.steps.reportVisibility.settingPath.join(' → ')}</p>
                  <p className="mt-2">In Microsoft 365, <strong>UNCHECK</strong> “{state.steps.reportVisibility.settingLabel},” then <strong>Save</strong>.</p>
                  <p className="mt-2 text-xs">Microsoft permission and setting changes may take a few minutes to propagate.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {reportStatus === 'PERMISSION_REQUIRED' ? (
                    <Button type="button" disabled={Boolean(busy)} onClick={() => void startReportConsent()}>
                      {busy === 'report-consent' && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                      Re-consent Microsoft access
                    </Button>
                  ) : canComplete ? (
                    <Button type="button" disabled={Boolean(busy)} onClick={() => void completeSetup()}>
                      {busy === 'complete' && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                      Finish setup
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      aria-busy={busy === 'report-verify'}
                      disabled={Boolean(busy)}
                      onClick={() => void verifyReportSetting()}
                    >
                      {busy === 'report-verify' ? <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}
                      {busy === 'report-verify' ? 'Checking Microsoft…' : 'Verify setting'}
                    </Button>
                  )}
                  <Button asChild variant="outline">
                    <a href={state.steps.reportVisibility.adminCenterUrl} target="_blank" rel="noopener noreferrer">
                      Open Microsoft 365 settings <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
                    </a>
                  </Button>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Last checked with Microsoft: {formatLastChecked(reportFeedback?.checkedAt ?? state.steps.reportVisibility.lastCheckedAt)}
                </p>
                {reportFeedback && (
                  <div
                    role={reportFeedback.tone === 'warning' || reportFeedback.tone === 'error' ? 'alert' : 'status'}
                    className={`rounded-xl border p-4 text-sm ${feedbackClasses[reportFeedback.tone]}`}
                  >
                    <p className="font-semibold">{reportFeedback.title}</p>
                    <p className="mt-1">{reportFeedback.message}</p>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={onClose}>Finish later</Button>
            <Link
              href={`/tenants/${encodeURIComponent(tenantId)}/onboarding`}
              className="rounded text-xs font-semibold text-blue-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300"
            >
              Open full setup and recovery page
            </Link>
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <Info className="h-3.5 w-3.5" aria-hidden="true" /> Progress is saved after verified actions.
          </span>
        </footer>
      </div>
    </div>
  )
}
