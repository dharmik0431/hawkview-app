export type AttentionSeverity = 'critical' | 'high' | 'medium'

export type AttentionItem = {
  key: string
  label: string
  severity: AttentionSeverity
  why: string
  detectedAt?: string
}
