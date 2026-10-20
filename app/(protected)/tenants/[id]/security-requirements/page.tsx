'use client'

import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuth } from '@/components/providers/auth-provider'
import { canManagePolicies } from '@/lib/auth/policy-access'
import { tenantOverviewPath } from '@/lib/tenants/navigation'

/** Preserve old local bookmarks while removing baseline from the tenant blade. */
export default function FormerTenantBaselinePage() {
  const { session, isLoading } = useAuth()
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  useEffect(() => {
    if (isLoading || !id) return
    router.replace(canManagePolicies(session)
      ? `/policies/baselines?tenant=${encodeURIComponent(id)}`
      : tenantOverviewPath(id))
  }, [id, isLoading, router, session])

  return <div role="status" className="p-6 text-sm text-slate-600">Opening the Policies area…</div>
}
