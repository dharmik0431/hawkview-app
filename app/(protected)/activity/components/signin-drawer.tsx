'use client'

import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Copy,
  Check,
  X,
  Shield,
  Activity,
  User,
  Laptop,
  Info,
} from 'lucide-react'
import type { SignInEvent, AuditEvent } from '../data/types'

function fmtLocal(iso?: string) {
  if (!iso) return 'Not reported'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return 'Not reported'
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  })
}

function fmtUTC(iso?: string) {
  if (!iso) return 'Not reported'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return 'Not reported'
  return date.toISOString().replace('T', ' ').replace('Z', ' UTC').slice(0, 23)
}

function CopyButton({ text, label }: { text?: string; label?: string }) {
  const [copied, setCopied] = React.useState(false)

  if (!text) return null

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard?.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
      aria-label={copied ? 'Copied' : `Copy ${label || text}`}
      title={copied ? 'Copied!' : `Copy ${label || text}`}
      className="inline-flex items-center gap-1 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  )
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon?: React.ElementType
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 pb-1 border-b border-slate-200 dark:border-slate-800">
        {Icon ? (
          <Icon className="h-4 w-4 text-slate-500 dark:text-slate-400" />
        ) : null}
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">
          {title}
        </h3>
      </div>
      <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
        {children}
      </div>
    </div>
  )
}

function DataRow({
  label,
  value,
  copyable = false,
  breakAll = false,
  children,
}: {
  label: string
  value?: string | number | null
  copyable?: boolean
  breakAll?: boolean
  children?: React.ReactNode
}) {
  const displayVal =
    value !== undefined && value !== null ? String(value) : undefined

  return (
    <div className="py-2.5 flex flex-col sm:flex-row sm:items-start justify-between gap-1 sm:gap-4 text-xs sm:text-sm">
      <span className="text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0 sm:w-1/3 pt-0.5">
        {label}
      </span>
      <div className="sm:w-2/3 flex items-center justify-between gap-2 min-w-0">
        {children ? (
          children
        ) : (
          <span
            className={[
              'font-medium text-slate-900 dark:text-slate-100 min-w-0',
              breakAll ? 'break-all' : 'break-words',
            ].join(' ')}
          >
            {displayVal || 'Not reported'}
          </span>
        )}
        {copyable && displayVal && displayVal !== 'Not reported' ? (
          <CopyButton text={displayVal} label={label} />
        ) : null}
      </div>
    </div>
  )
}

export function SignInDrawer({
  open,
  event,
  onClose,
}: {
  open: boolean
  event: SignInEvent | AuditEvent | null
  onClose: () => void
}) {
  const [mounted, setMounted] = React.useState(false)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const closeButtonRef = React.useRef<HTMLButtonElement>(null)
  const previousFocusRef = React.useRef<HTMLElement | null>(null)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  React.useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return

      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusables.length === 0) {
        e.preventDefault()
        panelRef.current.focus()
        return
      }

      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [open, onClose])

  if (!mounted || !open) return null

  const isAudit = Boolean(event && ('activity' in event || 'actor' in event))
  const signInEv = !isAudit ? (event as SignInEvent | null) : null
  const auditEv = isAudit ? (event as AuditEvent | null) : null

  const reportedResult = event
    ? String((event as any).result ?? (event as any).status ?? 'Not reported')
    : 'Not reported'
  const isSuccess = reportedResult.toLowerCase() === 'success'
  const isResultReported = reportedResult.toLowerCase() !== 'not reported'

  return (
    <>
      {/* Backdrop */}
      <div
        className={[
          'fixed inset-0 z-40 bg-black/50 backdrop-blur-xs transition-opacity duration-200',
          'opacity-100',
        ].join(' ')}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={[
          'fixed inset-y-0 right-0 z-50 w-full sm:w-[560px] md:w-[600px] max-w-full bg-background border-l border-border shadow-2xl',
          'transition-transform duration-200 ease-out flex flex-col',
          'translate-x-0',
        ].join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={isAudit ? 'Audit Event Details' : 'Sign-in Details'}
      >
        {/* Header */}
        <div className="p-5 border-b border-border bg-slate-50/50 dark:bg-slate-900/50 shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {isAudit ? 'Audit Event Details' : 'Sign-in Details'}
                </span>
                {isAudit ? (
                  <Badge
                    variant={isSuccess ? 'outline' : isResultReported ? 'destructive' : 'secondary'}
                    className={
                      isSuccess
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-800'
                        : ''
                    }
                  >
                    {auditEv?.result || 'Not reported'}
                  </Badge>
                ) : (
                  <Badge
                    variant={isSuccess ? 'outline' : isResultReported ? 'destructive' : 'secondary'}
                    className={
                      isSuccess
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-800'
                        : ''
                    }
                  >
                    {signInEv?.status || 'Not reported'}
                  </Badge>
                )}
                {signInEv?.conditionalAccess ? (
                  <Badge
                    variant="secondary"
                    className="bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-950/50 dark:text-blue-400 dark:border-blue-800"
                  >
                    CA: {signInEv.conditionalAccess}
                  </Badge>
                ) : null}
              </div>

              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 break-words">
                {isAudit
                  ? auditEv?.activity
                  : signInEv?.userDisplayName || signInEv?.userPrincipalName}
              </h2>

              <div className="text-xs text-slate-500 dark:text-slate-400">
                {fmtLocal(event?.createdAt)}
              </div>
            </div>

            <Button
              ref={closeButtonRef}
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-8 w-8 rounded-full text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 shrink-0"
              aria-label="Close details drawer"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Microsoft Event ID banner. Internal row keys are never evidence. */}
          {event ? (
            <div className="mt-3 pt-3 border-t border-slate-200/60 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span className="font-mono text-[11px] truncate mr-2">
                Event ID: {event.eventId ?? 'Not reported'}
              </span>
              {event.eventId ? (
                <CopyButton text={event.eventId} label="Event ID" />
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {!event ? (
            <div className="py-12 text-center text-sm text-slate-500">
              Select an event to inspect investigation details.
            </div>
          ) : isAudit && auditEv ? (
            /* AUDIT EVENT SECTIONS */
            <>
              {/* 1. Activity */}
              <Section title="Activity" icon={Activity}>
                <DataRow label="Activity Name" value={auditEv.activity} />
                <DataRow label="Category" value={auditEv.category} />
                <DataRow
                  label="Service"
                  value={auditEv.service || auditEv.operationType}
                />
                <DataRow label="Result" value={auditEv.result} />
                {auditEv.resultReason ? (
                  <DataRow label="Result Reason" value={auditEv.resultReason} />
                ) : null}
              </Section>

              {/* 2. Actor */}
              <Section title="Actor" icon={User}>
                <DataRow label="Performed By" value={auditEv.actor} />
                {auditEv.actorPrincipalName ? (
                  <DataRow
                    label="Principal Name"
                    value={auditEv.actorPrincipalName}
                    copyable
                    breakAll
                  />
                ) : null}
                <DataRow label="Actor Type" value={auditEv.actorType} />
                {auditEv.actorId ? (
                  <DataRow
                    label="Actor ID"
                    value={auditEv.actorId}
                    copyable
                    breakAll
                  />
                ) : null}
              </Section>

              {/* 3. Target */}
              <Section title="Target" icon={Shield}>
                <DataRow label="Target Name" value={auditEv.target} breakAll />
                {auditEv.targetType ? (
                  <DataRow label="Target Type" value={auditEv.targetType} />
                ) : null}
                {auditEv.targetId ? (
                  <DataRow
                    label="Target ID"
                    value={auditEv.targetId}
                    copyable
                    breakAll
                  />
                ) : null}

                {auditEv.targetResources &&
                auditEv.targetResources.length > 1 ? (
                  <div className="py-2.5 space-y-1.5 border-t border-slate-100 dark:border-slate-800">
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                      All Affected Targets ({auditEv.targetResources.length})
                    </span>
                    <ul className="space-y-1 pl-3 text-xs text-slate-700 dark:text-slate-300 list-disc">
                      {auditEv.targetResources.map((t: any, idx: number) => (
                        <li key={idx} className="break-all">
                          {t.displayName ||
                            t.userPrincipalName ||
                            t.id ||
                            `Target ${idx + 1}`}
                          {t.type ? ` (${t.type})` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </Section>

              {/* 4. Changes */}
              {auditEv.modifiedProperties &&
              auditEv.modifiedProperties.length > 0 ? (
                <Section title="Changes" icon={Info}>
                  <div className="py-2 space-y-2">
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                      Modified Properties ({auditEv.modifiedProperties.length})
                    </span>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Property values are not displayed because Microsoft audit
                      payloads may contain credentials or other sensitive data.
                    </p>
                    <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden text-xs">
                      <table className="w-full text-left border-collapse">
                        <thead className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-semibold">
                          <tr>
                            <th className="p-2 border-b border-slate-200 dark:border-slate-800">
                              Property
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono text-[11px]">
                          {auditEv.modifiedProperties.map((prop, idx) => (
                            <tr
                              key={idx}
                              className="hover:bg-slate-50 dark:hover:bg-slate-900/50"
                            >
                              <td className="p-2 font-medium font-sans text-slate-900 dark:text-slate-100">
                                {prop.name}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </Section>
              ) : null}

              {/* 5. Technical details */}
              <Section title="Technical Details" icon={Info}>
                <DataRow
                  label="Event ID"
                  value={auditEv.eventId ?? 'Not reported'}
                  copyable={Boolean(auditEv.eventId)}
                  breakAll
                />
                {auditEv.correlationId ? (
                  <DataRow
                    label="Correlation ID"
                    value={auditEv.correlationId}
                    copyable
                    breakAll
                  />
                ) : null}
                {auditEv.tenantName ? (
                  <DataRow label="Tenant Name" value={auditEv.tenantName} />
                ) : null}
                {auditEv.tenantId ? (
                  <DataRow
                    label="Tenant ID"
                    value={auditEv.tenantId}
                    copyable
                    breakAll
                  />
                ) : null}
                <DataRow
                  label="Original UTC Time"
                  value={fmtUTC(auditEv.createdAt)}
                  copyable
                />
              </Section>
            </>
          ) : signInEv ? (
            /* SIGN-IN EVENT SECTIONS */
            <>
              {/* 1. Identity */}
              <Section title="Identity" icon={User}>
                <DataRow
                  label="Display Name"
                  value={signInEv.userDisplayName}
                />
                <DataRow
                  label="Principal Name"
                  value={signInEv.userPrincipalName}
                  copyable
                  breakAll
                />
                {signInEv.userId ? (
                  <DataRow
                    label="User ID"
                    value={signInEv.userId}
                    copyable
                    breakAll
                  />
                ) : null}
                {signInEv.tenantName ? (
                  <DataRow label="Tenant Name" value={signInEv.tenantName} />
                ) : null}
                {signInEv.tenantId ? (
                  <DataRow
                    label="Tenant ID"
                    value={signInEv.tenantId}
                    copyable
                    breakAll
                  />
                ) : null}
              </Section>

              {/* 2. Application */}
              <Section title="Application" icon={Activity}>
                <DataRow
                  label="Application Name"
                  value={signInEv.appDisplayName}
                />
                {signInEv.appId ? (
                  <DataRow
                    label="App / Client ID"
                    value={signInEv.appId}
                    copyable
                    breakAll
                  />
                ) : null}
                {signInEv.clientAppUsed ? (
                  <DataRow label="Client App" value={signInEv.clientAppUsed} />
                ) : null}
              </Section>

              {/* 3. Result and access */}
              <Section title="Result & Access" icon={Shield}>
                <DataRow label="Sign-in Status" value={signInEv.status} />
                {signInEv.errorCode ? (
                  <DataRow
                    label="Error Code"
                    value={signInEv.errorCode}
                    copyable
                  />
                ) : null}
                {signInEv.failureReason ? (
                  <DataRow
                    label="Failure Reason"
                    value={signInEv.failureReason}
                  />
                ) : null}
                {signInEv.additionalDetails ? (
                  <DataRow
                    label="Additional Details"
                    value={signInEv.additionalDetails}
                  />
                ) : null}
                <DataRow
                  label="Conditional Access"
                  value={signInEv.conditionalAccess || 'Not reported'}
                />
                {signInEv.appliedCaPolicies &&
                signInEv.appliedCaPolicies.length > 0 ? (
                  <DataRow label="Applied Policies">
                    <div className="flex flex-wrap gap-1">
                      {signInEv.appliedCaPolicies.map((pol, idx) => (
                        <Badge key={idx} variant="outline" className="text-xs">
                          {pol}
                        </Badge>
                      ))}
                    </div>
                  </DataRow>
                ) : null}
                {signInEv.authMethod ? (
                  <DataRow
                    label="Auth Requirement"
                    value={signInEv.authMethod}
                  />
                ) : null}
              </Section>

              {/* 4. Device and network */}
              <Section title="Device & Network" icon={Laptop}>
                <DataRow
                  label="IP Address"
                  value={signInEv.ipAddress}
                  copyable
                />
                <DataRow label="Location" value={signInEv.location} />
                {signInEv.country ? (
                  <DataRow label="Country/Region" value={signInEv.country} />
                ) : null}
                {signInEv.device ? (
                  <DataRow
                    label="Device Name / ID"
                    value={signInEv.device}
                    copyable
                  />
                ) : null}
                {signInEv.os ? (
                  <DataRow label="Operating System" value={signInEv.os} />
                ) : null}
                {signInEv.browser ? (
                  <DataRow label="Browser" value={signInEv.browser} />
                ) : null}
                {signInEv.managedState ? (
                  <DataRow
                    label="Managed State"
                    value={signInEv.managedState}
                  />
                ) : null}
                {signInEv.userAgent ? (
                  <div className="py-2 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                        User Agent
                      </span>
                      <CopyButton
                        text={signInEv.userAgent}
                        label="User Agent"
                      />
                    </div>
                    <pre className="p-2 rounded bg-slate-100 dark:bg-slate-800/80 text-[11px] font-mono break-all whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                      {signInEv.userAgent}
                    </pre>
                  </div>
                ) : null}
              </Section>

              {/* 5. Technical details */}
              <Section title="Technical Details" icon={Info}>
                {signInEv.correlationId ? (
                  <DataRow
                    label="Correlation ID"
                    value={signInEv.correlationId}
                    copyable
                    breakAll
                  />
                ) : null}
                {signInEv.requestId ? (
                  <DataRow
                    label="Request ID"
                    value={signInEv.requestId}
                    copyable
                    breakAll
                  />
                ) : null}
                {signInEv.riskLevel ? (
                  <DataRow label="Risk Level" value={signInEv.riskLevel} />
                ) : null}
                <DataRow
                  label="Original UTC Time"
                  value={fmtUTC(signInEv.createdAt)}
                  copyable
                />
              </Section>
            </>
          ) : null}

          {/* Raw backend objects are intentionally never exposed in beta. */}
          {event ? (
            <div className="flex justify-end border-t border-slate-200 pt-4 dark:border-slate-800">
              <Button type="button" variant="default" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}
