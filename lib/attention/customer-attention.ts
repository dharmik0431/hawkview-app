import { readAttentionProvenance, type AttentionProvenance } from '../../backend/src/tenants/attention-provenance.ts'
import type { AttentionItem } from '../../types/attention.ts'

export type CustomerAttention = {
  sourceAvailable: boolean
  incomplete: boolean
  findings: AttentionItem[]
  accessActions: AttentionItem[]
  operations: unknown[]
  limitations: unknown[]
  unknown: unknown[]
  /** Retained for diagnostics; this is not an operator delivery destination. */
  raw: unknown
}
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const own = (v: object, k: string) => Object.prototype.hasOwnProperty.call(v, k)
const text = (v: unknown, n: number): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 && v.trim().length <= n && !/[\u0000-\u001f\u007f]/.test(v) ? v.trim() : undefined

/** Select the authoritative container before validating it. Never fall through a malformed source. */
export function customerAttention(value: unknown): CustomerAttention {
  const root = record(value)
  const health = record(root?.tenantHealth)
  const tenant = record(root?.tenant)
  const container = [root, health, tenant].find(v => v && own(v, 'attention'))
  const raw = container?.attention
  const sourceAvailable = Array.isArray(raw) && raw.length <= 100
  const out: CustomerAttention = { sourceAvailable, incomplete: !sourceAvailable,
    findings: [], accessActions: [], operations: [], limitations: [], unknown: [], raw }
  const data = record(container?.data)
  // COMPLETE describes supplied coverage, not an exhaustive security assessment.
  if (data?.status !== 'COMPLETE') out.incomplete = true
  if (!sourceAvailable) return out
  for (const value of raw as unknown[]) {
    const row = record(value)
    const p = readAttentionProvenance(row?.provenance)
    if (p.origin === 'COLLECTION_OPERATION') { out.operations.push(value); continue }
    if (p.origin === 'EVIDENCE_LIMITATION') { out.limitations.push(value); continue }
    const key = text(row?.key, 160), label = text(row?.label, 240), why = text(row?.why, 1000)
    const severity = row?.severity
    if (!row || !key || !label || !why || !['critical', 'high', 'medium'].includes(String(severity)) ||
      p.origin === 'UNKNOWN' || (p.origin === 'ACCESS_CONFIGURATION' && p.remediationOwner !== 'CUSTOMER_ADMIN')) {
      out.unknown.push(value); continue
    }
    const item: AttentionItem = { key, label, why, severity: severity as AttentionItem['severity'], provenance: p,
      detectedAt: text(row.detectedAt, 80), actionLabel: text(row.actionLabel, 120), actionUrl: text(row.actionUrl, 500) }
    if (p.origin === 'TENANT_FINDING') out.findings.push(item)
    else if (p.origin === 'ACCESS_CONFIGURATION') out.accessActions.push(item)
  }
  out.incomplete ||= out.operations.length > 0 || out.limitations.length > 0 || out.unknown.length > 0
  return out
}

export function customerStatus(view: CustomerAttention): string {
  const suffix = view.incomplete ? ' · Evidence incomplete' : ''
  if (view.findings.length) return `Findings to review${suffix}`
  if (view.accessActions.length) return `Access setup required${suffix}`
  return view.incomplete ? 'Evidence incomplete' : 'No findings reported'
}

export function customerTarget(provenance: AttentionProvenance | undefined): string {
  const p = readAttentionProvenance(provenance)
  if (p.origin === 'ACCESS_CONFIGURATION' && p.remediationOwner === 'CUSTOMER_ADMIN') return 'settings'
  if (p.origin !== 'TENANT_FINDING') return 'overview'
  switch (p.kind) {
    case 'MICROSOFT_ACTIVE_RISK': return 'risky-users'
    case 'APPLICATION_ACCESS_CHANGE': return 'app-registrations'
    default: return 'entra'
  }
}

/** The current backend score mixes collection and tenant penalties. No tenant-only score exists. */
export function customerHealthScore(_value: unknown): null { return null }
