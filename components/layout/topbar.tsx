'use client'

import { useRouter, usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { LogOut, FileText, Menu, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useAuth } from '@/components/providers/auth-provider'

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
  '/billing': 'Billing',
}

export function Topbar({ onMenuClick }: { onMenuClick?: () => void }) {
  const router = useRouter()
  const pathname = usePathname()
  const { theme, setTheme } = useTheme()
  const { session, signOut } = useAuth()

  const pageTitle = pageTitles[pathname] || 'Dashboard'

  const handleSignOut = async () => {
    await signOut()
    router.replace('/login')
  }

  return (
    <div className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-x-4 border-b border-border bg-background px-4 shadow-sm sm:gap-x-6 sm:px-6 lg:px-8">
      <Button
        variant="ghost"
        size="icon"
        onClick={onMenuClick}
        className="lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </Button>
      <h1 className="text-xl font-semibold text-foreground">{pageTitle}</h1>

      <div className="flex flex-1 justify-end gap-x-4 lg:gap-x-6">
        <div className="flex items-center gap-x-4 lg:gap-x-6">
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 text-muted-foreground hover:text-foreground"
          >
            <FileText className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Changelog</span>
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle theme"
          >
            <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          </Button>

          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-sm font-semibold">
            {(session?.user.displayName || session?.user.email || 'HV')
              .split(/\s+/)
              .map((part) => part[0])
              .join('')
              .slice(0, 2)
              .toUpperCase()}
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
            className="gap-2"
            aria-label="Log out"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Log out</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
