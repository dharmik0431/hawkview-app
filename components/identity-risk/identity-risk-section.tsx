'use client'

import {
  AlertTriangle,
  BookOpenCheck,
  Clock3,
  Info,
  RefreshCw,
  SearchCheck,
  ShieldAlert,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useIdentityRiskChannels } from '@/lib/api/identity-risk-hooks'
import type {
  HawkViewIdentityFinding,
  HawkViewIdentitySignalsView,
  IdentityRiskCapability,
  IdentityRiskChannelMeta,
  MicrosoftEntraRiskyUser,
  MicrosoftEntraRiskyUsersView,
} from '@/lib/identity-risk/types'

function formatTimestamp(value: string | null) {
  if (!value) return 'Not reported'
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return 'Not reported'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed)
}

function capabilityLabel(capability: IdentityRiskCapability) {
  if (capability === 'FULL') return 'Full coverage'
  if (capability === 'PARTIAL') return 'Partial coverage'
  return 'Unavailable'
}

export function identityRiskStatusPresentation(meta: IdentityRiskChannelMeta) {
  switch (meta.status) {
    case 'AVAILABLE':
      return {
        label: 'Available',
        detail: meta.limitation ?? 'Current evidence is available for this channel.',
        className:
          'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200',
      }
    case 'STALE':
      return {
        label: 'Stale evidence',
        detail:
          meta.limitation ??
          'The latest evidence is outside its freshness window and must not be treated as current.',
        className:
          'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
      }
    case 'LEARNING':
      return {
        label: 'Learning',
        detail:
          meta.limitation ??
          'Behavioral baselines are still learning. Rules that need mature baselines were not evaluated.',
        className:
          'border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200',
      }
    case 'NOT_EVALUATED':
      return {
        label: 'Not evaluated',
        detail:
          meta.limitation ??
          'Required evidence or approved configuration was not available for evaluation.',
        className:
          'border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200',
      }
    case 'UNAVAILABLE':
      return {
        label: 'Unavailable',
        detail:
          meta.limitation ??
          'This evidence is unavailable. A missing result must not be interpreted as zero.',
        className:
          'border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200',
      }
    default:
      return {
        label: 'Unable to load',
        detail:
          meta.limitation ??
          'This channel could not be loaded. Retry without assuming that no findings exist.',
        className:
          'border-red-200 bg-red-50 text-red-950 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
      }
  }
}

function ChannelMeta({ meta }: { meta: IdentityRiskChannelMeta }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 border-t border-slate-200 pt-3 text-xs dark:border-slate-800 sm:grid-cols-3">
      <div>
        <dt className="text-slate-500 dark:text-slate-400">Source</dt>
        <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">
          {meta.sourceLabel}
        </dd>
      </div>
      <div>
        <dt className="text-slate-500 dark:text-slate-400">Evidence observed</dt>
        <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">
          {formatTimestamp(meta.observedAt)}
        </dd>
      </div>
      <div>
        <dt className="text-slate-500 dark:text-slate-400">Freshness</dt>
        <dd className="mt-0.5 font-medium capitalize text-slate-800 dark:text-slate-200">
          {meta.freshness.toLowerCase()}
        </dd>
      </div>
    </dl>
  )
}

function ChannelState({ meta }: { meta: IdentityRiskChannelMeta }) {
  const state = identityRiskStatusPresentation(meta)
  return (
    <div
      className={cn('rounded-lg border px-3 py-2.5 text-sm', state.className)}
      role={meta.status === 'ERROR' ? 'alert' : 'status'}
    >
      <div className="font-semibold">{state.label}</div>
      <p className="mt-0.5 text-xs leading-relaxed opacity-90">{state.detail}</p>
    </div>
  )
}

function LoadingChannel({ label }: { label: string }) {
  return (
    <div
      className="min-h-[340px] animate-pulse rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
      aria-busy="true"
      aria-label={`Loading ${label}`}
    >
      <span className="sr-only">Loading {label}</span>
      <div className="h-4 w-32 rounded bg-slate-200 dark:bg-slate-700" />
      <div className="mt-3 h-7 w-64 max-w-full rounded bg-slate-200 dark:bg-slate-700" />
      <div className="mt-6 h-20 rounded-lg bg-slate-100 dark:bg-slate-800" />
      <div className="mt-5 space-y-3">
        <div className="h-16 rounded-lg bg-slate-100 dark:bg-slate-800" />
        <div className="h-16 rounded-lg bg-slate-100 dark:bg-slate-800" />
      </div>
    </div>
  )
}

function severityClass(severity: HawkViewIdentityFinding['severity']) {
  if (severity === 'CRITICAL') return 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'
  if (severity === 'HIGH') return 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-300'
  if (severity === 'MEDIUM') return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
  return 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300'
}

function FindingRow({ finding }: { finding: HawkViewIdentityFinding }) {
  return (
    <article className="rounded-lg border border-slate-200 p-3.5 dark:border-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-slate-950 dark:text-slate-50">
            {finding.title}
          </h4>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {finding.affectedIdentity.label} · {finding.affectedIdentity.type.toLowerCase()}
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-800 dark:text-slate-200">
            {finding.explanation}
          </p>
        </div>
        <Badge variant="outline" className={cn('shrink-0', severityClass(finding.severity))}>
          {finding.severity.toLowerCase()} priority
        </Badge>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Observed</dt>
          <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">
            {formatTimestamp(finding.observedAt)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Confidence</dt>
          <dd className="mt-0.5 font-medium capitalize text-slate-800 dark:text-slate-200">
            {finding.confidence.toLowerCase()}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Coverage</dt>
          <dd className="mt-0.5 font-medium capitalize text-slate-800 dark:text-slate-200">
            {finding.coverage.toLowerCase()}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">State</dt>
          <dd className="mt-0.5 font-medium capitalize text-slate-800 dark:text-slate-200">
            {finding.state.toLowerCase()}
          </dd>
        </div>
      </dl>
      <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800">
        <div className="flex items-start gap-2">
          <SearchCheck className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
          <div>
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              Recommended human investigation
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {finding.investigationGuidance}
            </p>
            <div className="mt-1 font-mono text-[11px] text-slate-500 dark:text-slate-400">
              {finding.investigationGuidanceCode}
            </div>
          </div>
        </div>
      </div>
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Rules and sources</dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {[...finding.ruleIds, ...finding.sourceLabels].map((label) => (
              <span key={label} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {label}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Evidence limitations</dt>
          <dd className="mt-1 text-slate-700 dark:text-slate-300">
            {finding.missingEvidenceLabels.length > 0
              ? finding.missingEvidenceLabels.join(' · ')
              : 'None reported for this finding'}
          </dd>
        </div>
      </dl>
      {finding.benignAlternativeCodes.length > 0 && (
        <div className="mt-3 text-xs text-slate-600 dark:text-slate-300">
          <span className="font-semibold text-slate-800 dark:text-slate-200">
            Benign alternatives to consider:{' '}
          </span>
          <span className="font-mono">{finding.benignAlternativeCodes.join(' · ')}</span>
        </div>
      )}
    </article>
  )
}

function HawkViewCard({
  view,
  onRetry,
}: {
  view: HawkViewIdentitySignalsView
  onRetry: () => void
}) {
  const confirmedEmpty =
    view.meta.status === 'AVAILABLE' &&
    view.meta.capability === 'FULL' &&
    view.meta.freshness === 'CURRENT' &&
    view.findings?.length === 0

  return (
    <section
      aria-labelledby="hawkview-identity-signals-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
            <SearchCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
              HawkView identity risk indicators
            </p>
            <h3
              id="hawkview-identity-signals-heading"
              className="mt-0.5 text-lg font-semibold text-slate-950 dark:text-slate-50"
            >
              HawkView Identity Signals
            </h3>
          </div>
        </div>
        <Badge variant="outline" className="shrink-0">
          {capabilityLabel(view.meta.capability)}
        </Badge>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        Explainable HawkView rule findings are investigation leads. They are not
        Microsoft Identity Protection determinations and do not prove that an
        account is compromised.
      </p>

      <div className="mt-4 space-y-4">
        <ChannelState meta={view.meta} />

        {view.findings && view.findings.length > 0 && (
          <div className="space-y-2.5" aria-label="HawkView findings">
            {view.findings.map((finding) => (
              <FindingRow key={finding.id} finding={finding} />
            ))}
          </div>
        )}

        {confirmedEmpty && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/50">
            <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
              <BookOpenCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              No current indicators
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              No enabled HawkView rule matched in the latest complete, current
              evaluation. This does not establish that any identity is safe.
            </p>
          </div>
        )}

        {view.findings?.length === 0 && !confirmedEmpty && view.meta.status === 'AVAILABLE' && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-300">
            No findings were returned from the evidence that could be evaluated.
            Limited coverage prevents a broader conclusion.
          </div>
        )}

        {view.meta.status === 'ERROR' && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Retry HawkView signals
          </Button>
        )}

        <ChannelMeta meta={view.meta} />
        <div className="flex items-start gap-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Human investigation only. HawkView does not take autonomous remediation actions.</span>
        </div>
      </div>
    </section>
  )
}

function microsoftRiskLabel(user: MicrosoftEntraRiskyUser) {
  if (user.riskLevel === 'unknownFutureValue') return 'Unknown Microsoft value'
  return `${user.riskLevel} Microsoft risk`
}

function MicrosoftUserRow({ user }: { user: MicrosoftEntraRiskyUser }) {
  return (
    <article className="rounded-lg border border-slate-200 p-3.5 dark:border-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-950 dark:text-slate-50">
            {user.identityLabel}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Updated by Microsoft {formatTimestamp(user.observedAt)}
          </div>
        </div>
        <Badge variant="outline" className="shrink-0 capitalize">
          {microsoftRiskLabel(user)}
        </Badge>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Microsoft state</dt>
          <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">
            {user.riskState}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Microsoft detail</dt>
          <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">
            {user.riskDetail ?? 'Not reported'}
          </dd>
        </div>
      </dl>
    </article>
  )
}

function MicrosoftCard({
  view,
  onRetry,
}: {
  view: MicrosoftEntraRiskyUsersView
  onRetry: () => void
}) {
  const confirmedEmpty =
    view.meta.status === 'AVAILABLE' &&
    view.meta.capability === 'FULL' &&
    view.meta.freshness === 'CURRENT' &&
    view.users?.length === 0

  return (
    <section
      aria-labelledby="microsoft-entra-risky-users-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
            <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-medium text-violet-700 dark:text-violet-300">
              Microsoft-reported user risk
            </p>
            <h3
              id="microsoft-entra-risky-users-heading"
              className="mt-0.5 text-lg font-semibold text-slate-950 dark:text-slate-50"
            >
              Microsoft Entra Risky Users
            </h3>
          </div>
        </div>
        <Badge variant="outline" className="shrink-0">
          {capabilityLabel(view.meta.capability)}
        </Badge>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        This channel preserves Microsoft Entra ID Protection attribution and
        state. It never changes HawkView finding severity, confidence, or
        lifecycle.
      </p>

      <div className="mt-4 space-y-4">
        <ChannelState meta={view.meta} />

        {view.users && view.users.length > 0 && (
          <div className="space-y-2.5" aria-label="Microsoft Entra risky users">
            {view.users.map((user) => (
              <MicrosoftUserRow key={user.id} user={user} />
            ))}
          </div>
        )}

        {confirmedEmpty && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/50">
            <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
              <Clock3 className="h-4 w-4 text-slate-500" aria-hidden="true" />
              No current Microsoft risky users reported
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              The latest authoritative Microsoft snapshot was empty. Microsoft
              evidence can be delayed, and an empty snapshot is not a safe verdict.
            </p>
          </div>
        )}

        {view.users?.length === 0 && !confirmedEmpty && view.meta.status === 'AVAILABLE' && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-300">
            Microsoft returned no rows within the available evidence. Partial or
            stale coverage prevents a zero-risk conclusion.
          </div>
        )}

        {view.meta.status === 'ERROR' && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Retry Microsoft evidence
          </Button>
        )}

        <ChannelMeta meta={view.meta} />
      </div>
    </section>
  )
}

export default function IdentityRiskSection({ tenantId }: { tenantId: string }) {
  const {
    viewModel,
    hawkViewLoading,
    microsoftLoading,
    retryHawkView,
    retryMicrosoft,
  } = useIdentityRiskChannels(tenantId, true)

  return (
    <div className="space-y-4">
      <header className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">
            Identity risk evidence
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
            HawkView rule findings and Microsoft Entra user risk are independent
            evidence channels. They are never merged into one score, and neither
            channel can establish that an identity is safe.
          </p>
        </div>
      </header>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        {hawkViewLoading ? (
          <LoadingChannel label="HawkView Identity Signals" />
        ) : (
          <HawkViewCard
            view={viewModel.hawkView}
            onRetry={() => void retryHawkView()}
          />
        )}
        {microsoftLoading ? (
          <LoadingChannel label="Microsoft Entra Risky Users" />
        ) : (
          <MicrosoftCard
            view={viewModel.microsoft}
            onRetry={() => void retryMicrosoft()}
          />
        )}
      </div>
    </div>
  )
}
