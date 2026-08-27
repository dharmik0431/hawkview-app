'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, ShieldCheck, X } from 'lucide-react'
import { HawkViewBrand } from '@/components/brand/hawkview-brand'
import { useAuth } from '@/components/providers/auth-provider'
import { cn } from '@/lib/utils'
import { coreNavigation } from '@/components/layout/sidebar'

export function MobileNavigation() {
  const pathname = usePathname() || ''
  const { session } = useAuth()
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const isMspOwner = Boolean(
    session?.user?.memberships?.some((membership) => membership.role === 'MSP_OWNER')
  )

  useEffect(() => {
    if (!isOpen) return

    const previousOverflow = document.body.style.overflow
    const trigger = triggerRef.current
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false)
      if (event.key !== 'Tab' || !panelRef.current) return

      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusables.length === 0) {
        event.preventDefault()
        panelRef.current.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    closeRef.current?.focus()

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
      trigger?.focus()
    }
  }, [isOpen])

  const close = () => setIsOpen(false)
  const isActive = (href: string) =>
    pathname === href || (href !== '/dashboard' && pathname.startsWith(`${href}/`))

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 lg:hidden"
        aria-label="Open main navigation"
        aria-expanded={isOpen}
        aria-controls="mobile-navigation"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-[70] lg:hidden">
          <div
            className="absolute inset-0 bg-slate-950/60"
            aria-hidden="true"
            onClick={close}
          />
          <aside
            ref={panelRef}
            tabIndex={-1}
            id="mobile-navigation"
            role="dialog"
            aria-modal="true"
            aria-label="Main navigation"
            className="relative flex h-full w-[min(19rem,88vw)] flex-col bg-slate-900 px-4 pb-5 text-white shadow-2xl"
          >
            <div className="flex h-16 items-center justify-between border-b border-slate-700">
              <HawkViewBrand appearance="dark" markClassName="h-8 w-8" wordmarkClassName="text-xl text-white" />
              <button
                ref={closeRef}
                type="button"
                onClick={close}
                className="inline-flex h-10 w-10 items-center justify-center rounded-md text-slate-200 hover:bg-slate-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                aria-label="Close main navigation"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <nav className="flex-1 overflow-y-auto py-5" aria-label="Mobile navigation">
              {coreNavigation.map((group) => (
                <div key={group.title} className="mb-6">
                  <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    {group.title}
                  </p>
                  <ul className="space-y-1">
                    {group.items.map((item) => (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={close}
                          aria-current={isActive(item.href) ? 'page' : undefined}
                          className={cn(
                            'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                            isActive(item.href)
                              ? 'bg-blue-600 text-white'
                              : 'text-slate-200 hover:bg-slate-800 hover:text-white'
                          )}
                        >
                          <item.icon className="h-5 w-5" aria-hidden="true" />
                          {item.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}

              {isMspOwner && (
                <Link
                  href="/admin/overview"
                  onClick={close}
                  aria-current={pathname.startsWith('/admin') ? 'page' : undefined}
                  className={cn(
                    'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                    pathname.startsWith('/admin')
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white'
                  )}
                >
                  <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                  Admin Panel
                </Link>
              )}
            </nav>

            <a
              href="mailto:support@hawkviewapp.com?subject=HawkView%20Support"
              className="rounded-lg border border-slate-700 px-3 py-2.5 text-center text-sm font-medium text-slate-200 hover:bg-slate-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              Contact support
            </a>
          </aside>
        </div>
      )}
    </>
  )
}
