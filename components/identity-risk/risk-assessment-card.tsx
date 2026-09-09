'use client'

import { useCallback, useState } from 'react'
import { ChevronRight, RefreshCw, SearchCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  riskAssessmentEmptyPresentation,
  riskProtectionSummary,
  riskReadinessLabel,
  riskSourceLabel,
} from '@/lib/identity-risk/presentation'
import type {
  RiskAssessment,
  RiskAssessmentReadiness,
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const closeDrawer = useCallback(() => setSelectedId(null), [])
  const selectedUser =
    assessment?.users.find((user) => user.id === selectedId) ?? null
  const empty =
    assessment && !requestError && !contractError
      ? riskAssessmentEmptyPresentation(assessment)
      : null
  const current =
    assessment?.users.filter((user) => user.priority !== null).length ?? 0
  const findings = assessment?.users.flatMap((user) => user.findings) ?? []

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
              className="mt-0.5 text-lg font-semibold text-slate-950 dark:text-slate-50"
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
        Explainable investigation leads from qualified authentication and
        mailbox evidence. These are not Microsoft Identity Protection
        determinations and do not prove compromise, message delivery, or data
        theft. HawkView does not take autonomous remediation actions.
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
              ? 'Previously loaded findings remain visible below. Current coverage could not be confirmed; this failure does not resolve any finding.'
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

      {assessment && (
        <>
          <div
            role="status"
            className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-800/50"
          >
            <p className="font-semibold">
              {requestError
                ? 'Previously loaded evidence'
                : assessment.meta.status === 'STALE' ||
                    assessment.meta.freshness === 'STALE'
                  ? 'Stale assessment'
                  : assessment.meta.capability === 'FULL'
                    ? 'Complete reported coverage'
                    : assessment.meta.capability === 'PARTIAL'
                      ? 'Partial coverage'
                      : 'Assessment coverage unavailable'}
            </p>
            <p className="mt-1 text-xs leading-relaxed">
              {assessment.meta.limitation ??
                'All three checks report current evaluated evidence. This does not establish that an identity is safe.'}
            </p>
            <p className="mt-2 text-xs">
              Channel evaluated: {time(assessment.meta.evaluatedAt)} ·
              Freshness: {assessment.meta.freshness.toLowerCase()}
            </p>
          </div>

          {assessment.users.length > 0 && (
            <>
              <dl className="my-4 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-slate-500">
                    Identities with reported current findings
                  </dt>
                  <dd className="mt-1 font-semibold">{current}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">
                    Findings in this page
                  </dt>
                  <dd className="mt-1 font-semibold">{findings.length}</dd>
                </div>
              </dl>
              <div aria-label="HawkView findings" className="space-y-3">
                {assessment.users.map((user) => {
                  const protection = riskProtectionSummary(user)
                  const latest =
                    user.findings
                      .map((finding) => finding.lastSeen)
                      .sort()
                      .at(-1) ?? null
                  return (
                    <article
                      key={user.id}
                      className="rounded-lg border border-slate-200 p-3.5 dark:border-slate-800"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h4 className="break-words text-sm font-semibold">
                            {user.label}
                          </h4>
                          <p className="mt-1 text-xs text-slate-500">
                            {user.subjectType === 'MAILBOX'
                              ? 'Resolved mailbox'
                              : 'Resolved user'}{' '}
                            · Last activity {time(latest)}
                          </p>
                        </div>
                        <Badge variant="outline" className="capitalize">
                          {user.priority
                            ? `${user.priority.toLowerCase()} investigation priority`
                            : 'Historical or unconfirmed activity'}
                        </Badge>
                      </div>
                      <ul className="mt-3 space-y-1.5 text-sm">
                        {user.findings.map((finding) => (
                          <li key={finding.id}>
                            <span className="font-medium">{finding.title}</span>
                            <span className="text-xs text-slate-500">
                              {' '}
                              · {finding.activityState.toLowerCase()} ·{' '}
                              {finding.confidence.toLowerCase()} confidence ·{' '}
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
                        onClick={() => setSelectedId(user.id)}
                        aria-haspopup="dialog"
                      >
                        Review findings
                        <span className="sr-only"> for {user.label}</span>
                        <ChevronRight
                          className="ml-1 h-4 w-4"
                          aria-hidden="true"
                        />
                      </Button>
                    </article>
                  )
                })}
              </div>
            </>
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
              More HawkView findings are available. This bounded page must not
              be treated as a complete result set.
            </p>
          )}

          <details
            open
            className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-800"
          >
            <summary className="cursor-pointer text-sm font-semibold">
              Rule readiness · {assessment.rules.length} checks
            </summary>
            <div className="mt-3 space-y-3">
              {assessment.rules.map((rule) => (
                <article
                  key={rule.ruleId}
                  className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h4 className="text-sm font-medium">{rule.title}</h4>
                    <ReadinessBadge status={rule.status} />
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-slate-500">
                    {rule.ruleId}
                  </p>
                  <p className="mt-2 text-xs leading-relaxed">
                    {rule.explanation}
                  </p>
                  <dl className="mt-2 space-y-1 text-xs text-slate-600 dark:text-slate-300">
                    <div>
                      <dt className="inline font-medium">Selected source: </dt>
                      <dd className="inline">
                        {riskSourceLabel(rule.selectedSource)}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline font-medium">Evidence window: </dt>
                      <dd className="inline">{windowLabel(rule.window)}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium">Evaluated: </dt>
                      <dd className="inline">{time(rule.evaluatedAt)}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium">
                        Assessed / matched identities:{' '}
                      </dt>
                      <dd className="inline">
                        {rule.assessedIdentities ?? 'Not reported'} /{' '}
                        {rule.matchedIdentities ?? 'Not reported'}
                        {rule.countsCapped
                          ? ' · Counts capped; scope incomplete'
                          : ''}
                      </dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          </details>
          <details className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
            <summary className="cursor-pointer text-sm font-semibold">
              Source collection and freshness
            </summary>
            <div className="mt-3 space-y-3">
              {assessment.sources.map((source) => (
                <article
                  key={source.source}
                  className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <h4 className="text-sm font-medium">
                      {riskSourceLabel(source.source)}
                    </h4>
                    <ReadinessBadge status={source.status} />
                  </div>
                  <p className="mt-2 text-xs">{source.explanation}</p>
                  <dl className="mt-2 space-y-1 text-xs text-slate-600 dark:text-slate-300">
                    {[
                      ['Evidence window', windowLabel(source.window)],
                      [
                        'Last successful collection',
                        time(source.lastSuccessfulCollectionAt),
                      ],
                      ['Latest event', time(source.latestEventAt)],
                      ['Latest ingestion', time(source.latestIngestionAt)],
                      ['Freshness', source.freshness.toLowerCase()],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="inline font-medium">{label}: </dt>
                        <dd className="inline">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </div>
          </details>
          <p className="mt-4 text-xs text-slate-500">
            Missing mailbox or Microsoft risk evidence does not disable
            qualified authentication findings. An elapsed activity window is
            history, not proof of remediation.
          </p>
        </>
      )}
      <RiskAssessmentDrawer user={selectedUser} onClose={closeDrawer} />
    </section>
  )
}
