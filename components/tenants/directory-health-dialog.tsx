'use client'

import { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DirectoryRoleReceiptHealth } from '@/components/tenant/directory-role-assignments-panel'

/** Mounted only while the page admits the selection against its current scope and list. */
export function DirectoryHealthDialog({ tenantId, tenantName, onClose }: {
  tenantId: string
  tenantName: string
  onClose: () => void
}) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    closeRef.current?.focus()
    return () => {
      // Scope invalidation must not explicitly focus a previous workspace's trigger.
      // User-close focus restoration is owned by the page after checking current intent.
      if (dialog.open) dialog.close()
    }
  }, [])

  function close() {
    dialogRef.current?.close()
    onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); close() }}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-slate-950/50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-lg font-semibold">Directory health — {tenantName}</h2>
        <Button ref={closeRef} type="button" variant="ghost" size="sm" onClick={close} aria-label="Close directory health">
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <DirectoryRoleReceiptHealth customerTenantId={tenantId} />
    </dialog>
  )
}
