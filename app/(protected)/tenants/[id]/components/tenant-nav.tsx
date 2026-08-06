'use client'

import { cn } from '@/lib/utils'

export function TenantMobileNav({ items, value, onChange }: { items: Array<{ key: string; label: string; disabled?: boolean }>; value: string; onChange: (key: string) => void }) {
  return <nav aria-label="Tenant modules" className="mb-4 overflow-x-auto border-b border-slate-200 lg:hidden dark:border-slate-800"><div className="flex min-w-max gap-1 pb-2">{items.map((item) => <button key={item.key} type="button" disabled={item.disabled} onClick={() => onChange(item.key)} aria-current={value === item.key ? 'page' : undefined} title={item.disabled ? 'This module is not available yet' : undefined} className={cn('rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', value === item.key ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800', item.disabled && 'cursor-not-allowed opacity-45')}>{item.label}</button>)}</div></nav>
}
