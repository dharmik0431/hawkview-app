'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { NotificationPanel } from '@/components/layout/notification-panel'
import { UserMenu } from '@/components/layout/user-menu'
import { MobileNavigation } from '@/components/layout/mobile-navigation'
import { apiClient } from '@/lib/api/client'
import { tenantNameFromBundleResponse } from '@/lib/tenants/tenant-api-view'
import { useAuth } from '@/components/providers/auth-provider'
import { IdentityScopedMemoryCache } from '@/lib/auth/data-isolation'

const pageTitles: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/tenants': 'Tenants',
  '/reports': 'Reports',
  '/alerts': 'Alerts & Notifications',
  '/activity': 'Activity Logs',
  '/what-changed': 'What Changed?',
  '/users': 'User Directory',
  '/licensing': 'Licensing Overview',
  '/security': 'Security Insights',
  '/admin': 'Admin Settings',
  '/integrations': 'Integrations',
  '/settings': 'Microsoft Connector',
  '/settings/team': 'Admin Panel',
  '/team-access': 'Admin Panel',
  '/profile': 'Profile Settings',
  '/profile/security': 'Account & Security',
  '/profile/notifications': 'Notification Settings',
  '/profile/appearance': 'Appearance',
  '/billing': 'Billing',
}

// Module-level in-memory cache for tenant names to ensure instant transitions
const tenantNameCache = new IdentityScopedMemoryCache<string>()

export function Topbar() {
  const { cacheScope } = useAuth()
  const pathname = usePathname() || ''

  // Parse path segments to check for tenant routes (/tenants/[tenantId] or /tenants/[tenantId]/[module])
  const segments = useMemo(() => pathname.split('/').filter(Boolean), [pathname])
  const isTenantRoute = segments[0] === 'tenants' && segments.length >= 2
  const tenantId = isTenantRoute ? segments[1] : null

  const [tenantNameState, setTenantNameState] = useState<{
    scope: string
    tenantId: string | null
    name: string | null
  }>(() => {
    return {
      scope: cacheScope,
      tenantId,
      name: tenantId ? tenantNameCache.get(cacheScope, tenantId) : null,
    }
  })
  const tenantName =
    tenantNameState.scope === cacheScope &&
    tenantNameState.tenantId === tenantId
      ? tenantNameState.name
      : null

  useEffect(() => {
    if (!tenantId) {
      setTenantNameState({ scope: cacheScope, tenantId: null, name: null })
      return
    }

    const cachedName = tenantNameCache.get(cacheScope, tenantId)
    if (cachedName) {
      setTenantNameState({ scope: cacheScope, tenantId, name: cachedName })
      return
    }

    setTenantNameState({ scope: cacheScope, tenantId, name: null })

    let isMounted = true

    // Fetch tenant list or specific tenant bundle
    apiClient
      .get<any>('/api/tenants')
      .then((data) => {
        if (!isMounted) return
        const tenants = data?.tenants || []
        tenants.forEach((t: any) => {
          if (t.id && t.name)
            tenantNameCache.set(cacheScope, String(t.id), t.name)
          if (t.microsoftTenantId && t.name)
            tenantNameCache.set(
              cacheScope,
              String(t.microsoftTenantId),
              t.name
            )
        })

        const matched = tenants.find(
          (t: any) =>
            String(t.id) === tenantId || String(t.microsoftTenantId) === tenantId
        )

        if (matched?.name) {
          setTenantNameState({ scope: cacheScope, tenantId, name: matched.name })
        } else {
          // Fallback to specific bundle endpoint if not in list
          apiClient
            .get<any>(`/api/tenants/${encodeURIComponent(tenantId)}`)
            .then((response) => {
              const name = tenantNameFromBundleResponse(response)
              if (isMounted && name) {
                tenantNameCache.set(cacheScope, tenantId, name)
                setTenantNameState({ scope: cacheScope, tenantId, name })
              }
            })
            .catch(() => {})
        }
      })
      .catch(() => {})

    return () => {
      isMounted = false
    }
  }, [cacheScope, tenantId])

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
      <MobileNavigation />
      {!isHideTitleRoute && (
        <h1
          className="text-xl font-semibold text-foreground truncate max-w-[200px] sm:max-w-[360px] md:max-w-md lg:max-w-lg"
          title={pageTitle}
        >
          {pageTitle}
        </h1>
      )}

      <div className="flex flex-1 justify-end items-center gap-x-3 sm:gap-x-4">
        {/* Notification Bell Panel */}
        <NotificationPanel />

        {/* User Menu Avatar & Dropdown */}
        <UserMenu />
      </div>
    </div>
  )
}
