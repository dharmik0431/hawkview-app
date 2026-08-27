'use client'

import { Sidebar } from '@/components/layout/sidebar'
import { Topbar } from '@/components/layout/topbar'
import '../globals.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import { ProtectedRoute } from '@/components/auth/protected-route'
import {
  SidebarProvider,
  useSidebar,
} from '@/components/providers/sidebar-provider'
import { NotificationProvider } from '@/components/providers/notification-provider'
import { cn } from '@/lib/utils'

function ProtectedShell({ children }: { children: React.ReactNode }) {
  const { isCollapsed } = useSidebar()

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only z-[100] rounded-md bg-background px-4 py-2 text-foreground shadow focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        Skip to main content
      </a>
      <Sidebar />
      <div
        className={cn(
          'transition-[padding] duration-200 ease-in-out motion-reduce:transition-none',
          isCollapsed ? 'lg:pl-[72px]' : 'lg:pl-52'
        )}
      >
        <Topbar />
        <main id="main-content" tabIndex={-1} className="py-3.5 px-4 sm:px-5 lg:px-6">
          {children}
        </main>
      </div>
    </div>
  )
}

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ProtectedRoute>
      <SidebarProvider>
        <NotificationProvider>
          <ProtectedShell>{children}</ProtectedShell>
        </NotificationProvider>
      </SidebarProvider>
    </ProtectedRoute>
  )
}
