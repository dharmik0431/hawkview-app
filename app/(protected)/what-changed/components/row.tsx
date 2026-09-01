'use client'

import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import {
  User,
  MapPin,
  Server,
  Building2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Globe,
  Network,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChangeEvent } from '../data/change-types'
import { classifyEvent } from '../data/event-classifier'

function fmtTime(ts: string, useUtc = false) {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return '—'
  if (useUtc) {
    return d.toISOString().slice(11, 16) + ' UTC'
  }
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}
function safeText(v?: string) {
  return v && v.trim().length ? v : '—'
}

interface WhatChangedRowProps {
  e: ChangeEvent
  isActive: boolean
  useUtc?: boolean
  onClick: () => void
}

export function WhatChangedRow({
  e,
  isActive,
  useUtc = false,
  onClick,
}: WhatChangedRowProps) {
  const time = fmtTime(e.ts, useUtc)
  const classification = classifyEvent(e)
  const CategoryIcon = classification.category.Icon

  const locationParts = [
    e.location?.city,
    e.location?.region,
    e.location?.country,
  ].filter(Boolean)
  const locationStr = locationParts.length ? locationParts.join(', ') : null

  const isFailed = classification.result === 'failure'
  const isSuccess = classification.result === 'success'
  const isHighRisk = classification.isHighRisk

  // Supporting text: affected resource or application summary
  const resourceOrService = e.target && e.target !== '—' ? e.target : e.summary

  return (
    <div className="group relative grid grid-cols-[64px_24px_1fr] sm:grid-cols-[85px_28px_1fr] gap-2 sm:gap-3 items-start">
      {/* Time rail */}
      <div className="pt-3.5 text-right text-xs font-semibold text-muted-foreground tabular-nums truncate">
        {time}
      </div>

      {/* Marker + vertical line */}
      <div
        className="relative flex justify-center h-full min-h-[80px]"
        aria-label={classification.accessibleLabel}
      >
        {/* Timeline line */}
        <div className="absolute top-0 bottom-0 w-px bg-border group-last:bottom-1/2" />

        {/* Event marker dot/icon */}
        <div
          className={cn(
            "relative mt-3 flex items-center justify-center rounded-full transition-transform group-hover:scale-110 z-10 shrink-0 text-white shadow-2xs",
            classification.category.dotClass,
            "w-6 h-6 sm:w-7 sm:h-7",
            isFailed
              ? "ring-4 ring-red-500/30 border-2 border-red-500"
              : isHighRisk
              ? "ring-4 ring-amber-500/30 border-2 border-amber-500"
              : "ring-4 ring-background"
          )}
        >
          <CategoryIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-white" aria-hidden="true" />
        </div>
      </div>

      {/* Event Card */}
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "w-full text-left rounded-xl border border-border/80 bg-card p-3 sm:p-4 transition-all shadow-2xs mb-3",
          "hover:bg-accent/30 hover:border-border hover:shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isActive && "border-primary ring-1 ring-primary bg-accent/20 shadow-xs"
        )}
      >
        <div className="flex flex-col gap-2.5">
          {/* Top Marker & Badges Row */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Compact Event-Type Marker: [32-36px tinted icon container] + Category label */}
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className={cn(
                  "w-8 h-8 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center shrink-0 border shadow-2xs",
                  classification.category.containerBgClass,
                  classification.category.iconTextClass,
                  classification.category.containerBorderClass
                )}
                aria-hidden="true"
              >
                <CategoryIcon className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
              </div>

              <div className="min-w-0 flex flex-col">
                <span className={cn("text-xs font-bold uppercase tracking-wider", classification.category.iconTextClass)}>
                  {classification.category.label}
                </span>
              </div>
            </div>

            {/* Right Status / Tenant Indicators */}
            <div className="flex flex-wrap items-center gap-1.5 shrink-0 ml-auto">
              {/* Tenant Badge */}
              <Badge variant="outline" className="text-[11px] font-normal gap-1 bg-background/80 py-0.5">
                <Building2 className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="truncate max-w-[110px] sm:max-w-[140px]">{e.tenantName}</span>
              </Badge>

              {/* Compact Result Indicator */}
              {isFailed ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30">
                  <XCircle className="h-3 w-3 shrink-0 text-red-600 dark:text-red-400" />
                  <span>Failed</span>
                </span>
              ) : isSuccess ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                  <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>Success</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-500/20">
                  <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span>Not reported</span>
                </span>
              )}

              {/* Separate High-Risk Warning Indicator */}
              {isHighRisk && (
                <Badge variant="destructive" className="text-[10px] font-bold tracking-wider px-2 py-0.5 bg-red-600 text-white gap-1 shrink-0">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  <span>HIGH RISK</span>
                </Badge>
              )}
            </div>
          </div>

          {/* Primary Event Title (Strongest Text) */}
          <div className="space-y-0.5">
            <h3 className="font-bold text-sm sm:text-base text-foreground leading-snug break-words">
              {e.title}
            </h3>

            {/* Secondary line: Affected resource or service */}
            <p className="text-xs font-medium text-muted-foreground leading-normal break-words">
              {resourceOrService}
            </p>
          </div>

          {/* Metadata line */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-2 border-t border-border/50 text-xs text-muted-foreground">
            {/* Actor */}
            <div className="flex items-center gap-1 min-w-0">
              <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="font-medium text-foreground/70 shrink-0">Actor:</span>
              <span className="font-medium text-foreground truncate max-w-[160px] sm:max-w-[220px]" title={e.actor}>
                {safeText(e.actor)}
              </span>
            </div>

            {/* Source */}
            <div className="flex items-center gap-1">
              <Server className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="font-medium text-foreground/70">Source:</span>
              <span className="text-foreground/90 font-medium">{e.source}</span>
            </div>

            {/* Location */}
            {locationStr && (
              <div className="flex items-center gap-1 min-w-0">
                <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="font-medium text-foreground/70 shrink-0">Location:</span>
                <span className="text-foreground/90 font-medium truncate max-w-[180px]" title={locationStr}>
                  {locationStr}
                </span>
              </div>
            )}

            {/* IP Address (Separated and truncated visually for IPv6/IPv4 safety) */}
            {e.ip && (
              <div className="flex items-center gap-1 min-w-0">
                <Network className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="font-medium text-foreground/70 shrink-0">IP:</span>
                <span
                  className="font-mono text-[11px] bg-muted/60 text-foreground px-1.5 py-0.2 rounded border border-border/40 max-w-[130px] sm:max-w-[160px] truncate"
                  title={e.ip}
                >
                  {e.ip}
                </span>
              </div>
            )}
          </div>
        </div>
      </button>
    </div>
  )
}
