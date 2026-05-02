'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

export default function CopyPill({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 900)
    } catch {
      // ignore
    }
  }

  return (
    <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border bg-muted/20 px-3 py-2">
      <div className="text-xs font-mono break-all">{value}</div>

      <button
        type="button"
        onClick={onCopy}
        className="inline-flex items-center gap-2 rounded-lg border bg-white px-2 py-1 text-xs font-semibold hover:bg-muted/40"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
