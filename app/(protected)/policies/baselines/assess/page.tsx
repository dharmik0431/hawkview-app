'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useAuth } from '@/components/providers/auth-provider'
import { apiClient } from '@/lib/api/client'
import {
  canManagePolicies,
  manageablePolicyOrganizationIds,
} from '@/lib/auth/policy-access'

type Result = {
  id: string
  title: string
  service: string
  source: string
  expected: string
  guidance: string
  observed: string
  observedAt: string | null
  reason: string | null
  outcome: 'MET' | 'NEEDS_ACTION' | 'UNABLE_TO_ASSESS'
}
type Assessment = {
  tenantId: string
  tenantName: string
  tenantDomain: string | null
  baselines: Array<{ id: string; name: string }>
  assignment: { baselineId: string } | null
  results: Result[]
  summary: {
    selected: number
    met: number
    needsAction: number
    unableToAssess: number
  }
  evidenceNote: string
  assessedAt: string
}
const statusLabel = {
  MET: 'Met',
  NEEDS_ACTION: 'Needs review',
  UNABLE_TO_ASSESS: 'Unable to assess',
}
const statusStyle = {
  MET: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  NEEDS_ACTION:
    'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  UNABLE_TO_ASSESS:
    'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
}

export default function BaselineAssessmentPage() {
  const { session, isLoading: sessionLoading } = useAuth()
  const query = useSearchParams()
  const tenantId = query.get('tenant')
  const workspaceId = query.get('workspace')
  const [assessment, setAssessment] = useState<Assessment | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resultFilter, setResultFilter] = useState<'ALL' | Result['outcome']>(
    'ALL'
  )
  const allowed =
    canManagePolicies(session) &&
    Boolean(
      workspaceId && manageablePolicyOrganizationIds(session).has(workspaceId)
    )
  useEffect(() => {
    if (!allowed || !tenantId) return
    const controller = new AbortController()
    setAssessment(null)
    setError(null)
    setResultFilter('ALL')
    void apiClient
      .get<Assessment>(
        `/api/tenants/${encodeURIComponent(tenantId)}/security-requirements`,
        { signal: controller.signal }
      )
      .then((result) => {
        if (!controller.signal.aborted) setAssessment(result)
      })
      .catch((caught) => {
        if (!controller.signal.aborted)
          setError(
            caught instanceof Error
              ? caught.message
              : 'Assessment could not be loaded.'
          )
      })
    return () => controller.abort()
  }, [allowed, tenantId])
  if (sessionLoading) return <p role="status">Loading…</p>
  if (!allowed || !tenantId)
    return (
      <p role="alert">
        This assessment is available to MSP owners and admins in an active
        workspace.
      </p>
    )
  const selected = assessment?.baselines.find(
    (item) => item.id === assessment.assignment?.baselineId
  )
  const focus =
    assessment?.results.find((result) => result.outcome === 'NEEDS_ACTION') ??
    assessment?.results.find((result) => result.outcome === 'UNABLE_TO_ASSESS')
  const visibleResults =
    assessment?.results.filter(
      (result) => resultFilter === 'ALL' || result.outcome === resultFilter
    ) ?? []
  return (
    <div className="space-y-5 pb-8">
      <Link
        className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-300"
        href={`/policies/baselines?workspace=${encodeURIComponent(workspaceId!)}`}
      >
        ← Baseline library
      </Link>
      <header>
        <p className="text-xs font-semibold uppercase text-blue-700">
          Policies / Baseline / Assessment
        </p>
        <h1 className="mt-1 text-2xl font-bold">
          {assessment?.tenantName ?? 'Tenant review'}
        </h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {assessment?.tenantDomain ? `${assessment.tenantDomain} · ` : ''}
          {selected ? `${selected.name} · ` : ''}Only the assigned baseline’s
          selected settings are assessed from stored evidence.
        </p>
        {assessment && (
          <p className="mt-1 text-xs text-slate-500">
            Tenant ID: {assessment.tenantId}
          </p>
        )}
        {selected && (
          <Link
            className="mt-3 inline-block text-sm font-medium text-blue-700 hover:underline dark:text-blue-300"
            href={`/policies/baselines?workspace=${encodeURIComponent(workspaceId!)}&baseline=${encodeURIComponent(selected.id)}`}
          >
            Manage this baseline →
          </Link>
        )}
      </header>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800"
        >
          {error}
        </p>
      )}
      {!assessment && !error && <p role="status">Loading stored assessment…</p>}
      {assessment && (
        <>
          <div
            className="grid gap-3 sm:grid-cols-4"
            aria-label="Selected requirement results"
          >
            {[
              ['Selected', assessment.summary.selected],
              ['Met', assessment.summary.met],
              ['Needs review', assessment.summary.needsAction],
              ['Unable to assess', assessment.summary.unableToAssess],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="text-xs font-semibold uppercase text-slate-500">
                  {label}
                </div>
                <div className="mt-1 text-2xl font-bold">{value}</div>
              </div>
            ))}
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {assessment.evidenceNote} Reviewed at{' '}
            {new Date(assessment.assessedAt).toLocaleString()}.
          </p>
          {!selected && (
            <div className="rounded-xl border border-dashed p-6 text-sm text-slate-600">
              No baseline is assigned to this tenant.
            </div>
          )}
          {selected && assessment.results.length > 0 && (
            <section
              className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
              aria-labelledby="review-focus"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {focus?.outcome === 'NEEDS_ACTION'
                  ? 'First selected setting to review'
                  : focus
                    ? 'Evidence needed before a verdict'
                    : 'Selected settings reviewed'}
              </p>
              <h2 id="review-focus" className="mt-1 text-lg font-semibold">
                {focus?.title ?? 'No selected setting currently needs review'}
              </h2>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                {focus?.outcome === 'NEEDS_ACTION'
                  ? 'The observed setting does not meet the MSP’s chosen requirement. HawkView has made no Microsoft change.'
                  : focus
                    ? 'A selected requirement cannot be assessed from the current stored evidence. This is not a failed setting.'
                    : 'Every selected check met its expected stored setting at this assessment time. This does not assess unselected controls.'}
              </p>
              {focus && (
                <div className="mt-4 grid gap-4 border-t border-slate-200 pt-4 text-sm dark:border-slate-800 sm:grid-cols-2">
                  <div>
                    <span className="text-slate-500">Your requirement</span>
                    <p>{focus.expected}</p>
                  </div>
                  <div>
                    <span className="text-slate-500">Observed</span>
                    <p>{focus.observed}</p>
                  </div>
                  <div>
                    <span className="text-slate-500">Source</span>
                    <p>{focus.source}</p>
                  </div>
                  <div>
                    <span className="text-slate-500">Evidence observed</span>
                    <p>
                      {focus.observedAt
                        ? new Date(focus.observedAt).toLocaleString()
                        : 'No usable evidence'}
                    </p>
                  </div>
                  <div className="sm:col-span-2">
                    <span className="text-slate-500">Next step</span>
                    <p>
                      {focus.outcome === 'NEEDS_ACTION'
                        ? focus.guidance
                        : focus.reason}
                    </p>
                  </div>
                </div>
              )}
            </section>
          )}
          {assessment.results.length > 0 && (
            <section aria-labelledby="selected-requirements">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                <h2
                  id="selected-requirements"
                  className="text-lg font-semibold"
                >
                  Selected requirements
                </h2>
                <p className="text-xs text-slate-500">
                  {assessment.summary.selected} checks in this assigned baseline
                </p>
              </div>
              <div
                className="mb-3 flex flex-wrap gap-2"
                role="group"
                aria-label="Filter requirement results"
              >
                {(
                  [
                    ['ALL', 'All', assessment.summary.selected],
                    [
                      'NEEDS_ACTION',
                      'Needs review',
                      assessment.summary.needsAction,
                    ],
                    [
                      'UNABLE_TO_ASSESS',
                      'Unable to assess',
                      assessment.summary.unableToAssess,
                    ],
                    ['MET', 'Met', assessment.summary.met],
                  ] as const
                ).map(([value, label, count]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={resultFilter === value}
                    className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                      resultFilter === value
                        ? 'border-blue-600 bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200'
                        : 'border-slate-200 text-slate-600 hover:border-blue-300 dark:border-slate-700 dark:text-slate-300'
                    }`}
                    onClick={() => setResultFilter(value)}
                  >
                    {label} {count}
                  </button>
                ))}
              </div>
              <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                {visibleResults.length === 0 && (
                  <p className="p-5 text-sm text-slate-500">
                    No selected requirements have this result.
                  </p>
                )}
                {visibleResults.map((result) => (
                  <details key={result.id} className="group px-5 py-4">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
                      <span>
                        <span className="block font-medium">
                          {result.title}
                        </span>
                        <span className="text-xs text-slate-500">
                          {result.service} · {result.observed}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyle[result.outcome]}`}
                        >
                          {statusLabel[result.outcome]}
                        </span>
                        <span className="text-xs text-blue-700 group-open:hidden dark:text-blue-300">
                          View evidence ▾
                        </span>
                        <span className="hidden text-xs text-blue-700 group-open:inline dark:text-blue-300">
                          Hide evidence ▴
                        </span>
                      </span>
                    </summary>
                    <dl className="mt-4 grid gap-3 border-t border-slate-200 pt-4 text-sm dark:border-slate-800 sm:grid-cols-2">
                      <div>
                        <dt className="text-slate-500">Your requirement</dt>
                        <dd>{result.expected}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Observed</dt>
                        <dd>{result.observed}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Source</dt>
                        <dd>{result.source}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Evidence observed</dt>
                        <dd>
                          {result.observedAt
                            ? new Date(result.observedAt).toLocaleString()
                            : 'No usable evidence'}
                        </dd>
                      </div>
                    </dl>
                    {result.reason && (
                      <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                        {result.reason}
                      </p>
                    )}
                    {result.outcome === 'NEEDS_ACTION' && (
                      <p className="mt-3 text-sm font-medium">
                        Suggested review: {result.guidance}
                      </p>
                    )}
                  </details>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
