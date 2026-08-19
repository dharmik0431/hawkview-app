'use client'

import React from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { tenantOverviewPath } from '@/lib/tenants/navigation'

export type TenantBreadcrumbProps = {
  tenantId: string
  tenantName: string
  section: string
  heading?: string
}

export function TenantBreadcrumb({
  tenantId,
  tenantName,
  section,
  heading,
}: TenantBreadcrumbProps) {
  const isOverview = section === 'overview'
  const displayName = tenantName || 'Tenant'

  // Map module key to human readable display label
  const moduleLabel = (() => {
    if (section === 'sharepoint') return 'SharePoint & OneDrive'
    if (section === 'home') return 'Office 365'
    if (section === 'entra') return 'Entra ID'
    if (section === 'exchange') return 'Exchange'
    if (section === 'settings') return 'Tenant Settings'
    if (section === 'teams') return 'Teams'
    if (section === 'dns') return 'DNS & Domains'
    if (section === 'directory') return 'Directory'
    if (section === 'gmail') return 'Gmail'
    if (section === 'drive') return 'Drive'
    if (section === 'security') return 'Security'
    return heading || 'Workspace'
  })()

  return (
    <nav aria-label="Breadcrumb" className="w-full">
      <ol className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 flex-wrap min-w-0">
        {/* Step 1: Tenants Directory */}
        <li className="inline-flex items-center shrink-0">
          <Link
            href="/tenants"
            className="hover:text-slate-900 dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1 -mx-1 font-medium"
            title="Tenants Directory"
          >
            Tenants
          </Link>
        </li>

        {/* Separator */}
        <li className="inline-flex items-center shrink-0 text-slate-400 dark:text-slate-600" aria-hidden="true">
          <ChevronRight className="h-3.5 w-3.5" />
        </li>

        {/* Step 2: Tenant Overview or Current Tenant Link */}
        {isOverview ? (
          <li className="inline-flex items-center min-w-0 font-medium text-slate-900 dark:text-white shrink truncate">
            <span
              aria-current="page"
              className="truncate max-w-[180px] sm:max-w-[320px]"
              title={displayName}
            >
              {displayName}
            </span>
          </li>
        ) : (
          <>
            <li className="inline-flex items-center min-w-0 shrink truncate">
              <Link
                href={tenantOverviewPath(tenantId)}
                className="hover:text-slate-900 dark:hover:text-white transition-colors truncate max-w-[140px] sm:max-w-[240px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1 -mx-1"
                title={displayName}
              >
                {displayName}
              </Link>
            </li>

            {/* Separator */}
            <li className="inline-flex items-center shrink-0 text-slate-400 dark:text-slate-600" aria-hidden="true">
              <ChevronRight className="h-3.5 w-3.5" />
            </li>

            {/* Step 3: Current Module */}
            <li className="inline-flex items-center min-w-0 font-medium text-slate-900 dark:text-white shrink truncate">
              <span
                aria-current="page"
                className="truncate max-w-[160px] sm:max-w-[280px]"
                title={moduleLabel}
              >
                {moduleLabel}
              </span>
            </li>
          </>
        )}
      </ol>
    </nav>
  )
}

export default TenantBreadcrumb
