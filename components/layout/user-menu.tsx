'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/providers/auth-provider'
import { useTheme } from 'next-themes'
import {
  User,
  Settings,
  Sun,
  Moon,
  LogOut,
  ChevronRight,
  Shield,
  Sparkles,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function UserMenu() {
  const router = useRouter()
  const { session, signOut } = useAuth()
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [isOpen, setIsOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  const membership = session?.user.memberships?.[0]
  const fullName =
    session?.user.displayName || session?.user.email || 'HawkView User'
  const email = session?.user.email || 'user@hawkview.net'
  const orgName = membership?.organization?.name || 'HawkView Organization'

  const rawRole = membership?.role || session?.user.platformRole || 'MSP_ADMIN'
  const roleDisplay = rawRole
    .replace('MSP_', '')
    .replace('PLATFORM_', '')
    .toLowerCase()
    .replace(/^\w/, (l) => l.toUpperCase())

  const initials =
    fullName
      .split(/\s+/)
      .map((part) => part[0])
      .filter(Boolean)
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'HV'

  const toggleMenu = () => setIsOpen((prev) => !prev)

  const closeMenu = useCallback(() => {
    setIsOpen(false)
  }, [])

  // Close on Click Outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        closeMenu()
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, closeMenu])

  // Keyboard navigation: Escape key closes menu
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        closeMenu()
        buttonRef.current?.focus()
      }
    }
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, closeMenu])

  const handleSignOut = async () => {
    closeMenu()
    await signOut()
    router.replace('/login')
  }

  const isDark = mounted ? resolvedTheme === 'dark' : false

  return (
    <TooltipProvider delayDuration={200}>
      <div className="relative inline-block text-left" ref={menuRef}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              id="user-menu-button"
              ref={buttonRef}
              type="button"
              onClick={toggleMenu}
              aria-expanded={isOpen}
              aria-haspopup="true"
              aria-label={`User menu for ${fullName}`}
              className="flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 text-white font-semibold text-xs transition-transform hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background cursor-pointer"
            >
              {initials}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end">
            Account ({fullName})
          </TooltipContent>
        </Tooltip>

        {isOpen && (
          <div
            role="menu"
            aria-orientation="vertical"
            aria-labelledby="user-menu-button"
            className="absolute right-0 top-full mt-2 w-72 rounded-xl border border-border bg-popover text-popover-foreground shadow-xl z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-100"
          >
            {/* User Identity Header */}
            <div className="px-4 py-3 bg-muted/30 border-b border-border">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 text-white flex items-center justify-center font-bold text-sm shrink-0">
                  {initials}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">
                    {fullName}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {email}
                  </p>
                  <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] font-medium text-foreground/80 truncate max-w-[130px]">
                      {orgName}
                    </span>
                    <span className="inline-flex items-center rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400 ring-1 ring-inset ring-blue-500/20">
                      {roleDisplay}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Menu Actions */}
            <div className="p-1 space-y-0.5">
              {/* Profile Settings */}
              <Link
                href="/profile"
                onClick={closeMenu}
                role="menuitem"
                className="flex items-center justify-between px-3 py-2 text-sm rounded-md text-foreground hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:bg-accent"
              >
                <div className="flex items-center gap-2.5">
                  <User
                    className="h-4 w-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span>Profile Settings</span>
                </div>
                <ChevronRight
                  className="h-3.5 w-3.5 text-muted-foreground/60"
                  aria-hidden="true"
                />
              </Link>

              {/* Account Settings */}
              <Link
                href="/profile/security"
                onClick={closeMenu}
                role="menuitem"
                className="flex items-center justify-between px-3 py-2 text-sm rounded-md text-foreground hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:bg-accent"
              >
                <div className="flex items-center gap-2.5">
                  <Settings
                    className="h-4 w-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span>Account &amp; Security</span>
                </div>
                <ChevronRight
                  className="h-3.5 w-3.5 text-muted-foreground/60"
                  aria-hidden="true"
                />
              </Link>

              {session?.user.memberships?.some((m) => m.role === 'MSP_OWNER') && (
                <Link
                  href="/admin/overview"
                  onClick={closeMenu}
                  role="menuitem"
                  className="flex items-center justify-between px-3 py-2 text-sm rounded-md text-foreground hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:bg-accent"
                >
                  <div className="flex items-center gap-2.5">
                    <Shield className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <span>Admin Panel</span>
                  </div>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" aria-hidden="true" />
                </Link>
              )}

              {/* Theme Toggle */}
              <div className="px-3 py-2 text-sm flex items-center justify-between rounded-md text-foreground hover:bg-accent transition-colors">
                <div className="flex items-center gap-2.5">
                  {isDark ? (
                    <Moon
                      className="h-4 w-4 text-purple-400"
                      aria-hidden="true"
                    />
                  ) : (
                    <Sun
                      className="h-4 w-4 text-amber-500"
                      aria-hidden="true"
                    />
                  )}
                  <span>Theme</span>
                </div>

                <div className="flex items-center gap-1 bg-muted p-0.5 rounded-lg border border-border">
                  <button
                    type="button"
                    onClick={() => setTheme('light')}
                    aria-label="Set light mode"
                    className={cn(
                      'px-2 py-0.5 text-xs font-medium rounded-md transition-all',
                      !isDark
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    Light
                  </button>
                  <button
                    type="button"
                    onClick={() => setTheme('dark')}
                    aria-label="Set dark mode"
                    className={cn(
                      'px-2 py-0.5 text-xs font-medium rounded-md transition-all',
                      isDark
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    Dark
                  </button>
                </div>
              </div>
            </div>

            {/* Logout Action */}
            <div className="p-1 border-t border-border">
              <button
                type="button"
                role="menuitem"
                onClick={handleSignOut}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-md text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition-colors font-medium focus-visible:outline-none focus-visible:bg-rose-500/10"
              >
                <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Log out</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
