'use client'

import { EmptyState } from '@/components/common/empty-state'
import { FileBarChart } from 'lucide-react'

export default function ReportsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Reports</h1>
        <p className="text-muted-foreground mt-1">Analytics and reporting for your tenants</p>
      </div>
      <EmptyState
        icon={FileBarChart}
        title="No reports available"
        description="Connect a tenant and configure data sources to generate reports."
        actionLabel="Go to Tenants"
        href="/tenants"
      />
    </div>
  )
}
