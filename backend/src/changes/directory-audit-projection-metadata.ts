/** Provider facts must not be reconstructed from a presentation category. */
export const DIRECTORY_AUDIT_METADATA_KEY = 'hawkviewDirectoryAuditMetadata'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const own = (value: ObjectValue, key: string) => Object.hasOwn(value, key) ? value[key] : undefined
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null

export type DirectoryAuditMetadata = {
  version: 1
  category: string | null
  operationType: string | null
  targetResourceTypes: Array<string | null> | null
}

/** Only canonical stored audit fields may populate the reserved envelope. */
export function directoryAuditMetadata(record: {
  category?: unknown; operationType?: unknown; targetResources?: unknown
}): DirectoryAuditMetadata {
  return {
    version: 1,
    category: text(record.category),
    operationType: text(record.operationType),
    targetResourceTypes: Array.isArray(record.targetResources)
      ? Array.from(record.targetResources, target => text(own(object(target), 'type')))
      : null,
  }
}

type Selection =
  | { kind: 'provider'; category: string; operationType: string; targetResourceTypes: string[] }
  | { kind: 'invalid' }
  | { kind: 'legacy' }

function validate(value: unknown): Selection {
  const metadata = object(value)
  const category = text(own(metadata, 'category'))
  const operationType = text(own(metadata, 'operationType'))
  const types = own(metadata, 'targetResourceTypes')
  // Do not silently drop an unknown/malformed secondary target: the catalogue's
  // exact role/invite rules quantify over the entire target set.
  if (!category || !operationType || !Array.isArray(types) || types.length === 0) return { kind: 'invalid' }
  const targetResourceTypes = Array.from(types, text)
  if (targetResourceTypes.some(type => type === null)) return { kind: 'invalid' }
  return { kind: 'provider', category, operationType, targetResourceTypes: targetResourceTypes as string[] }
}

export function readDirectoryAuditMetadata(rawValue: unknown, event?: {
  operationName: string; result?: string | null; targetType?: string | null
}): Selection {
  const raw = object(rawValue)
  if (Object.hasOwn(raw, DIRECTORY_AUDIT_METADATA_KEY)) {
    const metadata = object(raw[DIRECTORY_AUDIT_METADATA_KEY])
    // A present invalid/future envelope must not fall back to more permissive
    // legacy rules or to conflicting raw provider fields.
    const selected = own(metadata, 'version') === 1 ? validate(metadata) : { kind: 'invalid' as const }
    if (selected.kind === 'provider' && event?.targetType && text(event.targetType) !== selected.targetResourceTypes[0]) return { kind: 'invalid' }
    return selected
  }
  if (Object.hasOwn(raw, 'category') || Object.hasOwn(raw, 'targetResources')) {
    // Older projections retain the original provider JSON. Use it only when
    // the complete provider shape is present, never supplement its target set
    // with the lossy first-target column or its category with a display label.
    const selected = validate(directoryAuditMetadata({
      category: own(raw, 'category'), operationType: own(raw, 'operationType'),
      targetResources: own(raw, 'targetResources'),
    }))
    if (event && selected.kind === 'provider') {
      if (Object.hasOwn(raw, 'activityDisplayName') && text(raw.activityDisplayName) !== text(event.operationName)) return { kind: 'invalid' }
      if (Object.hasOwn(raw, 'result') && text(raw.result) !== text(event.result)) return { kind: 'invalid' }
      if (event.targetType && text(event.targetType) !== selected.targetResourceTypes[0]) return { kind: 'invalid' }
    }
    return selected
  }
  return { kind: 'legacy' }
}
