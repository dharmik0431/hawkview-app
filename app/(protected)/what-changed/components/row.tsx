'use client'

import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { User, Shield, MapPin, Server, Building2, Target } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChangeEvent } from '../data/change-types'

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

type EventStyleConfig = {
  dotClass: string
  ringClass: string
  badgeVariant: 'destructive' | 'default' | 'secondary' | 'outline'
  badgeText: string
  badgeClass?: string
}

function getEventStyle(e: ChangeEvent): EventStyleConfig {
  const isFailedSignIn = e.eventType === 'sign-in' && (
    e.title.toLowerCase().includes('fail') ||
    e.summary.toLowerCase().includes('fail') ||
    e.summary.toLowerCase().includes('blocked')
  )

  if (e.severity === 'High') {
    return {
      dotClass: 'bg-red-500',
      ringClass: 'ring-red-500/20',
      badgeVariant: 'destructive',
      badgeText: 'HIGH RISK',
      badgeClass: 'bg-red-600 text-white font-semibold',
    }
  }

  if (isFailedSignIn) {
    return {
      dotClass: 'bg-amber-500',
      ringClass: 'ring-amber-500/20',
      badgeVariant: 'outline',
      badgeText: 'FAILED SIGN-IN',
      badgeClass: 'border-amber-500/50 text-amber-700 dark:text-amber-400 bg-amber-500/10 font-medium',
    }
  }

  if (e.eventType === 'sign-in') {
    return {
      dotClass: 'bg-emerald-500',
      ringClass: 'ring-emerald-500/20',
      badgeVariant: 'outline',
      badgeText: 'SIGN-IN',
      badgeClass: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 font-medium',
    }
  }

  // Directory Change / General Change
  return {
    dotClass: e.severity === 'Medium' ? 'bg-amber-500' : 'bg-blue-500',
    ringClass: e.severity === 'Medium' ? 'ring-amber-500/20' : 'ring-blue-500/20',
    badgeVariant: 'secondary',
    badgeText: e.severity.toUpperCase(),
    badgeClass: e.severity === 'Medium' ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300' : 'bg-blue-500/15 text-blue-800 dark:text-blue-300',
  }
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
  const style = getEventStyle(e)

  const locationParts = [
    e.location?.city,
    e.location?.region,
    e.location?.country,
  ].filter(Boolean)
  const locationStr = locationParts.length ? locationParts.join(', ') : null

  return (
    <div className="group relative grid grid-cols-[70px_16px_1fr] sm:grid-cols-[90px_20px_1fr] gap-2 sm:gap-3 items-start">
      {/* Time rail */}
      <div className="pt-3 text-right text-xs font-semibold text-muted-foreground tabular-nums truncate">
        {time}
      </div>

      {/* Marker dot + vertical line */}
      <div className="relative flex justify-center h-full min-h-[72px]">
        {/* Timeline line */}
        <div className="absolute top-0 bottom-0 w-px bg-border group-last:bottom-1/2" />
        {/* Event marker dot */}
        <div
          className={cn(
            "relative mt-3.5 h-3 w-3 rounded-full ring-4 transition-transform group-hover:scale-125 z-10 shrink-0",
            style.dotClass,
            style.ringClass
          )}
        />
      </div>

      {/* Event content row */}
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "w-full text-left rounded-lg border border-border/80 bg-card p-3 sm:p-3.5 transition-all shadow-2xs mb-2.5",
          "hover:bg-accent/40 hover:border-border hover:shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isActive && "border-primary ring-1 ring-primary bg-accent/20 shadow-xs"
        )}
      >
        <div className="flex flex-col gap-2">
          {/* Top header row: Title + Badges */}
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-sm text-foreground leading-snug break-words">
                {e.title}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 leading-normal break-words">
                {e.summary}
              </div>
            </div>

            {/* Badges */}
            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              <Badge variant="outline" className="text-[11px] font-normal gap-1 bg-background/80">
                <Building2 className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="truncate max-w-[120px]">{e.tenantName}</span>
              </Badge>

              <Badge variant={style.badgeVariant} className={cn("text-[10px] tracking-wider px-2 py-0.5", style.badgeClass)}>
                {style.badgeText}
              </Badge>
            </div>
          </div>

          {/* Secondary metadata compact row */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1 border-t border-border/40 text-xs text-muted-foreground">
            {/* Affected Target */}
            <div className="flex items-center gap-1 min-w-0 max-w-full">
              <Target className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="font-medium text-foreground/70 shrink-0">Target:</span>
              <span className="font-medium text-foreground truncate max-w-[200px] sm:max-w-[300px]">
                {safeText(e.target)}
              </span>
            </div>

            {/* Actor */}
            <div className="flex items-center gap-1 min-w-0 max-w-full">
              <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="font-medium text-foreground/70 shrink-0">Actor:</span>
              <span className="font-medium text-foreground truncate max-w-[180px] sm:max-w-[250px]">
                {safeText(e.actor)}
              </span>
            </div>

            {/* Category */}
            <div className="flex items-center gap-1">
              <Shield className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="font-medium text-foreground/70">Category:</span>
              <span className="text-foreground/90">{e.category}</span>
            </div>

            {/* Source */}
            <div className="flex items-center gap-1">
              <Server className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="font-medium text-foreground/70">Source:</span>
              <span className="text-foreground/90">{e.source}</span>
            </div>

            {/* Location & IP */}
            {(locationStr || e.ip) && (
              <div className="flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-foreground/80">
                  {[locationStr, e.ip].filter(Boolean).join(' · ')}
                </span>
              </div>
            )}
          </div>
        </div>
      </button>
    </div>
  )
}
