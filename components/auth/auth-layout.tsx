'use client'

import React, { useEffect, useState } from 'react'
import { Moon, Sun, Shield, Layers, Activity } from 'lucide-react'
import { useTheme } from 'next-themes'
import { HawkViewBrand } from '@/components/brand/hawkview-brand'

export function AuthLayout({ children }: { children: React.ReactNode }) {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const toggleTheme = () => {
    const isDark = (resolvedTheme || theme) === 'dark'
    setTheme(isDark ? 'light' : 'dark')
  }

  return (
    <div className="min-h-screen w-full flex bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors">
      {/* Left Brand Panel - Desktop (lg+) */}
      <div className="hidden lg:flex lg:w-[500px] xl:w-[560px] 2xl:w-[640px] shrink-0 flex-col justify-between p-12 bg-slate-950 relative overflow-hidden border-r border-slate-800/80 select-none">
        {/* Subtle CSS Background Visual Treatment (Grid, Lines, Glow) */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(37,99,235,0.22),rgba(255,255,255,0))]" />

        {/* Subtle grid pattern overlay */}
        <div
          className="absolute inset-0 opacity-[0.06] bg-[linear-gradient(to_right,#ffffff_1px,transparent_1px),linear-gradient(to_bottom,#ffffff_1px,transparent_1px)] bg-[size:32px_32px]"
          aria-hidden="true"
        />

        {/* Decorative subtle structural accent lines */}
        <div
          className="absolute top-0 right-0 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl pointer-events-none"
          aria-hidden="true"
        />
        <div
          className="absolute bottom-12 left-12 w-64 h-64 bg-cyan-500/10 rounded-full blur-2xl pointer-events-none"
          aria-hidden="true"
        />

        {/* Top Brand Header */}
        <HawkViewBrand
          appearance="dark"
          className="relative z-10"
          wordmarkClassName="text-2xl text-white"
        />

        {/* Center Content Section */}
        <div className="relative z-10 space-y-8 my-auto max-w-lg">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-950/80 border border-blue-800/50 text-blue-300 text-xs font-medium tracking-wide">
              <Shield className="w-3.5 h-3.5 text-blue-400" />
              <span>MSP Security Workspace</span>
            </div>

            <h1 className="text-3xl xl:text-4xl font-bold text-white leading-[1.15] tracking-tight">
              Microsoft 365 visibility built for MSPs.
            </h1>

            <p className="text-base text-slate-300/90 leading-relaxed font-normal">
              Monitor tenants, identify risks, and understand what changed from
              one secure workspace.
            </p>
          </div>

          {/* Minimalist Feature Indicator Lines */}
          <div className="pt-2 border-t border-slate-800/80 grid grid-cols-2 gap-4 text-xs text-slate-400">
            <div className="flex items-center gap-2.5">
              <Layers className="w-4 h-4 text-blue-400 shrink-0" />
              <span>Multi-tenant management</span>
            </div>
            <div className="flex items-center gap-2.5">
              <Activity className="w-4 h-4 text-blue-400 shrink-0" />
              <span>Real-time change tracking</span>
            </div>
          </div>
        </div>

        {/* Footer info */}
        <div className="relative z-10 text-xs text-slate-500 font-medium">
          © {new Date().getFullYear()} HawkView. All rights reserved.
        </div>
      </div>

      {/* Right Auth Panel */}
      <div className="flex-1 flex flex-col justify-between p-6 sm:p-10 lg:p-12 relative min-h-screen">
        {/* Top Header Controls (Theme toggle & Mobile Logo) */}
        <div className="w-full flex items-center justify-between gap-4 max-w-[440px] mx-auto lg:max-w-none">
          {/* Mobile/Tablet Header Branding */}
          <HawkViewBrand
            className="lg:hidden"
            markClassName="h-8 w-8"
            wordmarkClassName="text-lg text-slate-900 dark:text-white"
          />

          {/* Theme Toggle Button */}
          {mounted && (
            <button
              type="button"
              onClick={toggleTheme}
              className="ml-auto p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-800/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              aria-label={
                (resolvedTheme || theme) === 'dark'
                  ? 'Switch to light mode'
                  : 'Switch to dark mode'
              }
              title={
                (resolvedTheme || theme) === 'dark'
                  ? 'Switch to light mode'
                  : 'Switch to dark mode'
              }
            >
              {(resolvedTheme || theme) === 'dark' ? (
                <Sun className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Moon className="h-5 w-5" aria-hidden="true" />
              )}
            </button>
          )}
        </div>

        {/* Main Form Content */}
        <div className="w-full max-w-[420px] mx-auto my-auto py-8">
          {children}
        </div>

        {/* Mobile / Tablet Footer */}
        <div className="w-full max-w-[440px] mx-auto text-center lg:hidden text-xs text-slate-400 dark:text-slate-500 pt-4">
          © {new Date().getFullYear()} HawkView. Microsoft 365 visibility built
          for MSPs.
        </div>
      </div>
    </div>
  )
}
