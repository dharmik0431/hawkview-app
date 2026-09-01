import { classifyEvidenceTrust } from './evidence-trust-catalog.js'

export type ManagementActivityRole =
  | 'primary_change'
  | 'security_supporting_activity'
  | 'routine_activity'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Classify Office 365 Management Activity records by their investigation role.
 *
 * The operation verb is not enough: Exchange uses generic verbs such as
 * `Create` and `Delete` for ordinary mailbox items. Those records can support
 * a compromise investigation, but they are not themselves tenant changes.
 */
export function classifyManagementActivity(
  record: unknown,
): ManagementActivityRole {
  const value = object(record)
  const operation = text(value.Operation) ?? ''
  const workload = text(value.Workload) ?? ''
  const result = (text(value.ResultStatus) ?? '').toLowerCase()
  if (!operation || /^(failed|failure|false)$/i.test(result)) {
    return 'routine_activity'
  }

  const trusted = classifyEvidenceTrust({
    source: 'Office 365 Management Activity API',
    workload,
    operation,
    result,
    actor: text(value.UserId) ?? text(value.UserKey),
  })
  if (trusted.evidenceClass === 'PRIMARY_CHANGE') return 'primary_change'
  if (trusted.evidenceClass === 'SECURITY_SUPPORTING_ACTIVITY') return 'security_supporting_activity'
  return 'routine_activity'
}

export function managementActivityRoleFromEvidence(input: {
  operationName: string
  workload?: string | null
  raw?: unknown
}): ManagementActivityRole {
  const raw = object(input.raw)
  // Reclassify retained legacy rows with the current catalog. A historical
  // primary flag cannot promote an operation that is now known to be routine.
  return classifyManagementActivity({
    ...raw,
    Operation: text(raw.Operation) ?? input.operationName,
    Workload: text(raw.Workload) ?? input.workload,
  })
}
