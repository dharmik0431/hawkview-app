import { customerAttention } from '../attention/customer-attention.ts'

/** Counts observed tenant IDs in loaded summaries, never an exhaustive risk total. */
export function criticalFindingsSummary(rows: readonly unknown[]) {
  const tenants = new Map<string, { readable: boolean; critical: boolean }>()
  let incomplete = false
  let invalidRows = 0
  for (const row of rows) {
    const id = row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined
    if (typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) {
      invalidRows++
      incomplete = true
      continue
    }
    const view = customerAttention(row)
    incomplete ||= view.incomplete
    const prior = tenants.get(id)
    tenants.set(id, {
      readable: Boolean(prior?.readable || view.sourceAvailable),
      critical: Boolean(prior?.critical || view.findings.some(item => item.severity === 'critical')),
    })
  }
  const readable = Array.from(tenants.values()).filter(tenant => tenant.readable).length
  const critical = Array.from(tenants.values()).filter(tenant => tenant.critical).length
  return {
    value: readable ? `${critical} reported` : 'Unavailable',
    coverage: `${readable} of ${tenants.size} loaded tenant summaries readable${invalidRows ? `; ${invalidRows} row${invalidRows === 1 ? '' : 's'} without usable tenant IDs` : ''}`,
    qualification: !readable ? 'No readable tenant findings summary is available.'
      : incomplete ? 'Evidence incomplete; additional findings may be missing.'
        : 'Reported summaries only; not an exhaustive security assessment.',
  }
}
