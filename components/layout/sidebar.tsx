'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { History as HistoryIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import { useAuth } from '@/components/providers/auth-provider'
import { useSidebar } from '@/components/providers/sidebar-provider'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import {
  LayoutDashboard,
  Building2,
  FileBarChart,
  Activity,
  Shield,
  Settings,
  Eye,
  HelpCircle,
  Mail,
} from 'lucide-react'

const navigation = [
  {
    title: 'MAIN',
    items: [
      { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      { name: 'Tenants', href: '/tenants', icon: Building2 },
      { name: 'Activity Logs', href: '/activity', icon: Activity },
      { name: 'What Changed?', href: '/what-changed', icon: HistoryIcon },
    ],
  },
  {
    title: 'MANAGEMENT',
    items: [
      { name: 'Security Insights', href: '/security', icon: Shield },
      { name: 'Reports', href: '/reports', icon: FileBarChart },
    ],
  },
]

export function Sidebar() {
  const pathname = usePathname()
  const { isCollapsed, toggleCollapsed } = useSidebar()
  const { session } = useAuth()

  return (
    <TooltipProvider delayDuration={100}>
      <div
        className={cn(
          'hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:flex-col transition-[width] duration-200 ease-in-out motion-reduce:transition-none',
          isCollapsed ? 'lg:w-[72px]' : 'lg:w-52'
        )}
      >
        {/* Full-height column so bottom actions stay pinned */}
        <div className="relative flex h-full flex-col bg-slate-900 px-3 pb-4">
          {/* Circular collapse toggle control on right edge */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleCollapsed}
                className="absolute -right-3 top-5 z-50 flex h-6 w-6 items-center justify-center rounded-full bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 hover:text-white shadow-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            </TooltipContent>
          </Tooltip>

          {/* Brand */}
          <div
            className={cn(
              'flex h-16 shrink-0 items-center gap-2 px-1',
              isCollapsed && 'justify-center px-0'
            )}
          >
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
              <Eye className="w-5 h-5 text-white" aria-hidden="true" />
            </div>
            {!isCollapsed && (
              <span className="text-xl font-semibold text-white whitespace-nowrap overflow-hidden">
                HawkView
              </span>
            )}
          </div>

          {/* Main nav (scrolls if needed) */}
          <nav
            className="flex-1 overflow-y-auto overflow-x-hidden sidebar-scroll"
            aria-label="Main navigation"
          >
            <ul role="list" className="flex flex-col gap-y-6">
              {navigation.map((group) => (
                <li key={group.title}>
                  {!isCollapsed && (
                    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider px-2 mb-2 whitespace-nowrap overflow-hidden">
                      {group.title}
                    </div>
                  )}
                  <ul role="list" className="space-y-1">
                    {group.items.map((item) => {
                      const isActive = pathname === item.href
                      return (
                        <li key={item.name}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Link
                                href={item.href}
                                className={cn(
                                  'group flex rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                                  isCollapsed
                                    ? 'h-10 w-10 items-center justify-center mx-auto'
                                    : 'px-3 py-2 items-center gap-x-3',
                                  isActive
                                    ? 'bg-blue-600 text-white'
                                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                                )}
                                aria-current={isActive ? 'page' : undefined}
                                aria-label={item.name}
                              >
                                <item.icon
                                  className="h-5 w-5 shrink-0"
                                  aria-hidden="true"
                                />
                                {!isCollapsed && (
                                  <span className="truncate">{item.name}</span>
                                )}
                                {isCollapsed && (
                                  <span className="sr-only">{item.name}</span>
                                )}
                              </Link>
                            </TooltipTrigger>
                            {isCollapsed && (
                              <TooltipContent side="right" sideOffset={12}>
                                {item.name}
                              </TooltipContent>
                            )}
                          </Tooltip>
                        </li>
                      )
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </nav>

          {/* Bottom actions + user (pinned) */}
          <div className="mt-4 space-y-2">
            {session?.user.platformRole === 'PLATFORM_ADMIN' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    href="/settings"
                    className={cn(
                      'flex rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                      isCollapsed
                        ? 'h-10 w-10 items-center justify-center mx-auto'
                        : 'px-3 py-2 items-center justify-center gap-2',
                      pathname === '/settings'
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white'
                    )}
                    aria-label="Platform Settings"
                  >
                    <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {!isCollapsed && <span>Platform Settings</span>}
                    {isCollapsed && (
                      <span className="sr-only">Platform Settings</span>
                    )}
                  </Link>
                </TooltipTrigger>
                {isCollapsed && (
                  <TooltipContent side="right" sideOffset={12}>
                    Platform Settings
                  </TooltipContent>
                )}
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href="/help"
                  className={cn(
                    'flex rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                    isCollapsed
                      ? 'h-10 w-10 items-center justify-center mx-auto'
                      : 'px-3 py-2 items-center justify-center gap-2',
                    pathname === '/help'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white'
                  )}
                  aria-label="Help"
                >
                  <HelpCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {!isCollapsed && <span>Help</span>}
                  {isCollapsed && <span className="sr-only">Help</span>}
                </Link>
              </TooltipTrigger>
              {isCollapsed && (
                <TooltipContent side="right" sideOffset={12}>
                  Help
                </TooltipContent>
              )}
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href="mailto:support@hawkview.net?subject=HawkView%20Support"
                  className={cn(
                    'flex rounded-lg text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700 hover:text-white bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                    isCollapsed
                      ? 'h-10 w-10 items-center justify-center mx-auto'
                      : 'px-3 py-2 items-center justify-center gap-2'
                  )}
                  aria-label="Contact Us"
                >
                  <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {!isCollapsed && <span>Contact Us</span>}
                  {isCollapsed && <span className="sr-only">Contact Us</span>}
                </a>
              </TooltipTrigger>
              {isCollapsed && (
                <TooltipContent side="right" sideOffset={12}>
                  Contact Us
                </TooltipContent>
              )}
            </Tooltip>
          </div>

          {/* Scrollbar styling */}
          <style jsx global>{`
            .sidebar-scroll {
              scrollbar-width: thin;
              scrollbar-color: rgba(148, 163, 184, 0.35) transparent;
            }

            .sidebar-scroll::-webkit-scrollbar {
              width: 8px;
            }

            .sidebar-scroll::-webkit-scrollbar-track {
              background: transparent;
            }

            .sidebar-scroll::-webkit-scrollbar-thumb {
              background-color: rgba(148, 163, 184, 0.28);
              border-radius: 999px;
              border: 2px solid transparent;
              background-clip: content-box;
            }

            .sidebar-scroll::-webkit-scrollbar-thumb:hover {
              background-color: rgba(148, 163, 184, 0.45);
            }
          `}</style>
        </div>
      </div>
    </TooltipProvider>
  )
}
