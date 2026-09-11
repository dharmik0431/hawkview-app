'use client'

import React, { useEffect, useRef } from 'react'
import {
  Building2,
  CheckCircle2,
  Clock3,
  Info,
  ListChecks,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { FleetRiskyUserRow } from '@/lib/api/fleet-risky-users-hooks'
import {
  getUserDisplayName,
  getUserEmailOrUpn,
  mapRuleToPresentation,
} from '@/lib/identity-risk/risk-presentation-mapper'
import { findingEvidenceSummary } from '@/lib/identity-risk/presentation'

type FleetRiskAssessmentDrawerProps = {
  row: FleetRiskyUserRow | null
  isOpen: boolean
  onClose: () => void
}

function formatTimestamp(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not reported'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function getInitials(name: string, email: string): string {
  if (name && name !== 'Identity not resolved') {
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2 && parts[0][0] && parts[parts.length - 1][0]) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    }
    if (parts[0].length >= 2) {
      return parts[0].substring(0, 2).toUpperCase()
    }
  }
  if (email && email.includes('@')) {
    const cleanRef = email.split('@')[0]
    if (cleanRef.length >= 2) return cleanRef.substring(0, 2).toUpperCase()
  }
  return 'RU'
}

export function FleetRiskAssessmentDrawer({
  row,
  isOpen,
  onClose,
}: FleetRiskAssessmentDrawerProps) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    if (isOpen) {
      document.body.style.overflow = 'hidden'
      window.addEventListener('keydown', handleKeyDown)
    }
    return () => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  if (!isOpen || !row) return null

  const displayName = getUserDisplayName(row)
  const userEmail = getUserEmailOrUpn(row)

  const isHawkView = row.reasons.length > 0
  const isMicrosoft = row.detection.microsoft === 'REPORTED'
  const isBoth = isHawkView && isMicrosoft
  const isHawkViewOnly = isHawkView && !isMicrosoft

  const isUnmatchedOrPartial =
    Boolean(row.detection.because) ||
    row.detection.microsoft === 'UNAVAILABLE' ||
    row.detection.microsoft === 'NOT_COMPARABLE'

  const primaryReason = row.reasons[0]
  const primaryMapped = primaryReason
    ? mapRuleToPresentation(primaryReason.ruleId, primaryReason.signal)
    : isMicrosoft
    ? {
        ruleId: 'microsoft-entra-risk',
        plainTitle: 'Microsoft Entra ID Protection alert',
        plainExplanation:
          'Microsoft Entra ID Protection flagged active risk for this identity.',
        evidenceContext:
          'Identity Protection reported risk based on Microsoft security telemetry.',
        recommendedActions: [
          'Review the user’s recent Microsoft sign-in activity and locations.',
          'Confirm whether the attempts were expected with the user or tenant administrator.',
          'Reset the account password if unauthorized access is suspected.',
          'Verify current MFA enforcement and Conditional Access coverage.',
        ],
      }
    : {
        ruleId: 'general-review',
        plainTitle: 'Security activity needs review',
        plainExplanation:
          'HawkView found activity associated with this identity that requires investigation.',
        evidenceContext:
          'Observed security indicators require manual verification in tenant logs.',
        recommendedActions: [
          'Review recent sign-in logs and directory activity for this identity.',
          'Verify recent configuration or credential changes with the account owner.',
          'Inspect Microsoft Entra ID Protection and audit logs for context.',
        ],
      }

  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fleet-drawer-title"
    >
      {/* Backdrop */}
      <div
        ref={backdropRef}
        onClick={onClose}
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity duration-200"
      />

      {/* Slide-over panel (full screen on mobile, max 580px on tablet/desktop) */}
      <div className="fixed inset-y-0 right-0 flex w-full max-w-full sm:max-w-[580px]">
        <div
          ref={drawerRef}
          className="w-full bg-white dark:bg-slate-950 shadow-2xl flex flex-col border-l border-slate-200 dark:border-slate-800 transition-all"
        >
          {/* 1. Identity Header */}
          <div className="p-5 sm:p-6 border-b border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-950 sticky top-0 z-10">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-bold text-base border border-slate-200 dark:border-slate-700 shadow-2xs">
                  {getInitials(displayName, userEmail)}
                </div>
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <h2
                      id="fleet-drawer-title"
                      className="text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100 truncate"
                    >
                      {displayName}
                    </h2>
                    {isHawkView && (
                      <Badge
                        variant="secondary"
                        className="bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 font-medium text-xs px-2 py-0.5 shrink-0"
                      >
                        HawkView
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-slate-500 dark:text-slate-400 font-normal truncate">
                    {userEmail}
                  </p>
                  <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 pt-0.5">
                    <Building2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                    <span className="font-medium truncate">{row.tenantName}</span>
                    {row.tenantDomain && row.tenantDomain !== row.tenantName && (
                      <span className="text-slate-400 font-normal truncate">
                        ({row.tenantDomain})
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-9 w-9 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0 -mr-1 -mt-1"
                aria-label="Close drawer"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
          </div>

          {/* Drawer Body */}
          <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6 text-slate-800 dark:text-slate-200">
            {/* 2. Review Summary */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 border-l-4 border-l-blue-500 dark:border-l-blue-500 p-5 space-y-4 shadow-2xs">
              {/* Header Row */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="p-1 rounded-md bg-blue-100/80 dark:bg-blue-950 text-blue-600 dark:text-blue-400">
                    <ShieldAlert className="h-4 w-4" />
                  </div>
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Why this user needs review
                  </span>
                </div>
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {isBoth
                    ? 'Detected by HawkView & Microsoft'
                    : isHawkViewOnly
                    ? 'Detected by HawkView'
                    : isMicrosoft
                    ? 'Detected by Microsoft'
                    : 'Requires Review'}
                </span>
              </div>

              {/* Primary Reason */}
              <div className="space-y-1">
                <h3 className="text-base sm:text-lg font-semibold text-slate-900 dark:text-slate-100 leading-snug">
                  {primaryMapped.plainTitle}
                </h3>
                <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  {primaryMapped.plainExplanation}
                </p>
              </div>

              {/* Microsoft Status Row */}
              <div className="pt-3 border-t border-slate-200/80 dark:border-slate-800/80 space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200">
                  <ShieldCheck className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
                  <span>
                    {isMicrosoft
                      ? 'Active risk reported by Microsoft Entra ID Protection'
                      : row.detection.microsoft === 'UNAVAILABLE'
                      ? 'Microsoft Entra risk data unavailable'
                      : 'No active Microsoft risk reported'}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  {isMicrosoft
                    ? 'Microsoft Entra ID Protection has flagged an active risk event for this user.'
                    : row.detection.microsoft === 'UNAVAILABLE'
                    ? 'Microsoft Entra ID Protection risk telemetry could not be retrieved for this tenant.'
                    : 'This means Microsoft currently has no active risk record for this identity. It does not confirm that the account is safe.'}
                </p>
              </div>
            </div>

            {/* 3. Findings Section Header & Items */}
            <div className="space-y-3 pt-2 border-t border-slate-200/80 dark:border-slate-800">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 sm:gap-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-slate-700 dark:text-slate-300 shrink-0" />
                  <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                    Findings
                  </h3>
                  <Badge
                    variant="secondary"
                    className="bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 font-semibold text-xs px-2 py-0.5 rounded-md shrink-0"
                  >
                    {row.reasons.length}
                  </Badge>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 font-normal whitespace-nowrap">
                  Latest evidence · {formatTimestamp(row.lastSeen)}
                </div>
              </div>

              {row.reasons.length === 0 ? (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 text-xs text-slate-600 dark:text-slate-400 bg-slate-50/50 dark:bg-slate-900/40 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                  <span>No active HawkView detector rules triggered for this user.</span>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 sm:p-5 shadow-2xs space-y-4">
                  {row.reasons.map((reason, idx) => {
                    const mapped = mapRuleToPresentation(reason.ruleId, reason.signal)
                    const summary = findingEvidenceSummary(reason, (d) => formatTimestamp(d))
                    const isStateObserved = reason.kind === 'STATE_OBSERVED'

                    let countText = summary.count
                    if (countText && countText.toLowerCase().includes('lockout')) {
                      countText = countText
                        .replace(/lockouts/gi, 'matching events')
                        .replace(/lockout/gi, 'matching event')
                    }

                    const showExtraContext =
                      Boolean(mapped.evidenceContext) &&
                      mapped.evidenceContext !== mapped.plainExplanation &&
                      !mapped.plainExplanation.includes(mapped.evidenceContext)

                    return (
                      <div
                        key={idx}
                        className="pt-4 first:pt-0 border-t border-slate-100 dark:border-slate-800/80 first:border-t-0 space-y-2.5"
                      >
                        {/* Timeline item top row */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2.5 min-w-0">
                            <div className="mt-1 h-2 w-2 rounded-full bg-blue-500 shrink-0" />
                            <div className="min-w-0">
                              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                                {mapped.plainTitle}
                              </h4>
                              <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5 leading-relaxed">
                                {mapped.plainExplanation}
                              </p>
                              {showExtraContext && (
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                                  {mapped.evidenceContext}
                                </p>
                              )}
                            </div>
                          </div>
                          {countText && (
                            <Badge
                              variant="secondary"
                              className="text-2xs font-medium bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 shrink-0 border-0"
                            >
                              {countText}
                            </Badge>
                          )}
                        </div>

                        {/* Metadata line */}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400 pl-4.5">
                          <span className="flex items-center gap-1 font-normal">
                            <Clock3 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                            <span>
                              {isStateObserved
                                ? `Configuration read · ${formatTimestamp(reason.lastSeen)}`
                                : `Last observed · ${formatTimestamp(reason.lastSeen)}`}
                            </span>
                          </span>
                          <span className="text-slate-300 dark:text-slate-700">•</span>
                          <span className="flex items-center gap-1 font-normal">
                            <ShieldCheck className="h-3.5 w-3.5 text-blue-500 dark:text-blue-400 shrink-0" />
                            <span>Detected by HawkView</span>
                          </span>
                        </div>

                        {/* Collapsed Technical Details Disclosure */}
                        <div className="pl-4.5 pt-0.5">
                          <details className="group">
                            <summary className="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer select-none inline-flex items-center gap-1">
                              Technical details
                            </summary>
                            <div className="mt-2 p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 text-xs font-mono space-y-1.5 text-slate-700 dark:text-slate-300">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-slate-500 font-sans font-medium">Rule code:</span>
                                <span className="truncate">{reason.ruleId}</span>
                              </div>
                              {reason.signal && (
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-slate-500 font-sans font-medium">Signal:</span>
                                  <span className="truncate">{reason.signal}</span>
                                </div>
                              )}
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-slate-500 font-sans font-medium">Evidence count:</span>
                                <span>{reason.evidenceCount}</span>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-slate-500 font-sans font-medium">Evidence kind:</span>
                                <span>{reason.kind || 'EVENT_OCCURRED'}</span>
                              </div>
                            </div>
                          </details>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* 4. Recommended Next Steps */}
            <div className="space-y-3 pt-2 border-t border-slate-200/80 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <div className="p-1 rounded-md bg-blue-100/80 dark:bg-blue-950 text-blue-600 dark:text-blue-400">
                  <ListChecks className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                    Recommended next steps
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Suggested investigation and remediation steps for your team.
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 divide-y divide-slate-100 dark:divide-slate-800/80 shadow-2xs">
                {primaryMapped.recommendedActions.map((stepText, idx) => (
                  <div key={idx} className="flex items-start gap-3 p-3.5 text-xs text-slate-800 dark:text-slate-200">
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-semibold mt-0.5">
                      {idx + 1}
                    </div>
                    <p className="text-xs sm:text-sm text-slate-800 dark:text-slate-200 leading-relaxed font-normal">
                      {stepText}
                    </p>
                  </div>
                ))}
              </div>

              <div className="flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400 pt-1">
                <Info className="h-3.5 w-3.5 text-slate-400 shrink-0 mt-0.5" />
                <span>
                  HawkView provides investigation guidance. Account changes must be completed in Microsoft 365 or Exchange Online.
                </span>
              </div>
            </div>

            {/* 5. Evidence & Data Status */}
            <div className="space-y-3 pt-2 border-t border-slate-200/80 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <div className="p-1 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                  <Info className="h-4 w-4" />
                </div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Evidence and data status
                </h3>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 p-4 space-y-3 shadow-2xs">
                {/* Row 1: HawkView evidence */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 pb-3 border-b border-slate-200/80 dark:border-slate-800">
                  <div>
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 block">
                      HawkView evidence
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      Evaluated · {formatTimestamp(row.lastSeen)}
                    </span>
                  </div>
                  <Badge
                    variant="outline"
                    className="text-2xs font-medium bg-emerald-50 text-emerald-800 border-emerald-200/80 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-900/80 self-start sm:self-auto shrink-0"
                  >
                    {row.lastSeenState === 'DATED' ? 'Current evidence' : 'Dateless evidence'}
                  </Badge>
                </div>

                {/* Row 2: Microsoft Entra risk */}
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 pb-3 border-b border-slate-200/80 dark:border-slate-800">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 block">
                      Microsoft Entra risk
                    </span>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      {isMicrosoft
                        ? 'Microsoft Entra ID Protection has flagged an active risk record for this identity.'
                        : isUnmatchedOrPartial
                        ? 'Microsoft risk coverage for this identity may be incomplete or unavailable.'
                        : 'Microsoft currently has no active risk record for this identity. This does not confirm the account is safe.'}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={`text-2xs font-medium self-start sm:self-auto shrink-0 ${
                      isMicrosoft
                        ? 'bg-purple-50 text-purple-800 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-900'
                        : isUnmatchedOrPartial
                        ? 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900'
                        : 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
                    }`}
                  >
                    {isMicrosoft
                      ? 'Active risk reported'
                      : isUnmatchedOrPartial
                      ? 'Partial coverage'
                      : 'No active risk reported'}
                  </Badge>
                </div>

                {/* Unmatched / Partial coverage notice */}
                {isUnmatchedOrPartial && (
                  <div className="rounded-lg bg-amber-50/80 dark:bg-amber-950/40 p-3 border border-amber-200/80 dark:border-amber-900/60 space-y-1 text-xs">
                    <div className="flex items-center gap-1.5 font-semibold text-amber-900 dark:text-amber-200">
                      <ShieldOff className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                      <span>Some Microsoft records could not be matched</span>
                    </div>
                    <p className="text-amber-800 dark:text-amber-300 leading-relaxed">
                      Microsoft risk coverage for this identity may be incomplete.
                      {row.detection.because && ` ${row.detection.because}`}
                    </p>
                  </div>
                )}

                {/* How detection works disclosure */}
                <div className="pt-0.5">
                  <details className="group">
                    <summary className="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer select-none inline-flex items-center gap-1">
                      How detection works
                    </summary>
                    <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      HawkView findings and Microsoft Entra risk detections are independent signals. Microsoft coverage also depends on tenant licensing, permissions, collection freshness, and identity matching.
                    </p>
                  </details>
                </div>
              </div>
            </div>
          </div>

          {/* Drawer Footer */}
          <div className="p-4 border-t border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 flex justify-end shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              className="h-9 px-5 text-xs font-semibold text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
