'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
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
} from 'lucide-react'

const navigation = [
  {
    title: 'MAIN',
    items: [
      { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      { name: 'Tenants', href: '/tenants', icon: Building2 },
      { name: 'Reports', href: '/reports', icon: FileBarChart },
      { name: 'Alerts & Notifications', href: '/alerts', icon: Bell },
      { name: 'Activity Logs', href: '/activity', icon: Activity },
    ],
  },
  {
    title: 'MANAGEMENT',
    items: [
      { name: 'User Directory', href: '/users', icon: Users },
      { name: 'Licensing Overview', href: '/licensing', icon: CreditCard },
      { name: 'Security Insights', href: '/security', icon: Shield },
    ],
  },
  {
    title: 'ADMIN',
    items: [
      { name: 'Admin Settings', href: '/admin', icon: Settings },
      { name: 'Integrations', href: '/integrations', icon: Puzzle },
    ],
  },
  {
    title: 'ACCOUNT',
    items: [
      { name: 'Account Settings', href: '/settings', icon: UserCircle },
      { name: 'Billing', href: '/billing', icon: Receipt },
    ],
  },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <div className="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-64 lg:flex-col">
      <div className="flex grow flex-col gap-y-5 overflow-y-auto bg-slate-900 px-4 pb-4">
        <div className="flex h-16 shrink-0 items-center gap-2 px-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <Eye className="w-5 h-5 text-white" aria-hidden="true" />
          </div>
          <span className="text-xl font-semibold text-white">HawkView</span>
        </div>
        
        <nav className="flex flex-1 flex-col" aria-label="Main navigation">
          <ul role="list" className="flex flex-1 flex-col gap-y-6">
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

        <div className="border-t border-slate-700 pt-4">
          <div className="flex items-center gap-3 px-2">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-semibold">
              AG
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">Alex Greene</p>
              <p className="text-xs text-slate-400 truncate">MSP Admin</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
