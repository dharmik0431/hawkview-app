'use client'

import { useEffect, useRef } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileSearch,
  ShieldCheck,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  findingEvidenceShape,
  findingEvidenceSummary,
  riskConditionalAccessIsCurrent,
  riskProtectionEvidenceIsCurrent,
  riskProtectionSummary,
  riskRecommendedActionLabel,
  riskSourceLabel,
} from '@/lib/identity-risk/presentation'
import type {
  RiskAssessmentFinding,
  RiskAssessmentUser,
} from '@/lib/identity-risk/types'

function formatTimestamp(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not reported'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function priorityClass(priority: RiskAssessmentFinding['priority']) {
  if (priority === 'HIGH')
    return 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-300'
  if (priority === 'MEDIUM')
    return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
  return 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300'
}

function eventProtectionLabel(value: RiskAssessmentFinding['eventProtection']) {
  if (value === 'MFA_SATISFIED') return 'MFA satisfied for this event'
  if (value === 'BLOCKED_BY_POLICY') return 'Blocked by policy'
  return 'Event protection not reported'
}

function words(value: string) {
  return value.toLowerCase().replaceAll('_', ' ')
}

function protectionSourceLabel(source: string) {
  if (source === 'MICROSOFT_GRAPH') return 'Microsoft Graph'
  if (source === 'EFFECTIVE_MFA_V1') return 'Effective MFA evaluator v1'
  return 'Not reported'
}

function protectionReasonLabel(reason: string) {
  const labels: Readonly<Record<string, string>> = {
    VERIFIED: 'Verified from current evidence',
    NOT_REPORTED: 'Not reported',
    STALE: 'Evidence is stale',
    FAILED: 'Collection failed',
    MISSING_PERMISSION: 'Permission required',
    INCOMPLETE: 'Evidence is incomplete',
    EVIDENCE_INCOMPLETE: 'Evidence is incomplete',
    CAPACITY_LIMIT: 'Evidence capacity limit reached',
    INVALID_PROTECTION_INPUT: 'Protection evidence could not be evaluated',
    EXTERNAL_TENANT_UNKNOWN: 'External tenant coverage is unknown',
    EFFECTIVE_EXCLUSION: 'An effective policy exclusion applies',
    NOT_TARGETED: 'The policy does not target this identity',
    AUTHENTICATION_STRENGTH_NOT_RESOLVED:
      'Authentication strength was not resolved',
    AUTHENTICATION_STRENGTH_AMBIGUOUS: 'Authentication strength is ambiguous',
    TARGET_EVALUATION_UNKNOWN: 'Policy targeting is unknown',
    GRANT_EVALUATION_UNKNOWN: 'Policy grant evaluation is unknown',
    POLICY_SHAPE_UNKNOWN: 'Policy configuration is unsupported',
    MATERIAL_CONDITIONS_PRESENT: 'Policy coverage depends on conditions',
    REPORT_ONLY_NOT_ENFORCED: 'Report-only policies do not enforce MFA',
    NO_UNIVERSAL_MFA_POLICY: 'No universal MFA policy was found',
  }
  if (Object.hasOwn(labels, reason)) return labels[reason]
  const evidenceReason =
    /^(POLICIES|MEMBERSHIP|ROLES|AUTHENTICATION_STRENGTHS)_(FRESH|STALE|MISSING|FAILED|PERMISSION_LIMITED)$/.exec(
      reason
    )
  return evidenceReason
    ? `${words(evidenceReason[1])}: ${words(evidenceReason[2])}`
    : 'Evidence limitation reported'
}

function conditionalAccessLabel(
  value: RiskAssessmentUser['protection']['conditionalAccess']
) {
  if (!riskConditionalAccessIsCurrent(value))
    return 'Coverage not verified from current evidence'
  const labels: Readonly<Record<typeof value.status, string>> = {
    COVERED_BY_CONDITIONAL_ACCESS: 'MFA required by Conditional Access',
    CONDITIONALLY_COVERED: 'MFA coverage depends on policy conditions',
    REPORT_ONLY: 'Report-only; MFA is not enforced by these policies',
    NOT_COVERED: 'No enforced Conditional Access MFA coverage reported',
    UNKNOWN: 'Coverage not verified',
  }
  return labels[value.status]
}

function ProtectionEvidenceDetail({
  label,
  evidence,
}: {
  label: string
  evidence: RiskAssessmentUser['protection'][
    | 'securityDefaults'
    | 'legacyPerUserMfa'
    | 'registration']
}) {
  const current = riskProtectionEvidenceIsCurrent(evidence)
  return (
    <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
      <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        {label}
      </h4>
      <p className="mt-1 text-sm font-medium capitalize text-slate-800 dark:text-slate-200">
        {current ? words(evidence.state) : 'Not verified from current evidence'}
      </p>
      <dl className="mt-2 space-y-1 text-xs text-slate-600 dark:text-slate-300">
        <div>
          <dt className="inline">Source: </dt>
          <dd className="inline">{protectionSourceLabel(evidence.source)}</dd>
        </div>
        <div>
          <dt className="inline">Observed: </dt>
          <dd className="inline">{formatTimestamp(evidence.observedAt)}</dd>
        </div>
        <div>
          <dt className="inline">Freshness: </dt>
          <dd className="inline capitalize">{words(evidence.freshness)}</dd>
        </div>
        <div>
          <dt className="inline">Reason: </dt>
          <dd className="inline">
            {protectionReasonLabel(evidence.reasonCode)}
          </dd>
        </div>
      </dl>
    </div>
  )
}

function FindingDetail({ finding }: { finding: RiskAssessmentFinding }) {
  return (
    <article className="border-t border-slate-200 py-5 first:border-t-0 first:pt-0 dark:border-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {finding.ruleId} · {finding.ruleVersion}
          </div>
          <h3 className="mt-1 text-base font-semibold text-slate-950 dark:text-slate-50">
            {finding.title}
          </h3>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className={priorityClass(finding.priority)}>
            {finding.priority.toLowerCase()} priority
          </Badge>
          <Badge variant="outline">
            {finding.activityState === 'CURRENT'
              ? 'Current'
              : finding.activityState === 'HISTORICAL'
                ? 'Historical'
                : 'Activity timing unknown'}
          </Badge>
        </div>
      </div>

      <p className="mt-3 text-sm leading-6 text-slate-700 dark:text-slate-300">
        {finding.explanation}
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-slate-500 dark:text-slate-400">
            First evidence time
          </dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {formatTimestamp(finding.firstSeen)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">
            Last evidence time
          </dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {formatTimestamp(finding.lastSeen)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">
            Evaluation time
          </dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {formatTimestamp(finding.evaluatedAt)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">
            Activity window ends
          </dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {formatTimestamp(finding.activityWindowEndsAt)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">
            Evidence window starts
          </dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {formatTimestamp(finding.window.start)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">
            Evidence window ends
          </dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {formatTimestamp(finding.window.end)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">
            Selected source
          </dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {riskSourceLabel(finding.selectedSource)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Evidence</dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {findingEvidenceSummary(finding, formatTimestamp).count ??
              finding.evidenceCount.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Confidence</dt>
          <dd className="mt-0.5 font-medium capitalize text-slate-900 dark:text-slate-100">
            {finding.confidence.toLowerCase()}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Application</dt>
          <dd className="mt-0.5 break-words font-medium text-slate-900 dark:text-slate-100">
            {finding.application.state === 'RESOLVED' &&
            finding.application.label
              ? finding.application.label
              : 'Not reported'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Device</dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {finding.device.state === 'INSUFFICIENT_FIELDS'
              ? 'Insufficient fields'
              : 'Not reported'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">
            Client source reference
          </dt>
          <dd className="mt-0.5 break-all font-medium text-slate-900 dark:text-slate-100">
            {finding.clientSource.qualification === 'QUALIFIED' &&
            finding.clientSource.reference ? (
              <code>{finding.clientSource.reference}</code>
            ) : finding.clientSource.qualification === 'INSUFFICIENT_FIELDS' ? (
              'Insufficient fields'
            ) : (
              'Not reported'
            )}
          </dd>
        </div>
      </dl>

      <EvidenceReadingCaveat finding={finding} />

      {finding.evidenceReferences.length > 0 && (
        <div className="mt-4">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Evidence references
          </h4>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
            Evidence time records the activity; ingestion time records when it
            reached HawkView. Evaluation time records when the check ran.
          </p>
          <ul className="mt-2 space-y-2">
            {finding.evidenceReferences.map((evidence) => (
              <li
                key={evidence.id}
                className="rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-900"
              >
                <code className="break-all text-slate-700 dark:text-slate-200">
                  {evidence.id}
                </code>
                <dl className="mt-1.5 space-y-1 text-slate-600 dark:text-slate-300">
                  <div>
                    <dt className="inline">Evidence time: </dt>
                    <dd className="inline">
                      {formatTimestamp(evidence.recordedAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline">Ingestion time: </dt>
                    <dd className="inline">
                      {formatTimestamp(evidence.ingestedAt)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
        {finding.eventProtection === 'NOT_REPORTED' ? (
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-slate-500"
            aria-hidden="true"
          />
        ) : (
          <ShieldCheck
            className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
            aria-hidden="true"
          />
        )}
        <span>{eventProtectionLabel(finding.eventProtection)}</span>
      </div>

      {finding.caveats.length > 0 && (
        <div className="mt-4">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Evidence limits
          </h4>
          <ul className="mt-2 space-y-1.5 text-sm text-slate-600 dark:text-slate-300">
            {finding.caveats.map((caveat) => (
              <li key={caveat}>• {caveat}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <FileSearch className="h-4 w-4 text-blue-600" aria-hidden="true" />
          Suggested MSP actions
        </h4>
        {finding.recommendedActions.length > 0 ? (
          <ol className="mt-2 space-y-2 text-sm text-slate-700 dark:text-slate-300">
            {finding.recommendedActions.map((action, index) => (
              <li key={action.code} className="flex gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
                  {index + 1}
                </span>
                <span>{riskRecommendedActionLabel(action.code)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            No specific action was reported.
          </p>
        )}
      </div>
    </article>
  )
}

/**
 * What a technician does next, if they conclude the account is compromised.
 *
 * Three things this is deliberately not.
 *
 * It is not per-rule. HawkView's detectors know that something looks worth
 * reviewing; they do not know the remedy, and attaching containment steps to a
 * specific rule would imply the rule had determined them. This is the response
 * procedure for a compromised account, which is the same whichever finding
 * raised the question.
 *
 * It is not an instruction. Every other sentence on this surface says these are
 * investigation leads and not confirmed compromise. "Disable the account" would
 * undo that in one line, so the guidance is conditional throughout and
 * attributed to Microsoft rather than issued by HawkView.
 *
 * It is not actionable from here. No buttons, no links that do anything.
 * HawkView reads; the technician acts in Microsoft's own tools.
 */
function ContainmentGuidance({ user }: { user: RiskAssessmentUser }) {
  const mailbox = user.subjectType === 'MAILBOX'
  return (
    <details className="mt-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <summary className="cursor-pointer text-sm font-semibold text-slate-900 dark:text-slate-50">
        {mailbox
          ? 'If you confirm this mailbox has been tampered with'
          : 'If you confirm this account is compromised'}
      </summary>
      <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
        Nothing above establishes compromise, and this is not HawkView
        recommending that you act. It is Microsoft&rsquo;s documented response
        procedure, summarised so it is to hand if your own investigation
        concludes the {mailbox ? 'mailbox' : 'account'} was misused. HawkView
        makes no changes to Microsoft; every step below is carried out in
        Microsoft&rsquo;s own tools.
      </p>

      {!mailbox && (
        <>
          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Microsoft&rsquo;s order
          </p>
          <ol className="mt-1.5 list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
            <li>
              Disable the account. Microsoft prefers this to a password reset,
              because it stops sessions and new sign-ins at once.
            </li>
            <li>Revoke the account&rsquo;s sessions and refresh tokens.</li>
            <li>
              Review the registered MFA methods and remove any the owner does
              not recognise.
            </li>
            <li>
              Review applications the account has consented to, and the
              permissions each was granted.
            </li>
            <li>Review any administrative roles the account holds.</li>
            <li>Review mail forwarding and inbox rules on the mailbox.</li>
          </ol>
        </>
      )}

      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Easily missed
      </p>
      <ul className="mt-1.5 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
        <li>
          Inbox rules can be hidden from the usual view.{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] dark:bg-slate-800">
            Get-InboxRule -IncludeHidden
          </code>{' '}
          lists them; a forwarding rule an attacker created is a common thing to
          miss.
        </li>
        {!mailbox && (
          <>
            <li>
              Do not send a new password to the user by email. If the mailbox is
              compromised, the attacker receives it too — use a channel you have
              separately confirmed.
            </li>
            <li>
              For a directory-synchronised account, the password must be reset
              twice, so that the previous hash cannot be replayed.
            </li>
            <li>
              App passwords are not revoked by a password reset and have to be
              removed separately.
            </li>
          </>
        )}
      </ul>
    </details>
  )
}

/**
 * What the numbers above this line mean, for the checks where the field names
 * are not enough on their own.
 *
 * "Evidence" and "evidence time" are accurate for a check that watches events
 * and misleading for one that reads a setting: the count is of destinations
 * rather than occurrences, and the timestamps are when HawkView looked rather
 * than when anything happened. The dl cannot say that in a label without
 * repeating it on every row of every finding, so it is said once, and only for
 * the findings it applies to.
 *
 * An unrecognised check gets the same treatment for a different reason. This
 * build cannot know whether its count is of events or of things, so it declines
 * to name a unit rather than guessing "records" — the mailbox check is the
 * standing proof that guessing gets it wrong.
 */
function EvidenceReadingCaveat({
  finding,
}: {
  finding: RiskAssessmentFinding
}) {
  const shape = findingEvidenceShape(finding.ruleId)
  if (shape.kind === 'OCCURRENCES') return null
  return (
    <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
      {shape.kind === 'CONFIGURED_STATE' ? (
        <>
          This check reads a setting rather than watching events. The count
          above is how many {shape.plural} the mailbox is currently configured
          to forward to, and the times are when HawkView read that
          configuration. They are not when the forwarding was set up, and this
          finding does not carry that date &mdash; a rule created months ago and
          one created this morning look the same here.
        </>
      ) : (
        <>
          This build of HawkView does not know this check, so it cannot say what
          the count above counts or what the times mark. Both are shown as the
          server reported them, without a unit, because the alternative is to
          guess one.
        </>
      )}
    </p>
  )
}

export function RiskAssessmentDrawer({
  user,
  onClose,
}: {
  user: RiskAssessmentUser | null
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!user) return
    const priorFocus = document.activeElement as HTMLElement | null
    const priorOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      )
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
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = priorOverflow
      priorFocus?.focus()
    }
  }, [onClose, user])

  if (!user) return null
  const protection = riskProtectionSummary(user)
  const currentCount = user.findings.filter(
    (finding) => finding.activityState === 'CURRENT'
  ).length
  const historicalCount = user.findings.filter(
    (finding) => finding.activityState === 'HISTORICAL'
  ).length
  const unknownCount = user.findings.filter(
    (finding) => finding.activityState === 'UNKNOWN'
  ).length

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/45"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="risk-assessment-drawer-title"
        className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl dark:bg-slate-950"
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-800 sm:px-6">
          <div className="min-w-0">
            <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
              HawkView investigation details
            </p>
            <h2
              id="risk-assessment-drawer-title"
              className="mt-1 truncate text-xl font-semibold text-slate-950 dark:text-slate-50"
            >
              {user.label}
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {currentCount} current · {historicalCount} historical ·{' '}
              {unknownCount} timing unknown
            </p>
          </div>
          <Button
            ref={closeRef}
            type="button"
            variant="outline"
            size="icon"
            onClick={onClose}
            aria-label="Close investigation details"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          <section
            aria-labelledby="protection-heading"
            className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
          >
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  protection.tone === 'positive'
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                    : protection.tone === 'attention'
                      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'
                      : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                )}
              >
                {protection.tone === 'positive' ? (
                  <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                )}
              </span>
              <div>
                <h3
                  id="protection-heading"
                  className="text-base font-semibold text-slate-950 dark:text-slate-50"
                >
                  Protection context
                </h3>
                <p className="mt-1 text-sm font-medium text-slate-800 dark:text-slate-200">
                  {protection.label}
                </p>
                <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {user.protection.explanation}
                </p>
              </div>
            </div>
            <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Conditional Access
              </h4>
              <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                {conditionalAccessLabel(user.protection.conditionalAccess)}
              </p>
              <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 text-xs text-slate-600 dark:text-slate-300 sm:grid-cols-2">
                <div>
                  <dt className="inline">Source: </dt>
                  <dd className="inline">
                    {protectionSourceLabel(
                      user.protection.conditionalAccess.source
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="inline">Freshness: </dt>
                  <dd className="inline capitalize">
                    {words(user.protection.conditionalAccess.freshness)}
                  </dd>
                </div>
                <div>
                  <dt className="inline">Observed: </dt>
                  <dd className="inline">
                    {formatTimestamp(
                      user.protection.conditionalAccess.observedAt
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="inline">Evaluated: </dt>
                  <dd className="inline">
                    {formatTimestamp(
                      user.protection.conditionalAccess.evaluatedAt
                    )}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="inline">Reasons: </dt>
                  <dd className="inline">
                    {user.protection.conditionalAccess.reasonCodes.length > 0
                      ? user.protection.conditionalAccess.reasonCodes
                          .map(protectionReasonLabel)
                          .join(' · ')
                      : 'No additional reason reported'}
                  </dd>
                </div>
              </dl>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ProtectionEvidenceDetail
                label="Security Defaults"
                evidence={user.protection.securityDefaults}
              />
              <ProtectionEvidenceDetail
                label="Legacy per-user MFA"
                evidence={user.protection.legacyPerUserMfa}
              />
              <ProtectionEvidenceDetail
                label="MFA registration"
                evidence={user.protection.registration}
              />
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
              MFA registration does not prove enforcement. Current protection
              does not prove that historical activity used MFA and does not
              reduce finding priority.
            </p>
            {user.protection.conditionalAccess.policies.length > 0 && (
              <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Relevant Conditional Access policies
                </h4>
                <ul className="mt-2 space-y-2">
                  {user.protection.conditionalAccess.policies.map((policy) => (
                    <li
                      key={policy.id}
                      className="text-sm text-slate-700 dark:text-slate-300"
                    >
                      <span className="font-medium">{policy.name}</span>
                      <span className="text-slate-500">
                        {' '}
                        · {words(policy.state)} · {words(policy.outcome)}
                      </span>
                      {policy.materialConditions.length > 0 && (
                        <p className="mt-0.5 text-xs text-slate-500">
                          Conditions: {policy.materialConditions.join(' · ')}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section aria-labelledby="findings-heading" className="mt-6">
            <div className="mb-4 flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-slate-500" aria-hidden="true" />
              <h2
                id="findings-heading"
                className="text-base font-semibold text-slate-950 dark:text-slate-50"
              >
                Reasons requiring review
              </h2>
            </div>
            {user.findings.map((finding) => (
              <FindingDetail key={finding.id} finding={finding} />
            ))}
            <ContainmentGuidance user={user} />
          </section>
        </div>
      </div>
    </div>
  )
}
