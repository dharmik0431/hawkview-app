/** Persisted notification severity, not alert urgency or notification category. */
export const NOTIFICATION_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number]

export function notificationSeverityRank(value: unknown): number | null {
  const rank = NOTIFICATION_SEVERITIES.findIndex(severity => severity === value)
  return rank < 0 ? null : rank
}

export function notificationSeveritiesAtOrAbove(minimum: unknown): NotificationSeverity[] {
  const rank = notificationSeverityRank(minimum)
  return rank === null ? [] : NOTIFICATION_SEVERITIES.slice(rank)
}

/** Fixed internal columns only. Unknown and NULL values deliberately yield SQL NULL. */
export function notificationSeveritySql(column: 'n.severity' | 'p.minimum_severity'): string {
  if (column !== 'n.severity' && column !== 'p.minimum_severity') throw new Error('Invalid severity column.')
  return `(CASE ${column} ${NOTIFICATION_SEVERITIES.map((severity, rank) => `WHEN '${severity}' THEN ${rank}`).join(' ')} ELSE NULL END)`
}
