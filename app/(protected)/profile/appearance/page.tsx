'use client'

import { useEffect, useState } from 'react'
import { Laptop, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { cn } from '@/lib/utils'

const themes = [
  {
    value: 'system',
    label: 'System',
    description: 'Follow your device setting.',
    icon: Laptop,
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Always use the light theme.',
    icon: Sun,
  },
  {
    value: 'dark',
    label: 'Dark',
    description: 'Always use the dark theme.',
    icon: Moon,
  },
] as const

export default function AppearanceSettingsPage() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  const activeTheme = mounted ? theme ?? 'system' : 'system'

  return (
    <section className="rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm">
      <h2 className="text-base font-semibold text-foreground">Theme preference</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Choose how HawkView looks on this browser. The change is applied and saved immediately.
      </p>

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme preference">
        {themes.map(({ value, label, description, icon: Icon }) => {
          const selected = activeTheme === value
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setTheme(value)}
              className={cn(
                'flex min-h-28 flex-col items-start rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                selected
                  ? 'border-blue-500 bg-blue-500/10 text-foreground'
                  : 'border-border text-foreground hover:bg-muted/50'
              )}
            >
              <Icon className="h-5 w-5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
              <span className="mt-3 text-sm font-semibold">{label}</span>
              <span className="mt-1 text-xs text-muted-foreground">{description}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
