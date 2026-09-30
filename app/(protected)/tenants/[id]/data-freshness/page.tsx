'use client'

import { useFeatureFlags } from '@/components/providers/feature-flag-provider'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useTenantBundle, useTenantOperationalProjection } from '@/lib/api/hooks'
import { normalizeCollectionReadiness } from '@/lib/tenants/collection-readiness'
import { tenantOverviewPath } from '@/lib/tenants/navigation'
import { DataFreshnessDetails } from '@/components/tenant/data-freshness-details'
import { RiskyUsersOverviewRow } from '@/components/identity-risk/risky-users-overview-row'

export default function DataFreshnessPage() {
  const { identityRiskUi } = useFeatureFlags()
  const params = useParams<{ id: string }>()
  const tenantId = typeof params.id === 'string' ? params.id : ''
  const projection = useTenantOperationalProjection(tenantId)
  const query = useTenantBundle(tenantId)
  const matches = projection.tenant?.id.toLowerCase() === tenantId.toLowerCase()
  const readiness = projection.status === 'READY' && matches
    ? normalizeCollectionReadiness(projection.tenant?.collectionReadiness) : null
  const responseBundle = query.data?.bundle
  const bundle = !query.isLoading && !query.isError && typeof responseBundle?.tenant?.id === 'string' && responseBundle.tenant.id.toLowerCase() === tenantId.toLowerCase() ? responseBundle : null
  return <main className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-8">
    <Link href={tenantOverviewPath(tenantId)} className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-300">Back to tenant overview</Link>
    <header><h1 className="text-2xl font-bold">Data freshness</h1><p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{matches && projection.status === 'READY' ? projection.tenant?.name : 'Tenant'} · Collection times, source coverage, and access requirements.</p></header>
    {projection.status === 'LOADING' ? <p role="status">Loading collection details…</p> : !readiness ? <section role="alert" className="rounded-xl border p-5"><h2 className="font-semibold">Collection details unavailable</h2><p className="mt-2 text-sm">The tenant’s collection evidence could not be verified. No successful or empty collection is inferred.</p><button className="mt-3 text-sm font-medium text-blue-700" onClick={() => void projection.refetch()}>Retry collection details</button></section> : <DataFreshnessDetails readiness={readiness} />}
    <section className="rounded-xl border p-5"><h2 className="mb-3 text-lg font-semibold">Displayed inventory snapshots</h2>{query.isLoading ? <p role="status">Loading snapshot times…</p> : bundle ? <DataFreshnessDetails bundle={bundle} /> : <><p role="status">Snapshot times unavailable for this tenant.</p><button className="mt-3 text-sm font-medium text-blue-700" onClick={() => void query.refetch()}>Retry snapshot times</button></>}</section>
    {identityRiskUi && tenantId && <RiskyUsersOverviewRow key={tenantId} tenantId={tenantId} showCollectionDetails />}
  </main>
}
