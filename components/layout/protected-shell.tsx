'use client'

import { useState } from 'react'
import { Sidebar } from '@/components/layout/sidebar'
import { Topbar } from '@/components/layout/topbar'

export function ProtectedShell({ children }: { children: React.ReactNode }) {
  const [isNavigationOpen, setIsNavigationOpen] = useState(false)

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <Sidebar
        mobileOpen={isNavigationOpen}
        onMobileClose={() => setIsNavigationOpen(false)}
      />
      <div className="lg:pl-52">
        <Topbar onMenuClick={() => setIsNavigationOpen(true)} />
        <main className="px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  )
}
