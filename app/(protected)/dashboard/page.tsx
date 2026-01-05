'use client'

import { useDashboardSummary } from '@/lib/api/hooks'
import { LoadingState } from '@/components/common/loading-state'
import { ErrorState } from '@/components/common/error-state'
import { EmptyState } from '@/components/common/empty-state'
import { LayoutDashboard } from 'lucide-react'

export default function DashboardPage() {
  const { data, isLoading, isError, error } = useDashboardSummary()

  if (isLoading) {
    return <LoadingState message="Loading dashboard..." />
  }

  if (isError) {
    return <ErrorState message={error?.message || 'Failed to load dashboard'} />
  }

  if (!data?.hasTenant) {
    return (
      <EmptyState
        icon={LayoutDashboard}
        title="No tenant selected"
        description="Select a tenant from the Tenants page to view your dashboard."
        actionLabel="Go to Tenants"
        href="/tenants"
      />
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Overview of your Microsoft 365 environment</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="p-6 border rounded-lg bg-card">
          <p className="text-sm text-muted-foreground">Total Users</p>
          <p className="text-2xl font-bold">{data.stats?.totalUsers ?? 0}</p>
        </div>
        <div className="p-6 border rounded-lg bg-card">
          <p className="text-sm text-muted-foreground">Active Licenses</p>
          <p className="text-2xl font-bold">{data.stats?.activeLicenses ?? 0}</p>
        </div>
        <div className="p-6 border rounded-lg bg-card">
          <p className="text-sm text-muted-foreground">Groups</p>
          <p className="text-2xl font-bold">{data.stats?.groups ?? 0}</p>
        </div>
        <div className="p-6 border rounded-lg bg-card">
          <p className="text-sm text-muted-foreground">Apps</p>
          <p className="text-2xl font-bold">{data.stats?.apps ?? 0}</p>
        </div>
      </div>
    </div>
  )
}
