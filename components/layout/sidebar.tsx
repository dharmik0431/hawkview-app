'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { History as HistoryIcon } from 'lucide-react'

import {
  LayoutDashboard,
  Building2,
  FileBarChart,
  Bell,
  Activity,
  Users,
  CreditCard,
  Shield,
  Settings,
  Puzzle,
  UserCircle,
  Receipt,
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
      //{ name: 'Alerts & Notifications', href: '/alerts', icon: Bell },
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
  //{
  //  title: 'ADMIN',
  //  items: [
  //    { name: 'User Directory', href: '/users', icon: Users },
  //    { name: 'Licensing Overview', href: '/licensing', icon: CreditCard },
   //   { name: 'Admin Settings', href: '/admin', icon: Settings },
   //   { name: 'Integrations', href: '/integrations', icon: Puzzle },
   //   { name: 'Billing', href: '/billing', icon: Receipt },
    //],
  //},
  //{
  //  title: 'ACCOUNT',
  //  items: [{ name: 'Account Settings', href: '/settings', icon: UserCircle }],
  //},
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <div className="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-52 lg:flex-col">
      {/* Make sidebar a full-height column so bottom actions stay pinned */}
      <div className="flex h-full flex-col bg-slate-900 px-4 pb-4">
        {/* Brand */}
        <div className="flex h-16 shrink-0 items-center gap-2 px-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <Eye className="w-5 h-5 text-white" aria-hidden="true" />
          </div>
          <span className="text-xl font-semibold text-white">HawkView</span>
        </div>

        {/* Main nav (scrolls if needed) */}
        <nav
          className="flex-1 overflow-y-auto sidebar-scroll"
          aria-label="Main navigation"
        >
          <ul role="list" className="flex flex-col gap-y-6">
            {navigation.map((group) => (
              <li key={group.title}>
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider px-2 mb-2">
                  {group.title}
                </div>
                <ul role="list" className="space-y-1">
                  {group.items.map((item) => {
                    const isActive = pathname === item.href
                    return (
                      <li key={item.name}>
                        <Link
                          href={item.href}
                          className={cn(
                            'group flex gap-x-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                            isActive
                              ? 'bg-blue-600 text-white'
                              : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                          )}
                          aria-current={isActive ? 'page' : undefined}
                        >
                          <item.icon
                            className="h-5 w-5 shrink-0"
                            aria-hidden="true"
                          />
                          {item.name}
                        </Link>
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
          <Link
            href="/help"
            className={cn(
              'flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              pathname === '/help'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white'
            )}
          >
            <HelpCircle className="h-4 w-4" aria-hidden="true" />
            Help
          </Link>

          <a
            href="mailto:support@hawkview.net?subject=HawkView%20Support"
            className="flex items-center justify-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700 hover:text-white"
          >
            <Mail className="h-4 w-4" aria-hidden="true" />
            Contact Us
          </a>

          {/* User card stays static at the bottom */}
          <div className="border-t border-slate-700 pt-3">
            <div className="flex items-center gap-3 px-2">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-semibold">
                AG
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">
                  Alex Greene
                </p>
                <p className="text-xs text-slate-400 truncate">MSP Admin</p>
              </div>
            </div>
          </div>
        </div>

        {/* Scrollbar styling (local to this component, global CSS rules) */}
        <style jsx global>{`
          .sidebar-scroll {
            scrollbar-width: thin; /* Firefox */
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
  )
}
