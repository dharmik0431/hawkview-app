'use client'

import { AlertTriangle, Clock3, RefreshCw, ShieldAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useIdentityRiskChannels } from '@/lib/api/identity-risk-hooks'
import { RiskAssessmentCard } from './risk-assessment-card'
import {
  microsoftHasConfirmedEmptySnapshot,
  microsoftRiskyUserCountPresentation,
} from '@/lib/identity-risk/presentation'
import type {
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
  if (capability === 'FULL') return 'Full reported coverage'
  if (capability === 'PARTIAL') return 'Partial coverage'
  return 'Unavailable'
}

export function identityRiskStatusPresentation(meta: IdentityRiskChannelMeta) {
  switch (meta.status) {
    case 'AVAILABLE':
      return {
        label:
          meta.capability === 'PARTIAL'
            ? 'Partial evidence'
            : 'Evidence available',
        detail:
          meta.capability === 'PARTIAL'
            ? 'Only part of the evidence could be evaluated. Missing coverage must not be treated as a zero or a safe result.'
            : 'Current evidence is available for this channel. Availability is not a risk verdict.',
        className:
          'border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200',
      }
    case 'STALE':
      return {
        label: 'Stale evidence',
        detail:
          'The latest evidence is outside its freshness window and must not be treated as current.',
        className:
          'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
      }
    case 'LEARNING':
      return {
        label: 'Learning',
        detail:
          'The server reports a learning state. This is not a complete evaluation or a no-findings result.',
        className:
          'border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200',
      }
    case 'NOT_EVALUATED':
      return {
        label: 'Not evaluated',
        detail:
          'Required evidence or approved configuration was not available for evaluation.',
        className:
          'border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200',
      }
    case 'UNAVAILABLE':
      return {
        label: 'Unavailable',
        detail:
          'This evidence is unavailable. A missing result must not be interpreted as zero.',
        className:
          'border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200',
      }
    default:
      return {
        label: 'Unable to load',
        detail:
          'This channel could not be loaded. Retry without assuming that no findings exist.',
        className:
          'border-red-200 bg-red-50 text-red-950 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
      }
  }
}

function ChannelMeta({ meta }: { meta: IdentityRiskChannelMeta }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 border-t border-slate-200 pt-3 text-xs dark:border-slate-800 sm:grid-cols-2 lg:grid-cols-6">
      <div>
        <dt className="text-slate-500 dark:text-slate-400">Source</dt>
        <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">
          {meta.sourceLabel}
        </dd>
      </div>
      <div>
        <dt className="text-slate-500 dark:text-slate-400">
          Channel evaluated
        </dt>
        <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">
          {formatTimestamp(meta.evaluatedAt)}
        </dd>
      </div>
      <div>
        <dt className="text-slate-500 dark:text-slate-400">
          Evidence observed
        </dt>
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
      <div>
        <dt className="text-slate-500 dark:text-slate-400">Engine version</dt>
        <dd className="mt-0.5 break-words font-mono text-[11px] font-medium text-slate-800 dark:text-slate-200">
          {meta.engineVersion ??
            (meta.catalogVersion ? 'Not applicable' : 'Not reported')}
        </dd>
      </div>
      <div>
        <dt className="text-slate-500 dark:text-slate-400">Catalog version</dt>
        <dd className="mt-0.5 break-words font-mono text-[11px] font-medium text-slate-800 dark:text-slate-200">
          {meta.catalogVersion ?? 'Not reported'}
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
      <p className="mt-0.5 text-xs leading-relaxed opacity-90">
        {state.detail}
      </p>
      {meta.limitation && (
        <p className="mt-2 text-xs leading-relaxed">
          <span className="font-semibold">Reported context: </span>
          {meta.limitation}
        </p>
      )}
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
          <dt className="text-slate-500 dark:text-slate-400">
            Microsoft state
          </dt>
          <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-200">
            {user.riskState}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">
            Microsoft detail
          </dt>
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
  const confirmedEmpty = microsoftHasConfirmedEmptySnapshot(view)
  const count = microsoftRiskyUserCountPresentation(view)

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
        lifecycle. Unavailable Microsoft licensing or collection evidence does
        not erase independent HawkView findings.
      </p>

      <div className="mt-4 space-y-4">
        <div className="rounded-lg border border-violet-200 bg-violet-50/70 p-4 dark:border-violet-900 dark:bg-violet-950/30">
          <p
            className="text-4xl font-semibold tracking-tight text-slate-950 dark:text-slate-50"
            aria-label={count.accessibleValue}
          >
            {count.value}
          </p>
          <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {count.label}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            {count.detail}
          </p>
        </div>

        <ChannelState meta={view.meta} />

        {view.users && view.users.length > 0 && (
          <div className="space-y-2.5" aria-label="Microsoft Entra risky users">
            {view.users.map((user) => (
              <MicrosoftUserRow key={user.id} user={user} />
            ))}
          </div>
        )}

        {view.pageInfo?.hasMore && (
          <div
            role="status"
            className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-xs leading-relaxed text-violet-900 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-200"
          >
            More Microsoft risky-user records are available. This preview shows
            only the current bounded page and is not a complete Microsoft result
            set.
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
              evidence can be delayed, and an empty snapshot is not a safe
              verdict.
            </p>
          </div>
        )}

        {view.users?.length === 0 &&
          !confirmedEmpty &&
          view.meta.status === 'AVAILABLE' && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-300">
              Microsoft returned no rows within the available evidence. Partial
              or stale coverage prevents a zero-risk conclusion.
            </div>
          )}

        {view.meta.status === 'ERROR' && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Retry Microsoft evidence
          </Button>
        )}

        <details className="border-t border-slate-200 pt-4 dark:border-slate-800">
          <summary className="cursor-pointer text-sm font-semibold">
            Technical details
          </summary>
          <div className="mt-3">
            <ChannelMeta meta={view.meta} />
          </div>
        </details>
      </div>
    </section>
  )
}

export default function IdentityRiskSection({
  tenantId,
}: {
  tenantId: string
}) {
  const {
    assessmentView,
    assessmentLoading,
    assessmentRequestError,
    assessmentContractError,
    microsoftView,
    cacheScope,
    microsoftLoading,
    retryAssessment,
    retryMicrosoft,
  } = useIdentityRiskChannels(tenantId, true)

  return (
    <div className="space-y-4">
      <header className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
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
        {assessmentLoading ? (
          <LoadingChannel label="HawkView Risky Users" />
        ) : (
          <RiskAssessmentCard
            key={`${cacheScope}:${tenantId}`}
            assessment={assessmentView}
            requestError={assessmentRequestError}
            contractError={assessmentContractError}
            onRetry={() => void retryAssessment()}
          />
        )}
        {microsoftLoading ? (
          <LoadingChannel label="Microsoft Entra Risky Users" />
        ) : (
          <MicrosoftCard
            view={microsoftView}
            onRetry={() => void retryMicrosoft()}
          />
        )}
      </div>
    </div>
  )
}
