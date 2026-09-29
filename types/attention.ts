export type AttentionSeverity = 'critical' | 'high' | 'medium'

export type AttentionItem = {
  provenance?: import('../backend/src/tenants/attention-provenance').AttentionProvenance
  key: string
  label: string
  severity: AttentionSeverity
  why: string
  detectedAt?: string
  actionLabel?: string
  actionUrl?: string
}
