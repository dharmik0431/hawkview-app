/**
 * Internal evidence classifications for the investigation timeline.
 *
 * These are deliberately derived from Microsoft-provided source metadata so
 * existing retained events can be classified without a destructive backfill.
 * `authentication_evidence` is retained separately and is never a primary
 * "What Changed?" timeline event.
 */
export type ChangeClassification =
  | 'configuration_change'
  | 'permission_change'
  | 'identity_change'
  | 'security_control_change'
  | 'administrative_action'
  | 'authentication_evidence'
  | 'security_supporting_activity'
  | 'system_or_collection_event'

export const PRIMARY_CHANGE_CLASSIFICATIONS = new Set<ChangeClassification>([
  'configuration_change',
  'permission_change',
  'identity_change',
  'security_control_change',
  'administrative_action',
])

export type LegacyChangeCategory =
  | 'MFA'
  | 'Passwords'
  | 'Conditional Access'
  | 'Apps'
  | 'Roles'
  | 'Groups'
  | 'Devices'
  | 'Licenses'
  | 'Users'

export function legacyCategory(activity: string, category?: string | null): {
  category: LegacyChangeCategory
  severity: 'Low' | 'Medium' | 'High'
} {
  const value = `${activity} ${category ?? ''}`.toLowerCase()
  if (/authentication method|security info|mfa|strong authentication/.test(value)) return { category: 'MFA', severity: 'High' }
  if (/password/.test(value)) return { category: 'Passwords', severity: 'High' }
  if (/conditional access|named location/.test(value)) return { category: 'Conditional Access', severity: 'High' }
  if (/service principal|application|app registration|credential|oauth/.test(value)) return { category: 'Apps', severity: 'High' }
  if (/role|eligible assignment|member to role/.test(value)) return { category: 'Roles', severity: 'High' }
  if (/group/.test(value)) return { category: 'Groups', severity: 'Medium' }
  if (/device/.test(value)) return { category: 'Devices', severity: 'Medium' }
  if (/license/.test(value)) return { category: 'Licenses', severity: 'Medium' }
  return { category: 'Users', severity: 'Low' }
}

export function classifyEvidence(input: {
  source?: string | null
  activity: string
  category?: string | null
  operationType?: string | null
  targetResourceTypes?: Array<string | null | undefined>
}): ChangeClassification {
  const source = input.source?.toUpperCase() ?? ''
  const activity = input.activity.toLowerCase()
  const category = input.category?.toLowerCase() ?? ''
  const operationType = input.operationType?.toLowerCase() ?? ''
  const targetTypes = (input.targetResourceTypes ?? []).filter(Boolean).join(' ').toLowerCase()
  const value = `${activity} ${category} ${targetTypes}`

  // A sign-in is authentication telemetry, not proof that a configuration or
  // administrative change occurred.
  if (source === 'SIGN_IN') return 'authentication_evidence'

  // Directory audits contain read/report/health operations as well as changes.
  // Evaluate their structured operation first, so a report *about* a policy or
  // synchronization configuration is not shown as a policy/configuration change.
  if (
    /^(get|list|read|report|export|view|search)\b/.test(activity)
    || /^(read|report|export|view|search)$/i.test(operationType)
    || /health check|inventory refresh|telemetry|collection status/.test(value)
  ) return 'system_or_collection_event'

  if (/conditional access|named location|sign[ -]?in frequency|authentication method|security info|mfa|strong authentication|security default/.test(value)) return 'security_control_change'
  if (/consent|permission|oauth|app role|app registration|service principal|application/.test(value)) return 'permission_change'
  if (/role assignment|directory role|administrator|eligible assignment|password reset|reset password|reset.*password|disable user|delete user/.test(value)) return 'administrative_action'
  if (/synchroni[sz]/.test(value)) return 'configuration_change'
  if (/group|member|user|device/.test(value)) return 'identity_change'
  if (/license|subscription|domain|organization|tenant identity|exchange|mailbox|sharepoint|onedrive|site|setting|configuration|policy/.test(value)) return 'configuration_change'

  // Preserve unknown source evidence in storage, but do not present it as an
  // administrative change until a narrow mapping has been reviewed.
  return 'system_or_collection_event'
}

export function isPrimaryChange(input: {
  source?: string | null
  activity: string
  category?: string | null
  operationType?: string | null
  targetResourceTypes?: Array<string | null | undefined>
}) {
  return PRIMARY_CHANGE_CLASSIFICATIONS.has(classifyEvidence(input))
}
