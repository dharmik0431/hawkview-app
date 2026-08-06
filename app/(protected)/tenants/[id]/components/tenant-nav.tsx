'use client'

import { cn } from '@/lib/utils'

export function TenantModuleNav({ items, value, onChange }: { items: Array<{ key: string; label: string; disabled?: boolean }>; value: string; onChange: (key: string) => void }) {
  return (
    <nav aria-label="Tenant modules" className="sticky top-0 z-10 mb-4 overflow-x-auto border-b border-slate-200 bg-slate-50/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
      <div className="flex min-w-max gap-5 px-1">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            disabled={item.disabled}
            onClick={() => onChange(item.key)}
            aria-current={value === item.key ? 'page' : undefined}
            title={item.disabled ? 'This module is not available yet' : undefined}
            className={cn(
              'border-b-2 border-transparent px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
              value === item.key
                ? 'border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300'
                : 'text-slate-600 hover:border-slate-300 hover:text-slate-950 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:text-white',
              item.disabled && 'cursor-not-allowed opacity-45'
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </nav>
  )
}
