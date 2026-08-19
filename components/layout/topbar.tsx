'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { FileText } from 'lucide-react'
import { NotificationPanel } from '@/components/layout/notification-panel'
import { UserMenu } from '@/components/layout/user-menu'
import { apiClient } from '@/lib/api/client'
import { tenantNameFromBundleResponse } from '@/lib/tenants/tenant-api-view'

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
  '/settings/team': 'Admin Panel',
  '/team-access': 'Admin Panel',
  '/profile': 'Profile Settings',
  '/billing': 'Billing',
}

// Module-level in-memory cache for tenant names to ensure instant transitions
const tenantNameCache = new Map<string, string>()

export function Topbar() {
  const pathname = usePathname() || ''

  // Parse path segments to check for tenant routes (/tenants/[tenantId] or /tenants/[tenantId]/[module])
  const segments = useMemo(() => pathname.split('/').filter(Boolean), [pathname])
  const isTenantRoute = segments[0] === 'tenants' && segments.length >= 2
  const tenantId = isTenantRoute ? segments[1] : null

  const [tenantName, setTenantName] = useState<string | null>(() => {
    return tenantId ? tenantNameCache.get(tenantId) || null : null
  })

  useEffect(() => {
    if (!tenantId) {
      setTenantName(null)
      return
    }

    if (tenantNameCache.has(tenantId)) {
      setTenantName(tenantNameCache.get(tenantId)!)
      return
    }

    let isMounted = true

    // Fetch tenant list or specific tenant bundle
    apiClient
      .get<any>('/api/tenants')
      .then((data) => {
        if (!isMounted) return
        const tenants = data?.tenants || []
        tenants.forEach((t: any) => {
          if (t.id && t.name) tenantNameCache.set(String(t.id), t.name)
          if (t.microsoftTenantId && t.name)
            tenantNameCache.set(String(t.microsoftTenantId), t.name)
        })

        const matched = tenants.find(
          (t: any) =>
            String(t.id) === tenantId || String(t.microsoftTenantId) === tenantId
        )

        if (matched?.name) {
          setTenantName(matched.name)
        } else {
          // Fallback to specific bundle endpoint if not in list
          apiClient
            .get<any>(`/api/tenants/${encodeURIComponent(tenantId)}`)
            .then((response) => {
              const name = tenantNameFromBundleResponse(response)
              if (isMounted && name) {
                tenantNameCache.set(tenantId, name)
                setTenantName(name)
              }
            })
            .catch(() => {})
        }
      })
      .catch(() => {})

    return () => {
      isMounted = false
    }
  }, [tenantId])

  const isAdminRoute = pathname === '/admin' || pathname.startsWith('/admin/')
  const isHideTitleRoute =
    pathname === '/settings/team' || isAdminRoute || pathname === '/team-access'

  const pageTitle = useMemo(() => {
    if (isAdminRoute) return 'Admin Panel'
    if (isTenantRoute) {
      return tenantName || 'Tenant'
    }
    return pageTitles[pathname] || 'Dashboard'
  }, [isAdminRoute, isTenantRoute, tenantName, pathname])

  return (
    <div className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-x-4 border-b border-border bg-background px-4 shadow-sm sm:gap-x-6 sm:px-6 lg:px-8">
      {!isHideTitleRoute && (
        <h1
          className="text-xl font-semibold text-foreground truncate max-w-[200px] sm:max-w-[360px] md:max-w-md lg:max-w-lg"
          title={pageTitle}
        >
          {pageTitle}
        </h1>
      )}

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
