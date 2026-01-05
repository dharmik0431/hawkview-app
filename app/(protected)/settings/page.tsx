'use client'

import { EmptyState } from '@/components/common/empty-state'
import { Settings } from 'lucide-react'

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
        <p className="text-muted-foreground mt-1">Configure your HawkView preferences</p>
      </div>
      <EmptyState
        icon={Settings}
        title="Settings coming soon"
        description="Application settings and configuration options will be available here."
      />
    </div>
  )
}
