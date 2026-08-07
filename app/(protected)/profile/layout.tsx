'use client'

import React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { User, Shield, Bell, Palette } from 'lucide-react'
import { cn } from '@/lib/utils'

export default function ProfileLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()

  const navItems = [
    {
      name: 'Profile',
      href: '/profile',
      icon: User,
      active: pathname === '/profile',
    },
    {
      name: 'Security',
      href: '/profile/security',
      icon: Shield,
      active: pathname === '/profile/security',
    },
    {
      name: 'Notifications',
      href: '/profile/notifications',
      icon: Bell,
      active: pathname === '/profile/notifications',
    },
    {
      name: 'Appearance',
      href: '/profile/appearance',
      icon: Palette,
      active: pathname === '/profile/appearance',
    },
  ]

  const pageHeader = React.useMemo(() => {
    switch (pathname) {
      case '/profile/security':
        return {
          title: 'Security',
          subtitle:
            'Manage your password, authentication methods, and active account security.',
        }
      case '/profile/notifications':
        return {
          title: 'Notifications',
          subtitle:
            'Configure email digests and push alerts for tenant synchronization status.',
        }
      case '/profile/appearance':
        return {
          title: 'Appearance',
          subtitle: 'Customize HawkView theme and display preferences.',
        }
      default:
        return {
          title: 'Profile',
          subtitle:
            'Manage your personal information and HawkView preferences.',
        }
    }
  }, [pathname])

  return (
    <div className="w-full max-w-5xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
      {/* Header Section */}
      <div className="mb-6 border-b border-border pb-5">
        <h1 className="text-2xl font-bold text-foreground tracking-tight">
          {pageHeader.title}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {pageHeader.subtitle}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
        {/* Left Settings Navigation */}
        <div className="md:col-span-3 space-y-1">
          <nav aria-label="Settings categories" className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    'relative w-full flex items-center justify-between px-3 py-2 text-sm font-medium rounded-md transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                    item.active
                      ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2.5px] before:bg-blue-600 dark:before:bg-blue-500 before:rounded-r-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{item.name}</span>
                  </div>
                </Link>
              )
            })}
          </nav>
        </div>

        {/* Right Settings Main Content */}
        <div className="md:col-span-9">{children}</div>
      </div>
    </div>
  )
}
