'use client'

import * as React from 'react'
import {
  FileText,
  Layers,
  LogIn,
  AlertTriangle,
  AppWindow,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type SummaryCategoryKey = 'all' | 'changes' | 'signIns' | 'highRisk' | 'apps'

export type IncidentSummaryData = {
  total: number
  changes: number
  signIns: number
  highRisk: number
  apps: number
}
interface SummaryStripProps {
  summary: IncidentSummaryData
  selectedCategory: SummaryCategoryKey
  onSelectCategory: (category: SummaryCategoryKey) => void
}

export function SummaryStrip({
  summary,
  selectedCategory,
  onSelectCategory,
}: SummaryStripProps) {
  const hasHighRisk = summary.highRisk > 0

  const items: {
    key: SummaryCategoryKey
    label: string
    count: number
    Icon: LucideIcon
    isWarning?: boolean
  }[] = [
    {
      key: 'all',
      label: 'Evidence events',
      count: summary.total,
      Icon: FileText,
    },
    {
      key: 'changes',
      label: 'Directory changes',
      count: summary.changes,
      Icon: Layers,
    },
    {
      key: 'signIns',
      label: 'Related sign-ins',
      count: summary.signIns,
      Icon: LogIn,
    },
    {
      key: 'highRisk',
      label: 'High-risk events',
      count: summary.highRisk,
      Icon: AlertTriangle,
      isWarning: true,
    },
    {
      key: 'apps',
      label: 'App-related changes',
      count: summary.apps,
      Icon: AppWindow,
    },
  ]

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-2xs">
      <div className="grid grid-cols-2 divide-y divide-border sm:grid-cols-5 sm:divide-x sm:divide-y-0" role="region" aria-label="Investigation Categories">
        {items.map((item) => {
          const isSelected = selectedCategory === item.key
          const isHighRisk = item.isWarning && hasHighRisk
          const ItemIcon = item.Icon

          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelectCategory(item.key)}
              className={cn(
                "relative flex flex-col justify-center p-3 sm:p-3.5 text-left transition-colors outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:z-10",
                isSelected
                  ? item.isWarning
                    ? "bg-amber-500/15 text-amber-900 dark:text-amber-200"
                    : "bg-primary/10 text-primary dark:text-primary-foreground"
                  : "bg-card hover:bg-muted/50 text-muted-foreground"
              )}
            >
              {/* Top accent indicator for selected item */}
              {isSelected && (
                <div
                  className={cn(
                    "absolute top-0 left-0 right-0 h-1",
                    item.isWarning ? "bg-amber-500" : "bg-primary"
                  )}
                />
              )}

              <span
                className={cn(
                  "text-[11px] font-medium uppercase tracking-wider flex items-center gap-1.5",
                  isSelected
                    ? item.isWarning
                      ? "text-amber-800 dark:text-amber-300 font-semibold"
                      : "text-primary dark:text-primary-foreground font-semibold"
                    : isHighRisk
                    ? "text-amber-700 dark:text-amber-400 font-semibold"
                    : "text-muted-foreground"
                )}
              >
                <ItemIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{item.label}</span>
              </span>

              <span
                className={cn(
                  "mt-1 text-2xl font-bold tracking-tight tabular-nums",
                  isSelected
                    ? item.isWarning
                      ? "text-amber-800 dark:text-amber-300"
                      : "text-foreground"
                    : isHighRisk
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-foreground"
                )}
              >
                {item.count.toLocaleString()}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
