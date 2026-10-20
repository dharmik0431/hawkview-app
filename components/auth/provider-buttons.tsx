'use client'

import React from 'react'
import { ProviderMark } from '@/components/icons/provider-mark'

export function MicrosoftIcon() {
  return <ProviderMark provider="microsoft" size="compact" />
}

export function GoogleIcon() {
  return <ProviderMark provider="google" size="compact" />
}

export function ProviderButtons() {
  return (
    <div className="space-y-2.5">
      <div className="relative">
        <button
          type="button"
          disabled
          aria-disabled="true"
          onClick={(e) => e.preventDefault()}
          className="w-full h-11 px-3.5 py-2 flex items-center justify-between rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-900/50 text-slate-400 dark:text-slate-500 font-medium text-xs sm:text-sm cursor-not-allowed opacity-75 select-none transition-none"
        >
          <div className="flex items-center gap-2.5">
            <MicrosoftIcon />
            <span>Continue with Microsoft</span>
          </div>
          <span className="text-[10px] sm:text-[11px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-md bg-slate-200/90 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-300/60 dark:border-slate-700/60">
            Unavailable
          </span>
        </button>
      </div>

      <div className="relative">
        <button
          type="button"
          disabled
          aria-disabled="true"
          onClick={(e) => e.preventDefault()}
          className="w-full h-11 px-3.5 py-2 flex items-center justify-between rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-900/50 text-slate-400 dark:text-slate-500 font-medium text-xs sm:text-sm cursor-not-allowed opacity-75 select-none transition-none"
        >
          <div className="flex items-center gap-2.5">
            <GoogleIcon />
            <span>Continue with Google</span>
          </div>
          <span className="text-[10px] sm:text-[11px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-md bg-slate-200/90 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-300/60 dark:border-slate-700/60">
            Unavailable
          </span>
        </button>
      </div>
    </div>
  )
}
