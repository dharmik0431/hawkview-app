'use client'

import { useCallback, useState } from 'react'
import { ChevronRight, RefreshCw, SearchCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  currentRiskAssessmentUsers,
  hawkViewRiskyUserCountPresentation,
  riskAssessmentEmptyPresentation,
  riskProtectionSummary,
  riskReadinessLabel,
  riskSourceLabel,
} from '@/lib/identity-risk/presentation'
import type {
  RiskAssessment,
  RiskAssessmentReadiness,
  RiskAssessmentUser,
} from '@/lib/identity-risk/types'
import { RiskAssessmentDrawer } from './risk-assessment-drawer'

function time(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Not reported'
}

function windowLabel(window: { start: string | null; end: string | null }) {
  return `${time(window.start)} – ${time(window.end)}`
}

function ReadinessBadge({ status }: { status: RiskAssessmentReadiness }) {
  return (
    <Badge
      variant="outline"
      className={
        status === 'READY'
          ? 'border-blue-200 text-blue-700 dark:border-blue-800 dark:text-blue-300'
          : 'border-amber-200 text-amber-800 dark:border-amber-800 dark:text-amber-300'
      }
    >
      {riskReadinessLabel(status)}
    </Badge>
  )
}

function UserRow({
  user,
  onReview,
  previouslyReported = false,
}: {
  user: RiskAssessmentUser
  onReview: () => void
  previouslyReported?: boolean
}) {
  const findings = user.findings.filter(
    (item) => item.activityState === 'CURRENT'
  )
  const latest =
    findings
      .map((item) => item.lastSeen)
      .sort()
      .at(-1) ?? null
  const protection = riskProtectionSummary(user)
  return (
    <article className="rounded-lg border border-slate-200 p-3.5 dark:border-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="break-words text-sm font-semibold">{user.label}</h4>
          <p className="mt-1 text-xs text-slate-500">
            {previouslyReported
              ? 'Previously reported user evidence'
              : 'Current user finding'}{' '}
            · Last observed {time(latest)}
          </p>
        </div>
        <Badge variant="outline" className="shrink-0 capitalize">
          {user.priority?.toLowerCase()} investigation priority
        </Badge>
      </div>
      <ul className="mt-3 space-y-1.5 text-sm" aria-label="Current reasons">
        {findings.map((finding) => (
          <li key={finding.id}>
            <span className="font-medium">{finding.title}</span>
            <span className="text-xs text-slate-500">
              {' '}
              · {finding.confidence.toLowerCase()} confidence ·{' '}
              {riskSourceLabel(finding.selectedSource)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-600 dark:text-slate-300">
        Protection context: {protection.label}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={onReview}
        aria-haspopup="dialog"
      >
        View explanation<span className="sr-only"> for {user.label}</span>
        <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
      </Button>
    </article>
  )
}

function ContextRow({
  user,
  onReview,
}: {
  user: RiskAssessmentUser
  onReview: () => void
}) {
  const protection = riskProtectionSummary(user)
  return (
    <article className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{user.label}</p>
          <p className="mt-1 text-xs text-slate-500">
            {user.subjectType === 'MAILBOX'
              ? 'Mailbox-only evidence'
              : 'Non-current user evidence'}{' '}
            · Excluded from current-user count
          </p>
        </div>
        <Badge variant="outline">Supporting context</Badge>
      </div>
      <ul className="mt-3 space-y-1.5 text-sm">
        {user.findings.map((finding) => (
          <li key={finding.id}>
            <span className="font-medium">{finding.title}</span>
            <span className="text-xs text-slate-500">
              {' '}
              · {finding.activityState.toLowerCase()} · Last observed{' '}
              {time(finding.lastSeen)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-600 dark:text-slate-300">
        Protection context: {protection.label}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={onReview}
        aria-haspopup="dialog"
      >
        Review findings<span className="sr-only"> for {user.label}</span>
        <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
      </Button>
    </article>
  )
}

export function RiskAssessmentCard({
  assessment,
  requestError,
  contractError,
  onRetry,
}: {
  assessment: RiskAssessment | null
  requestError: boolean
  contractError: boolean
  onRetry: () => void
}) {
  const hasUnverifiedRefresh = requestError || contractError
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const closeDrawer = useCallback(() => setSelectedId(null), [])
  const selectedUser =
    assessment?.users.find((user) => user.id === selectedId) ?? null
  const currentUsers = assessment ? currentRiskAssessmentUsers(assessment) : []
  const currentIds = new Set(currentUsers.map((user) => user.id))
  const supportingUsers =
    assessment?.users.filter((user) => !currentIds.has(user.id)) ?? []
  const reportedCount = assessment
    ? hawkViewRiskyUserCountPresentation(assessment)
    : null
  const count =
    reportedCount && (requestError || contractError)
      ? {
          ...reportedCount,
          value: '—',
          accessibleValue: 'Not available',
          label: 'Current risky user count unavailable',
          detail:
            'The latest assessment could not be verified. Previously loaded findings remain visible for context, but no current total is shown.',
          exact: false,
          asOf: reportedCount.asOf,
        }
      : reportedCount
  const empty =
    assessment && !requestError && !contractError
      ? riskAssessmentEmptyPresentation(assessment)
      : null

  return (
    <section
      aria-labelledby="hawkview-identity-signals-heading"
      className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
            <SearchCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
              HawkView identity risk indicators
            </p>
            <h3
              id="hawkview-identity-signals-heading"
              className="mt-0.5 text-lg font-semibold"
            >
              HawkView Risky Users
            </h3>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Refresh assessment
        </Button>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        Distinct users with current HawkView findings. These are not Microsoft
        Identity Protection determinations and do not prove compromise. HawkView
        does not take autonomous remediation actions.
      </p>

      {(requestError || contractError || !assessment) && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <p className="font-semibold">
            {requestError
              ? 'Unable to refresh assessment'
              : contractError
                ? 'Assessment format could not be verified'
                : 'Assessment has not been reported'}
          </p>
          <p className="mt-1 text-xs">
            {requestError && assessment
              ? 'Previously loaded findings remain visible. Current coverage could not be confirmed; this failure does not resolve any finding.'
              : 'No current result can be confirmed. Retry the assessment; missing evidence is not a no-findings result.'}
          </p>
          <p className="mt-2 font-mono text-xs">
            Support code:{' '}
            {requestError
              ? 'RISK_ASSESSMENT_REQUEST_FAILED'
              : contractError
                ? 'RISK_ASSESSMENT_CONTRACT_INVALID'
                : 'RISK_ASSESSMENT_NOT_REPORTED'}
          </p>
        </div>
      )}

      {assessment && count && (
        <>
          <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50/70 p-4 dark:border-blue-900 dark:bg-blue-950/30">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p
                  className="text-4xl font-semibold tracking-tight"
                  aria-label={count.accessibleValue}
                >
                  {count.value}
                </p>
                <p className="mt-1 text-sm font-semibold">{count.label}</p>
              </div>
              <Badge variant="outline">
                {hasUnverifiedRefresh
                  ? 'Previously reported evidence'
                  : assessment.meta.status === 'STALE' ||
                      assessment.meta.freshness === 'STALE'
                    ? 'Stale assessment'
                    : assessment.meta.capability === 'FULL'
                      ? 'Complete reported coverage'
                      : assessment.meta.capability === 'PARTIAL'
                        ? 'Partial coverage'
                        : 'Coverage unavailable'}
              </Badge>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {count.detail}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              {hasUnverifiedRefresh
                ? `Previously reported assessment as of ${time(count.asOf)}; current count withheld.`
                : count.value === '—'
                  ? `Assessment as of ${time(count.asOf)}; no authoritative current total reported.`
                  : `Count as of ${time(count.asOf)}.`}{' '}
              Mailbox-only and non-current findings are excluded.
            </p>
          </div>

          {currentUsers.length > 0 && (
            <div className="mt-5">
              <h4 className="text-sm font-semibold">
                {hasUnverifiedRefresh
                  ? 'Previously reported users requiring review'
                  : 'Users needing investigation'}
              </h4>
              <div
                aria-label="HawkView identified risky users"
                className="mt-3 space-y-3"
              >
                {currentUsers.map((user) => (
                  <UserRow
                    key={user.id}
                    user={user}
                    previouslyReported={hasUnverifiedRefresh}
                    onReview={() => setSelectedId(user.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {empty && (
            <div className="mt-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-sm font-semibold">{empty.label}</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                {empty.detail}
              </p>
            </div>
          )}

          {assessment.page.hasMore && (
            <p
              role="status"
              className="mt-4 rounded-lg bg-blue-50 p-3 text-xs text-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
            >
              More HawkView findings are available. The headline count comes
              from the tenant summary, never this bounded page or an incomplete
              result set.
            </p>
          )}

          {supportingUsers.length > 0 && (
            <details className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
              <summary className="cursor-pointer text-sm font-semibold">
                Mailbox and historical context · {supportingUsers.length}
              </summary>
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                These records may support an investigation but are excluded from
                the current distinct-user count.
              </p>
              <div className="mt-3 space-y-3">
                {supportingUsers.map((user) => (
                  <ContextRow
                    key={user.id}
                    user={user}
                    onReview={() => setSelectedId(user.id)}
                  />
                ))}
              </div>
            </details>
          )}

          <details className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
            <summary className="cursor-pointer text-sm font-semibold">
              Technical details
            </summary>
            <div className="mt-3 space-y-4">
              <dl className="grid gap-2 text-xs text-slate-600 dark:text-slate-300 sm:grid-cols-2">
                <div>
                  <dt className="font-medium">Source</dt>
                  <dd>{assessment.meta.sourceLabel}</dd>
                </div>
                <div>
                  <dt className="font-medium">Evaluated</dt>
                  <dd>{time(assessment.meta.evaluatedAt)}</dd>
                </div>
                <div>
                  <dt className="font-medium">Freshness</dt>
                  <dd className="capitalize">
                    {assessment.meta.freshness.toLowerCase()}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">Engine / catalog</dt>
                  <dd>
                    {assessment.meta.engineVersion ?? 'Not reported'} /{' '}
                    {assessment.meta.catalogVersion ?? 'Not reported'}
                  </dd>
                </div>
              </dl>
              <div>
                <h4 className="text-sm font-semibold">Rule readiness</h4>
                <div className="mt-2 space-y-3">
                  {assessment.rules.map((rule) => (
                    <article
                      key={rule.ruleId}
                      className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="text-sm font-medium">
                          {rule.title}
                        </span>
                        <ReadinessBadge status={rule.status} />
                      </div>
                      <p className="mt-2 text-xs">{rule.explanation}</p>
                      <p className="mt-2 text-xs text-slate-500">
                        {riskSourceLabel(rule.selectedSource)} · Evidence window{' '}
                        {windowLabel(rule.window)} · Evaluated{' '}
                        {time(rule.evaluatedAt)} · Assessed{' '}
                        {rule.assessedIdentities ?? 'not reported'} · Matched{' '}
                        {rule.matchedIdentities ?? 'not reported'}
                        {rule.countsCapped
                          ? ' · Counts capped; scope incomplete'
                          : ''}
                      </p>
                    </article>
                  ))}
                </div>
              </div>
              <div>
                <h4 className="text-sm font-semibold">
                  Source collection and freshness
                </h4>
                <div className="mt-2 space-y-3">
                  {assessment.sources.map((source) => (
                    <article
                      key={source.source}
                      className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="text-sm font-medium">
                          {riskSourceLabel(source.source)}
                        </span>
                        <ReadinessBadge status={source.status} />
                      </div>
                      <p className="mt-2 text-xs">{source.explanation}</p>
                      <p className="mt-2 text-xs text-slate-500">
                        Evidence window {windowLabel(source.window)} · Last
                        success {time(source.lastSuccessfulCollectionAt)} ·
                        Latest event {time(source.latestEventAt)} · Latest
                        ingestion {time(source.latestIngestionAt)} · Freshness{' '}
                        {source.freshness.toLowerCase()}
                      </p>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </details>
        </>
      )}
      <RiskAssessmentDrawer user={selectedUser} onClose={closeDrawer} />
    </section>
  )
}
