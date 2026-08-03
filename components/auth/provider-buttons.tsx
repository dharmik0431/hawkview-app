'use client'

import React from 'react'

export function MicrosoftIcon() {
  return (
    <div
      className="grid grid-cols-2 gap-0.5 w-4 h-4 shrink-0"
      aria-hidden="true"
    >
      <span className="bg-[#F25022] rounded-[1px] w-1.5 h-1.5" />
      <span className="bg-[#7FBA00] rounded-[1px] w-1.5 h-1.5" />
      <span className="bg-[#00A4EF] rounded-[1px] w-1.5 h-1.5" />
      <span className="bg-[#FFB900] rounded-[1px] w-1.5 h-1.5" />
    </div>
  )
}

export function GoogleIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 48 48"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303C33.708 32.91 29.22 36 24 36c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.971 3.029l5.657-5.657C34.046 6.053 29.272 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.651-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 16.108 19.009 12 24 12c3.059 0 5.842 1.154 7.971 3.029l5.657-5.657C34.046 6.053 29.272 4 24 4c-7.682 0-14.409 4.328-17.694 10.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.118 0 9.786-1.969 13.314-5.186l-6.143-5.197C29.136 35.091 26.7 36 24 36c-5.199 0-9.677-3.067-11.29-7.463l-6.52 5.02C9.44 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.971 3.029l5.657-5.657C34.046 6.053 29.272 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.651-.389-3.917z"
      />
    </svg>
  )
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
