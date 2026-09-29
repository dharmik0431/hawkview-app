'use client'

import type { TenantWorkspaceDisplay } from '@/lib/tenant-workspace-state'
import { readAttentionProvenance } from '@/backend/src/tenants/attention-provenance'

function field(value: unknown, key: string, fallback: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  const text = (value as Record<string, unknown>)[key]
  return typeof text === 'string' && text.trim() ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000) : fallback
}

/** Optional detail on the existing tenant-authorized settings route; never an operator inbox. */
export function CustomerEvidenceDetails({ display }: { display: TenantWorkspaceDisplay }) {
  const view = display.customer
  const records = [...(view?.operations ?? []), ...(view?.limitations ?? []), ...(view?.unknown ?? [])]
  const observations = display.syncObservations.filter(row => row.diagnostic !== null)
  return <details className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
    <summary className="cursor-pointer text-sm font-semibold">Collection and unclassified evidence details</summary>
    <p className="mt-3 text-xs text-slate-500">These records describe evidence availability and collection. They are excluded from tenant finding counts. A recorded owner does not confirm delivery, acknowledgement, or active investigation.</p>
    {records.map((value, index) => {
      const p = readAttentionProvenance(value && typeof value === 'object' ? (value as Record<string, unknown>).provenance : undefined)
      const owner = p.remediationOwner === 'HAWKVIEW_OPERATIONS' ? 'Recorded owner: HawkView operations' : 'Responsibility not established'
      return <article key={index} className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
        <h3 className="text-sm font-medium">{field(value, 'label', 'Unclassified evidence record')}</h3>
        <p className="mt-1 text-xs text-slate-500">{p.origin === 'COLLECTION_OPERATION' ? `Collection · ${p.resourceType} · ${owner}` : p.origin === 'EVIDENCE_LIMITATION' ? 'Evidence limitation' : 'Unclassified · Responsibility not established'}</p>
        <p className="mt-2 break-words text-sm">{field(value, 'why', 'A readable explanation was not supplied. The original record remains in the tenant response.')}</p>
      </article>
    })}
    {observations.map((row,index) => <article key={`sync-${index}`} className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800"><h3 className="text-sm font-medium">Recorded collection detail: {row.resource}</h3><p className="mt-1 text-xs text-slate-500">{row.detail}</p><p className="mt-2 break-words text-sm">{row.diagnostic}</p></article>)}
    {!records.length && !observations.length && <p className="mt-3 text-sm text-slate-500">No readable diagnostic records supplied in this summary. Review the workload and synchronization records below; unavailable evidence is not proof of successful collection.</p>}
  </details>
}
