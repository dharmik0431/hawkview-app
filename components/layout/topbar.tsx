'use client'

import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { FileText } from 'lucide-react'
import { NotificationPanel } from '@/components/layout/notification-panel'
import { UserMenu } from '@/components/layout/user-menu'

const pageTitles: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/tenants': 'Tenants',
  '/reports': 'Reports',
  '/alerts': 'Alerts & Notifications',
  '/activity': 'Activity Logs',
  '/users': 'User Directory',
  '/licensing': 'Licensing Overview',
  '/security': 'Security Insights',
  '/admin': 'Admin Settings',
  '/integrations': 'Integrations',
  '/settings': 'Account Settings',
  '/settings/team': 'Team access',
  '/profile': 'Profile Settings',
  '/billing': 'Billing',
}

export function Topbar() {
  const pathname = usePathname()
  const pageTitle = (pathname ? pageTitles[pathname] : undefined) || 'Dashboard'

  return (
    <div className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-x-4 border-b border-border bg-background px-4 shadow-sm sm:gap-x-6 sm:px-6 lg:px-8">
      <h1 className="text-xl font-semibold text-foreground">{pageTitle}</h1>

      <div className="flex flex-1 justify-end items-center gap-x-3 sm:gap-x-4">
        {/* Changelog button */}
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-muted-foreground hover:text-foreground"
          aria-label="Changelog"
        >
          <FileText className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Changelog</span>
        </Button>

        {/* Notification Bell Panel */}
        <NotificationPanel />

        {/* User Menu Avatar & Dropdown */}
        <UserMenu />
      </div>
    </div>
  )
}
