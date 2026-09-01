import { classifyEvidenceTrust } from './evidence-trust-catalog.js'

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
  | 'Organization'
  | 'Domains'
  | 'Exchange'
  | 'SharePoint'
  | 'Unknown'

type EvidenceClassificationInput = {
  source?: string | null
  workload?: string | null
  activity: string
  category?: string | null
  operationType?: string | null
  targetResourceTypes?: Array<string | null | undefined>
  actor?: string | null
  result?: string | null
  target?: string | null
  beforeState?: unknown
  afterState?: unknown
  raw?: unknown
}

function meaningfulStateValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (Array.isArray(value)) return value.some(meaningfulStateValue)
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(meaningfulStateValue)
  return true
}

function stateBoolean(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = Object.entries(value as Record<string, unknown>)
    .find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]
  return candidate === true || (typeof candidate === 'string' && candidate.toLowerCase() === 'true')
}

/**
 * Narrow Microsoft-owned operations that must not be presented as customer
 * configuration changes. The evidence remains retained; this only controls
 * the primary investigation/action surfaces.
 */
export function isKnownMicrosoftSystemEvent(input: EvidenceClassificationInput): boolean {
  const activity = input.activity.trim().toLowerCase()
  const actor = input.actor?.trim().toLowerCase() ?? ''

  // Portal feature discovery is a lookup operation despite Microsoft marking
  // the directory-audit operation type as "Update".
  if (/^features[_\s-]*getfeaturesasync$/.test(activity)) return true

  // Microsoft can emit this Office portal bookkeeping record with no actual
  // company-information values. A real populated company update remains visible.
  if (
    activity === 'set company information'
    && !meaningfulStateValue(input.beforeState)
    && !meaningfulStateValue(input.afterState)
  ) return true

  // Microsoft documents this exact actor as its asynchronous service-principal
  // provisioning process, rather than a named tenant administrator.
  if (actor === 'microsoft azure ad internal - jit provisioning') return true

  // Exchange Online uses this service identity for Admin API work. Suppress
  // only the system/arbitration-mailbox shape; ordinary Set-Mailbox changes
  // initiated through the same service remain visible.
  if (
    activity === 'set-mailbox'
    && actor.startsWith('nt service\\msexchangeadminapinetcore')
    && stateBoolean(input.afterState, 'Arbitration')
  ) return true

  return false
}

export function legacyCategory(
  activity: string,
  category?: string | null,
  operationType?: string | null,
  targetResourceTypes?: Array<string | null | undefined>,
): {
  category: LegacyChangeCategory
  severity: 'Low' | 'Medium' | 'High'
} {
  const trusted = classifyEvidenceTrust({
    source: 'DIRECTORY_AUDIT', operation: activity, category, operationType, targetResourceTypes,
  })
  return { category: trusted.category, severity: trusted.severity }
}

export function classifyEvidence(input: EvidenceClassificationInput): ChangeClassification {
  if (isKnownMicrosoftSystemEvent(input)) return 'system_or_collection_event'
  return classifyEvidenceTrust({
    source: input.source,
    workload: input.workload,
    operation: input.activity,
    category: input.category,
    operationType: input.operationType,
    targetResourceTypes: input.targetResourceTypes,
    actor: input.actor,
    result: input.result,
    beforeState: input.beforeState,
    afterState: input.afterState,
  }).classification
}

export function isPrimaryChange(input: EvidenceClassificationInput) {
  return PRIMARY_CHANGE_CLASSIFICATIONS.has(classifyEvidence(input))
}
