'use client'

import { useTenants } from '@/lib/api/hooks'
import { LoadingState } from '@/components/common/loading-state'
import { ErrorState } from '@/components/common/error-state'
import { EmptyState } from '@/components/common/empty-state'
import { Building2 } from 'lucide-react'

export default function TenantsPage() {
  const { data, isLoading, isError, error } = useTenants()

  if (isLoading) {
    return <LoadingState message="Loading tenants..." />
  }

  if (isError) {
    return <ErrorState message={error?.message || 'Failed to load tenants'} />
  }

  if (!data?.tenants?.length) {
    return (
      <EmptyState
        icon={Building2}
        title="No tenants connected"
        description="Connect Microsoft 365 to begin managing your tenants."
        actionLabel="Connect Microsoft 365"
        onAction={() => {}}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Tenants</h1>
        <p className="text-muted-foreground mt-1">Manage your Microsoft 365 tenants</p>
      </div>
      <div className="grid gap-4">
        {data.tenants.map((tenant) => (
          <div key={tenant.id} className="p-4 border rounded-lg bg-card">
            <h3 className="font-medium">{tenant.name}</h3>
            <p className="text-sm text-muted-foreground">{tenant.domain}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
