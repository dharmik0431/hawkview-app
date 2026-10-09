'use client'

import { useEffect, useState } from 'react'
import { hasIncompleteActivityEvidence, normalizeSignInEvent, normalizeAuditEvent } from '@/app/(protected)/activity/data/normalize'
import { buildSharePointViewModel } from '@/lib/tenants/sharepoint-view-model'
import { SectionFreshness } from './section-freshness'
import { datasetCadence } from '@/lib/tenants/dataset-cadence'
import { applicationsAge, servicePrincipalsAge, groupsAge, licensesAge, signInsAge, conditionalAccessAge, activityLogsAge, datasetAge, formatDatasetTime, dnsAge, sharePointReportAge, sharePointSettingsAge, licenseActivityAge, entraOverviewAge, exchangeAge } from '@/lib/tenants/dataset-age'
import { readinessLabel, readinessDiagnostic, type CollectionReadinessView } from '@/lib/tenants/collection-readiness'

function RecordedTime({ value }: { value: string | null }) {
  const [now, setNow] = useState(NaN)
  useEffect(() => { setNow(Date.now()) }, [value])
  const timestamp = datasetAge({ source: 'Collection', observedAt: value }, now).timestamp
  return timestamp ? <time dateTime={timestamp} title={timestamp}>{formatDatasetTime(timestamp)}</time> : <>Not reported or invalid</>

}

export function DataFreshnessDetails({ readiness, bundle, splitDirectoryRoles = false }: { readiness?: CollectionReadinessView; bundle?: Record<string, any>; splitDirectoryRoles?: boolean }) {
  if (bundle) {
    const context = { tenantId: bundle.tenant?.id, tenantName: bundle.tenant?.name }
    const signIns = (Array.isArray(bundle.signIns) ? bundle.signIns : []).map((event: any, index: number) => normalizeSignInEvent(event, { ...context, index }))
    const auditLogs = (Array.isArray(bundle.auditLogs) ? bundle.auditLogs : []).map((event: any, index: number) => normalizeAuditEvent(event, { ...context, index }))
    return <><div className="grid gap-4 sm:grid-cols-2">{[
    applicationsAge(bundle), servicePrincipalsAge(bundle), groupsAge(bundle), licensesAge(bundle, bundle.licenses?.rows), activityLogsAge(bundle, 'audit'),
    licenseActivityAge(), entraOverviewAge(), exchangeAge(), sharePointSettingsAge(),
    sharePointReportAge(buildSharePointViewModel(bundle.sharepoint ?? bundle.sharePoint ?? bundle.m365?.sharepoint ?? bundle.m365?.sharePoint ?? bundle.office365?.sharepoint ?? bundle.office365?.sharePoint ?? {})),
    ...Object.keys(bundle.dns?.byDomain ?? {}).map(domain => dnsAge(bundle.dns, domain)),
    ...(typeof bundle.dns?.domain === 'string' && !bundle.dns?.byDomain?.[bundle.dns.domain.toLowerCase()] ? [dnsAge(bundle.dns, bundle.dns.domain)] : []),
  ].map(evidence => <article key={evidence.source}><h3 className="mb-1 text-sm font-semibold">{evidence.source}</h3><SectionFreshness evidence={evidence} /></article>)}</div>
    {hasIncompleteActivityEvidence(signIns, auditLogs) && <p className="text-sm">Partial log evidence: some event fields were not reported. Missing values remain unknown.</p>}
    </>
  }
  if (!readiness) return null
  return <div className="space-y-6">
    <p className="text-sm text-slate-500">Age describes the last successful collection. A recent timestamp does not resolve a failed attempt, missing permission, or limited coverage.</p>
    <section className="rounded-xl border p-5"><h2 className="text-lg font-semibold">Selected evidence sources</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <article><h3 className="font-medium">Sign-in activity</h3><p className="text-sm">Source: {readiness.evidence.signIns.selectedSource ? readinessLabel(readiness.evidence.signIns.selectedSource) : 'Not reported'} · Coverage: {readinessLabel(readiness.evidence.signIns.coverage)}</p><p className="text-sm">{readiness.evidence.signIns.reason}</p><SectionFreshness evidence={signInsAge(readiness.evidence.signIns)} /></article>
        <article><h3 className="font-medium">Conditional Access</h3><p className="text-sm">Availability: {readinessLabel(readiness.evidence.conditionalAccess.availability)}</p><SectionFreshness evidence={conditionalAccessAge(readiness.evidence)} /></article>
      </div>
    </section>
    {readiness.workloads.length === 0 && <p role="status">Dataset collection details were not reported. This does not establish that the tenant has no datasets.</p>}
    {readiness.workloads.map(workload => {
      const split = splitDirectoryRoles && workload.key === 'entra_directory'
      const components = workload.components.filter(component => !splitDirectoryRoles || component.key !== 'DIRECTORY_ROLES')
      return <section key={workload.key} aria-label={split ? 'Other directory inventory' : workload.workload} className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-lg font-semibold">{split ? 'Other directory inventory' : workload.workload}</h2>
      {split && <p className="mt-1 text-sm">Directory role health is shown separately from the other directory inventory below.</p>}
      {!split && <p className="mt-1 text-sm">{readinessLabel(workload.state)}</p>}
      {!split && workload.reason && <p className="mt-2 text-sm">{readinessDiagnostic(workload.reasonCode, workload.reason)}</p>}
      {!split && workload.state !== 'READY' && workload.remediation && <p className="mt-2 text-sm">Next action: {workload.remediation}</p>}
      {!split && workload.datasets.length === 0 && <p className="mt-3 text-sm">Individual dataset details were not reported. Workload last success: <RecordedTime value={workload.lastSuccessfulAt} />.</p>}
      <div className="mt-4 space-y-4">{workload.datasets.map(dataset => {
        if (splitDirectoryRoles && dataset.key === 'entra_directory_roles') return <article key={dataset.key} className="rounded-lg border p-4">
          <h3 className="font-semibold">Directory roles access requirements</h3>
          <p className="text-sm">Collection evidence is shown in Directory role receipt health.</p>
          <ul className="text-sm">{dataset.permissions.map(permission => <li key={`${permission.resource}-${permission.name}`}>{permission.name} ({readinessLabel(permission.resource)})</li>)}</ul>
        </article>
        const cadence = datasetCadence(dataset.resourceTypes)
        return <article key={dataset.key} className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <h3 className="font-semibold">{dataset.label}</h3>
          <p className="mt-1 text-xs text-slate-500">Source: {dataset.resourceTypes.map(readinessLabel).join(', ') || 'Not durably observed'}</p>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="font-medium">Last successful collection</dt><dd className="break-words"><RecordedTime value={dataset.lastSuccessfulAt} /></dd></div>
            <div><dt className="font-medium">Last attempt</dt><dd className="break-words"><RecordedTime value={dataset.lastAttemptAt} /></dd></div>
            <div><dt className="font-medium">Expected cadence</dt><dd>{cadence.label}</dd></div>
            <div><dt className="font-medium">Collection state</dt><dd>{readinessLabel(dataset.state)}</dd></div>
          </dl>
          <div className="mt-3"><SectionFreshness evidence={{ source: dataset.label, observedAt: dataset.lastSuccessfulAt, ...cadence }} /></div>
          {dataset.reason && <p className="text-sm">{readinessDiagnostic(dataset.reasonCode, dataset.reason)}</p>}
          {dataset.state !== 'READY' && dataset.remediation && <p className="mt-2 text-sm">Next action: {dataset.remediation}</p>}
          <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium">Permissions, licensing, and diagnostics</summary><dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div><dt className="font-medium">Permissions</dt><dd>{readinessLabel(dataset.permissionStatus)}{dataset.permissions.length > 0 && <ul>{dataset.permissions.map(permission => <li key={`${permission.resource}-${permission.name}`}>{permission.name}: {readinessLabel(permission.grantStatus)} ({readinessLabel(permission.resource)})</li>)}</ul>}</dd></div>
            <div><dt className="font-medium">License prerequisite</dt><dd>{readinessLabel(dataset.licensePrerequisite.kind)} · {readinessLabel(dataset.licensePrerequisite.state)}</dd></div>
          <div><dt className="font-medium">Evidence basis</dt><dd>{readinessLabel(dataset.evidenceMode)}</dd></div>
          <div><dt className="font-medium">Coverage</dt><dd>{dataset.state === 'PARTIAL' ? 'Partial' : 'Not separately reported for this dataset'}</dd></div>
          <div><dt className="font-medium">Diagnostic code</dt><dd>{dataset.reasonCode || 'Not reported'}</dd></div></dl></details>
          {dataset.fallbackDatasetKey && <p className="mt-2 text-sm">Fallback source: {dataset.fallbackDatasetKey}</p>}
          {dataset.documentationUrl && <a className="mt-2 inline-block text-sm text-blue-700 hover:underline dark:text-blue-300" href={dataset.documentationUrl} target="_blank" rel="noreferrer">Microsoft documentation for {dataset.label}</a>}
        </article>
      })}</div>
      {workload.capabilities.map(capability => <p key={capability.key} className="mt-3 text-sm"><strong>{capability.label}:</strong> {capability.message}</p>)}
      {components.length > 0 && <details className="mt-4 text-sm"><summary className="cursor-pointer font-medium">Collector component details</summary>{components.map(component => <div key={component.key} className="mt-3"><strong>{component.label}: {readinessLabel(component.state)}</strong><p>{readinessDiagnostic(component.reasonCode, component.reason)}</p><p>Last success: <RecordedTime value={component.lastSuccessfulAt} /> · Last attempt: <RecordedTime value={component.lastAttemptAt} /></p></div>)}</details>}
    </section>})}
  </div>
}
