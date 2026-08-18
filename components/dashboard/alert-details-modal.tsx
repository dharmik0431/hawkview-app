'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  X,
  ShieldAlert,
  AlertTriangle,
  ShieldCheck,
  ExternalLink,
  Info,
  Layers,
  CheckCircle2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { investigateDestination } from '@/lib/tenants/investigate-navigation'
import type { QueueItem } from '@/app/(protected)/dashboard/page'

interface AlertDetailsModalProps {
  item: QueueItem | null
  isOpen: boolean
  onClose: () => void
  originatingElement?: HTMLElement | null
}

function parseTime(v?: string) {
  if (!v) return 0
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : 0
}

function formatAgeDisplay(iso?: string) {
  const t = parseTime(iso)
  if (!t) return '—'
  const diff = Date.now() - t
  const mins = Math.max(0, Math.round(diff / 60000))
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.round(hrs / 24)
  return `${days}d`
}

function formatFullTimestamp(iso?: string) {
  if (!iso) return undefined
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d)
  } catch {
    return iso
  }
}

function getKeyResultText(q: QueueItem): string {
  const item = q.item
  const key = (item.key ?? '').toLowerCase()
  const label = (item.label ?? '').toLowerCase()
  const why = item.why ?? ''

  if (key.includes('mfa') || label.includes('mfa')) {
    const match = item.label.match(/(\d+%)|\((\d+%)\)/) || why.match(/(\d+%)|\((\d+%)\)/)
    const pct = match ? (match[1] || match[2]) : (q.metricValue && q.metricValue !== '—' ? q.metricValue : null)
    return `MFA coverage: ${pct ?? 'Not provided'}`
  }

  if (key.includes('permission') || label.includes('permission') || why.toLowerCase().includes('missing:')) {
    const match = why.match(/missing:\s*([^.]+)/i)
    if (match && match[1]) {
      return `Missing permission: ${match[1].trim()}`
    }
    return 'Missing permissions'
  }

  if (label.includes('application') || why.toLowerCase().includes('application') || label.includes('app registration')) {
    const match = why.match(/affected:\s*([^.]+)/i) || why.match(/application\s*:?\s*([^.]+)/i)
    if (match && match[1]) {
      return `Changed application: ${match[1].trim()}`
    }
    if (why.includes('HawkView Tenant Connector') || label.includes('HawkView Tenant Connector')) {
      return 'Changed application: HawkView Tenant Connector'
    }
    return 'Changed application'
  }

  if (why.toLowerCase().includes('affected:')) {
    const match = why.match(/affected:\s*([^.]+)/i)
    if (match && match[1]) {
      return `Affected: ${match[1].trim()}`
    }
  }

  if (key.includes('risky') || label.includes('risky')) {
    if (q.metricValue && q.metricValue !== '—') {
      return `Risky users: ${q.metricValue}`
    }
    return 'Risky users: 1'
  }

  if (key.includes('connection') || label.includes('connection') || label.includes('reconnect')) {
    return 'Connection: Disconnected'
  }
  if (key.includes('authorization') || label.includes('authorization')) {
    return 'Authorization: Required'
  }

  if (key.includes('sync') || label.includes('sync')) {
    const normalizedWhy = why.toLowerCase()
    if (normalizedWhy.includes('outside the acceptable window') || normalizedWhy.includes('outside the service freshness window')) {
      return 'Collection overdue'
    }
    if (normalizedWhy.includes('awaiting execution') || normalizedWhy.includes('in progress')) {
      return 'Sync in progress'
    }
    if (normalizedWhy.includes('permission') || normalizedWhy.includes('forbidden') || normalizedWhy.includes('unauthorized')) {
      return 'Permission required'
    }
    return 'Sync needs attention'
  }

  if (why && why.length > 0 && why.length <= 45 && !why.includes('http')) {
    return why
  }

  return 'Not provided'
}

function getRecommendedThreshold(q: QueueItem): string | null {
  const why = q.item.why ?? ''
  const label = q.item.label ?? ''
  const combined = `${label} ${why}`
  const match =
    combined.match(/recommended?\s+(?:at\s+least\s+)?(\d+%)/i) ||
    combined.match(/target:\s*(\d+%)/i) ||
    combined.match(/threshold:\s*(\d+%)/i)
  if (match && match[1]) {
    return match[1]
  }
  return null
}

export function AlertDetailsModal({
  item,
  isOpen,
  onClose,
  originatingElement,
}: AlertDetailsModalProps) {
  const router = useRouter()
  const modalRef = React.useRef<HTMLDivElement>(null)
  const closeButtonRef = React.useRef<HTMLButtonElement>(null)
  const previousFocusRef = React.useRef<HTMLElement | null>(null)

  React.useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = originatingElement ?? (document.activeElement as HTMLElement)
      document.body.style.overflow = 'hidden'

      setTimeout(() => {
        closeButtonRef.current?.focus()
      }, 50)
    } else {
      document.body.style.overflow = ''
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus()
      }
    }

    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen, originatingElement])

  React.useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }

      if (e.key === 'Tab' && modalRef.current) {
        const focusables = modalRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        if (focusables.length === 0) return

        const first = focusables[0]
        const last = focusables[focusables.length - 1]

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen || !item) return null

  const labelLower = (item.item.label ?? '').toLowerCase()
  const keyLower = (item.item.key ?? '').toLowerCase()
  const whyText = item.item.why ?? ''
  const whyLower = whyText.toLowerCase()

  const isMfa = keyLower.includes('mfa') || labelLower.includes('mfa') || labelLower.includes('multi-factor')
  const isPermission = keyLower.includes('permission') || labelLower.includes('permission') || whyLower.includes('missing:')
  const isAppChange = labelLower.includes('application') || whyLower.includes('application') || labelLower.includes('app registration') || keyLower.includes('app')

  const destinationUrl = investigateDestination(
    item.item.actionUrl,
    `/tenants/${encodeURIComponent(item.tenantId)}/settings`,
  )

  let primaryActionText = 'Go fix it'
  if (isAppChange || keyLower.includes('investigate') || labelLower.includes('investigate') || (item.item.actionLabel ?? '').toLowerCase().includes('investigate')) {
    primaryActionText = 'Go investigate'
  } else if (item.item.actionLabel && (item.item.actionLabel.toLowerCase().includes('review') || item.item.actionLabel.toLowerCase().includes('fix'))) {
    primaryActionText = 'Go fix it'
  }

  const serviceName = item.provider === 'microsoft' ? 'Microsoft Entra ID' : 'Google Workspace'
  const keyResult = getKeyResultText(item)
  const fullTimestamp = formatFullTimestamp(item.detectedAt)
  const ageDisplay = formatAgeDisplay(item.detectedAt)
  const recThreshold = getRecommendedThreshold(item)

  let missingPermList: string[] = []
  if (isPermission && whyText.includes('missing:')) {
    const raw = whyText.split('missing:')[1]
    if (raw) {
      missingPermList = raw.split(',').map((s) => s.trim()).filter(Boolean)
    }
  }

  let appName: string | null = null
  if (isAppChange) {
    if (whyText.includes('HawkView Tenant Connector')) {
      appName = 'HawkView Tenant Connector'
    } else {
      const match = whyText.match(/affected:\s*([^.]+)/i) || whyText.match(/application\s*:?\s*([^.]+)/i)
      if (match && match[1]) {
        appName = match[1].trim()
      }
    }
  }

  const handlePrimaryAction = () => {
    router.push(destinationUrl)
    onClose()
  }

  const sev = item.item.severity

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-150"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Content */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="alert-modal-title"
        aria-describedby="alert-modal-description"
        className="relative w-full max-w-[720px] bg-white dark:bg-slate-900 rounded-xl shadow-xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col my-auto z-10 animate-in zoom-in-95 duration-150 focus:outline-none"
        tabIndex={-1}
      >
        {/* Severity Top Bar */}
        <div
          className={cn(
            'h-1 w-full shrink-0',
            sev === 'critical'
              ? 'bg-red-600 dark:bg-red-500'
              : sev === 'high'
              ? 'bg-amber-500 dark:bg-amber-400'
              : 'bg-blue-600 dark:bg-blue-500'
          )}
        />

        {/* Header */}
        <div className="flex items-start justify-between px-5 sm:px-6 pt-5 pb-4 border-b border-slate-200/80 dark:border-slate-800">
          <div className="space-y-1 pr-4">
            {/* Top metadata line */}
            <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
              <span
                className={cn(
                  'inline-flex items-center gap-1 font-semibold',
                  sev === 'critical'
                    ? 'text-red-700 dark:text-red-400'
                    : sev === 'high'
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-blue-700 dark:text-blue-400'
                )}
              >
                {sev === 'critical' ? (
                  <ShieldAlert className="h-3.5 w-3.5" />
                ) : sev === 'high' ? (
                  <AlertTriangle className="h-3.5 w-3.5" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                <span>{sev === 'critical' ? 'Critical' : sev === 'high' ? 'High' : 'Medium'}</span>
              </span>
              <span>·</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                {item.tenantName}
              </span>
              {item.tenantDomain ? (
                <>
                  <span>·</span>
                  <span>{item.tenantDomain}</span>
                </>
              ) : null}
            </div>

            {/* Main title */}
            <h2
              id="alert-modal-title"
              className="text-xl sm:text-[22px] font-semibold text-slate-900 dark:text-slate-100 tracking-tight leading-snug pt-1"
            >
              {item.item.label}
            </h2>

            {/* Supporting line */}
            <p className="text-xs text-slate-500 dark:text-slate-400 pt-0.5">
              {fullTimestamp ? `Detected ${fullTimestamp} · ${ageDisplay} ago` : `Unresolved for ${ageDisplay}`}
            </p>
          </div>

          <Button
            ref={closeButtonRef}
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-8 w-8 p-0 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0 focus:ring-2 focus:ring-blue-500"
            aria-label="Close alert details"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="p-5 sm:p-6 space-y-5 overflow-y-auto max-h-[calc(80vh-130px)] text-sm text-slate-700 dark:text-slate-300">
          {/* Section 1: What happened */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-slate-500 dark:text-slate-400 shrink-0" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                What happened
              </h3>
            </div>
            <div
              id="alert-modal-description"
              className="text-sm sm:text-[15px] leading-relaxed text-slate-800 dark:text-slate-200"
            >
              {isMfa ? (
                <>
                  Multi-Factor Authentication (MFA) coverage for{' '}
                  <span className="font-semibold text-slate-900 dark:text-slate-100">{item.tenantName}</span> is currently{' '}
                  <span
                    className={cn(
                      'font-semibold',
                      sev === 'critical'
                        ? 'text-red-700 dark:text-red-400'
                        : sev === 'high'
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-blue-700 dark:text-blue-400'
                    )}
                  >
                    {item.metricValue && item.metricValue !== '—' ? item.metricValue : 'below safety standards'}
                  </span>
                  . Users without enforced MFA leave directory accounts exposed to unauthorized access.
                </>
              ) : isPermission ? (
                <>
                  HawkView detected missing API permissions for the{' '}
                  <span className="font-semibold text-slate-900 dark:text-slate-100">{item.tenantName}</span> connector.
                  {missingPermList.length > 0 ? (
                    <> Required scopes missing admin consent: <code className="font-mono text-xs bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-800 dark:text-slate-200 font-semibold">{missingPermList.join(', ')}</code>.</>
                  ) : (
                    <> Certain required Entra ID Graph API scopes have not been granted admin consent.</>
                  )}
                </>
              ) : isAppChange ? (
                <>
                  An application access configuration or app registration changed in{' '}
                  <span className="font-semibold text-slate-900 dark:text-slate-100">{item.tenantName}</span>
                  {appName ? <> for <span className="font-semibold text-slate-900 dark:text-slate-100">{appName}</span></> : ''}.
                  {item.item.why ? ` ${item.item.why}` : ''}
                </>
              ) : (
                item.item.why || item.item.label
              )}
            </div>
          </div>

          {/* Section 2: Why this matters */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Why this matters
              </h3>
            </div>
            <div
              className={cn(
                'p-3.5 rounded-lg text-xs sm:text-sm leading-relaxed',
                sev === 'critical'
                  ? 'bg-red-50/70 text-red-900 dark:bg-red-950/30 dark:text-red-200'
                  : sev === 'high'
                  ? 'bg-amber-50/70 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
                  : 'bg-slate-100/70 text-slate-800 dark:bg-slate-800/60 dark:text-slate-200'
              )}
            >
              {isMfa
                ? 'Accounts without MFA registration significantly increase account-takeover risk and weaken organizational access controls against password spraying and credential stuffing attacks.'
                : isPermission
                ? 'Without the full required permission manifest, HawkView cannot accurately perform security posture evaluations, identity risk assessments, or directory monitoring.'
                : isAppChange
                ? 'Unauthorized or unexpected changes to application credentials and API permissions can grant elevated privilege levels or introduce unmonitored integration backdoors.'
                : 'Unaddressed security alerts or configuration drift undermine tenant visibility and expose organizational resources to risk.'}
            </div>
          </div>

          {/* Section 3: Evidence */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-slate-500 dark:text-slate-400 shrink-0" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Evidence
              </h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3.5 py-1 text-xs">
              <div>
                <span className="text-slate-500 dark:text-slate-400 block font-medium">Affected Service</span>
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{serviceName}</span>
              </div>

              <div>
                <span className="text-slate-500 dark:text-slate-400 block font-medium">Key Result</span>
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{keyResult}</span>
              </div>

              <div>
                <span className="text-slate-500 dark:text-slate-400 block font-medium">Current State</span>
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {isPermission ? 'Incomplete Authorization' : isAppChange ? 'Change Observed' : 'Unresolved'}
                </span>
              </div>

              <div>
                <span className="text-slate-500 dark:text-slate-400 block font-medium">Data Source</span>
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {item.provider === 'microsoft' ? 'Microsoft Entra ID Sync' : 'Google Workspace Admin API'}
                </span>
              </div>

              {fullTimestamp ? (
                <div>
                  <span className="text-slate-500 dark:text-slate-400 block font-medium">First Detected</span>
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{fullTimestamp}</span>
                </div>
              ) : null}

              {appName ? (
                <div>
                  <span className="text-slate-500 dark:text-slate-400 block font-medium">Affected Application</span>
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{appName}</span>
                </div>
              ) : null}

              {recThreshold ? (
                <div>
                  <span className="text-slate-500 dark:text-slate-400 block font-medium">Recommended Threshold</span>
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{recThreshold}</span>
                </div>
              ) : null}
            </div>
          </div>

          {/* Section 4: Recommended next step */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Recommended next step
              </h3>
            </div>
            <div className="border-l-3 border-blue-600 dark:border-blue-500 pl-3.5 py-0.5">
              <p className="text-sm sm:text-[15px] leading-relaxed text-slate-700 dark:text-slate-300">
                {isMfa
                  ? 'Review tenant security settings or Conditional Access policies to enforce MFA registration across all active users.'
                  : isPermission
                  ? 'Re-authenticate the tenant connector in HawkView and grant administrator consent for the required Entra ID API permissions.'
                  : isAppChange
                  ? 'Verify whether the application registration modification was authorized and review administrative audit logs.'
                  : 'Navigate to the tenant configuration page to remediate or investigate this finding.'}
              </p>
            </div>
          </div>
        </div>

        {/* Sticky Footer */}
        <div className="sticky bottom-0 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs border-t border-slate-200 dark:border-slate-800 p-4 sm:px-6 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2.5 sm:gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            className="h-10 px-4 text-xs sm:text-sm font-medium border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg w-full sm:w-auto"
          >
            Close
          </Button>

          <Button
            size="sm"
            onClick={handlePrimaryAction}
            className="h-10 px-5 text-xs sm:text-sm font-semibold bg-slate-900 hover:bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 rounded-lg flex items-center justify-center gap-2 focus:ring-2 focus:ring-blue-500 w-full sm:w-auto"
          >
            <span>{primaryActionText}</span>
            <ExternalLink className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
