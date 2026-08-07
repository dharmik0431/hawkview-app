'use client'

import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  Activity,
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  HardDrive,
  Mail,
  Search,
  Settings,
  Users,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TenantWorkspaceDisplay } from '@/lib/tenant-workspace-state'
import { getServiceTheme } from './service-theme'

export type TenantSection = string

type NavGroup = {
  title: string
  items: {
    key: TenantSection
    label: string
    icon: React.ElementType
    disabled?: boolean
  }[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Overview',
    items: [
      { key: 'overview', label: 'Tenant Overview', icon: Activity },
    ],
  },
  {
    title: 'Services',
    items: [
      { key: 'home', label: 'Office 365', icon: Cloud },
      { key: 'entra', label: 'Entra ID', icon: Users },
      { key: 'exchange', label: 'Exchange', icon: Mail },
      { key: 'sharepoint', label: 'SharePoint / OneDrive', icon: HardDrive },
      { key: 'teams', label: 'Teams', icon: Building2, disabled: true },
    ],
  },
  {
    title: 'Management',
    items: [
      { key: 'settings', label: 'Tenant Settings', icon: Settings },
    ],
  },
]

function MicrosoftMark() {
  return (
    <div className="grid h-5 w-5 grid-cols-2 gap-0.5 shrink-0" aria-hidden="true">
      <span className="h-2 w-2 rounded-[1px] bg-[#F25022]" />
      <span className="h-2 w-2 rounded-[1px] bg-[#7FBA00]" />
      <span className="h-2 w-2 rounded-[1px] bg-[#00A4EF]" />
      <span className="h-2 w-2 rounded-[1px] bg-[#FFB900]" />
    </div>
  )
}

export function TenantBlade({
  tenant,
  display,
  currentSection,
  onSelectSection,
  tenants,
  onTenantChange,
  isCollapsed,
  onToggleCollapse,
  isMobileOpen,
  onMobileClose,
}: {
  tenant: any
  display: TenantWorkspaceDisplay
  currentSection: TenantSection
  onSelectSection: (section: TenantSection) => void
  tenants: any[]
  onTenantChange: (tenantId: string) => void
  isCollapsed: boolean
  onToggleCollapse: () => void
  isMobileOpen: boolean
  onMobileClose: () => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerSearch, setPickerSearch] = useState('')

  const filteredTenants = tenants.filter((t) => {
    if (!pickerSearch.trim()) return true
    const q = pickerSearch.toLowerCase()
    return (
      (t.name && t.name.toLowerCase().includes(q)) ||
      (t.domain && t.domain.toLowerCase().includes(q)) ||
      (t.id && t.id.toLowerCase().includes(q))
    )
  })

  // Keyboard navigation & accessibility for escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pickerOpen) setPickerOpen(false)
        if (isMobileOpen) onMobileClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [pickerOpen, isMobileOpen, onMobileClose])

  const settingsTheme = getServiceTheme('settings')

  const bladeContent = (
    <div className="flex h-full flex-col bg-slate-50/90 dark:bg-slate-900/90 border-r border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 transition-all duration-200 select-none rounded-l-lg">
      {/* Top Tenant Selector Header */}
      <div className="shrink-0 relative border-b border-slate-200 dark:border-slate-800 p-2.5">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          aria-expanded={pickerOpen}
          aria-haspopup="listbox"
          title={isCollapsed ? `${tenant?.name || 'Tenant'} (${tenant?.domain || ''})` : 'Switch Tenant'}
          className={cn(
            'flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-2 text-left shadow-xs transition hover:border-slate-300 dark:hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer',
            isCollapsed && 'justify-center p-2'
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            <MicrosoftMark />
            {!isCollapsed && (
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                  {tenant?.name || 'Microsoft 365'}
                </div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {tenant?.domain || 'Primary Domain'}
                </div>
              </div>
            )}
          </div>
          {!isCollapsed && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
        </button>

        {/* Tenant Picker Dropdown */}
        {pickerOpen && (
          <div className="absolute left-2.5 right-2.5 top-full z-50 mt-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2 shadow-xl animate-in fade-in-0 zoom-in-95">
            <div className="relative mb-2">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search tenants..."
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 py-1.5 pl-8 pr-3 text-xs text-slate-900 dark:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              />
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {filteredTenants.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setPickerOpen(false)
                    onTenantChange(item.id)
                  }}
                  className={cn(
                    'w-full text-left px-2.5 py-1.5 rounded-md text-xs transition flex items-center justify-between cursor-pointer',
                    item.id === tenant?.id
                      ? 'bg-blue-50 dark:bg-blue-950/60 font-semibold text-blue-700 dark:text-blue-300'
                      : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                  )}
                >
                  <div className="min-w-0 pr-2">
                    <div className="truncate font-medium">{item.name || item.domain || item.id}</div>
                    <div className="truncate text-[10px] text-slate-400">{item.domain}</div>
                  </div>
                  {item.id === tenant?.id && <span className="h-1.5 w-1.5 rounded-full bg-blue-600 dark:bg-blue-400 shrink-0" />}
                </button>
              ))}
              {filteredTenants.length === 0 && (
                <div className="p-3 text-center text-xs text-slate-400">No matching tenants</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Main Tenant Navigation Links */}
      <nav aria-label="Tenant Blade Navigation" className="flex-1 min-h-0 overflow-y-auto px-2 py-3 space-y-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="space-y-1">
            {!isCollapsed && (
              <div className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                {group.title}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon
                const isActive = currentSection === item.key
                const theme = getServiceTheme(item.key)

                if (item.disabled) {
                  return (
                    <span
                      key={item.key}
                      title={`${item.label} (Coming Soon)`}
                      className="relative block group"
                    >
                      <button
                        type="button"
                        disabled
                        aria-disabled="true"
                        className={cn(
                          'relative flex w-full min-h-[40px] items-center gap-2.5 rounded-md px-2.5 py-2.5 text-sm font-medium text-slate-400 dark:text-slate-500 opacity-50 cursor-not-allowed',
                          isCollapsed && 'justify-center px-2'
                        )}
                      >
                        <Icon className="h-[18px] w-[18px] shrink-0 text-slate-400" aria-hidden="true" />
                        {!isCollapsed && <span className="truncate">{item.label}</span>}
                      </button>
                    </span>
                  )
                }

                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      onSelectSection(item.key)
                      if (isMobileOpen) onMobileClose()
                    }}
                    aria-current={isActive ? 'page' : undefined}
                    title={isCollapsed ? item.label : undefined}
                    className={cn(
                      'relative flex w-full min-h-[40px] items-center gap-2.5 rounded-md px-2.5 py-2.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset cursor-pointer',
                      isActive
                        ? cn(
                            theme.bladeActiveBg,
                            theme.bladeActiveText,
                            'before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-1 before:rounded-r-md',
                            theme.bladeLeftRail
                          )
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-white',
                      isCollapsed && 'justify-center px-2'
                    )}
                  >
                    <Icon
                      className={cn(
                        'h-[18px] w-[18px] shrink-0 transition-colors',
                        isActive ? theme.bladeActiveIcon : 'text-slate-500 dark:text-slate-400'
                      )}
                      aria-hidden="true"
                    />
                    {!isCollapsed && <span className="truncate">{item.label}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </nav>
    </div>
  )

  return (
    <>
      {/* Desktop / Tablet Sidebar Blade */}
      <aside
        className={cn(
          'hidden md:block shrink-0 h-full transition-all duration-200 z-20 relative select-none',
          isCollapsed ? 'w-[68px]' : 'w-[250px]'
        )}
      >
        {bladeContent}

        {/* Small Circular Collapse/Expand Control on Right Boundary */}
        <button
          type="button"
          onClick={onToggleCollapse}
          title={isCollapsed ? 'Expand tenant navigation' : 'Collapse tenant navigation'}
          aria-label={isCollapsed ? 'Expand tenant navigation' : 'Collapse tenant navigation'}
          className="absolute -right-3 top-5 z-30 flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 shadow-sm hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
        >
          {isCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronLeft className="h-3.5 w-3.5" />
          )}
        </button>
      </aside>

      {/* Mobile Drawer Navigation */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity"
            onClick={onMobileClose}
            aria-hidden="true"
          />
          <div className="relative w-72 max-w-[80vw] h-full shadow-2xl z-10 flex flex-col">
            <button
              type="button"
              onClick={onMobileClose}
              className="absolute right-3 top-3 z-20 p-1.5 rounded-lg bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
              aria-label="Close tenant drawer"
            >
              <X className="h-4 w-4" />
            </button>
            {bladeContent}
          </div>
        </div>
      )}
    </>
  )
}
