export type ReportedOutcome = 'success' | 'failure' | 'unreported'

export function licenseAuditOutcome(status: unknown, result: unknown): {
  label: string
  outcome: ReportedOutcome
} {
  const reported = [status, result].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  )
  if (!reported) return { label: 'Result not reported', outcome: 'unreported' }

  const label = reported.trim()
  const normalized = label.toLowerCase()
  if (['success', 'successful', 'succeeded', 'ok'].includes(normalized)) {
    return { label: 'Successful', outcome: 'success' }
  }
  if (['failed', 'failure', 'error', 'denied', 'unsuccessful'].includes(normalized)) {
    return { label, outcome: 'failure' }
  }
  return { label, outcome: 'unreported' }
}

export function reportedText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export function sharePointDomainRestriction(mode: unknown): string {
  const value = reportedText(mode, '')
  if (!value) return 'Not available'
  return value.toLowerCase() === 'none' ? 'No domain restriction' : value
}

export function sharePointStorageLimitMode(automatic: unknown): string {
  return typeof automatic === 'boolean'
    ? automatic ? 'Automatic' : 'Manual'
    : 'Not available'
}
