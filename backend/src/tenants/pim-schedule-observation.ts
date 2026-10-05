/**
 * Unwired W6 raw directory schedule observations, not effective holdings.
 * Preserves parsed JSON values, not original wire bytes. No retained-state merge,
 * clocks, completeness certification, permission diagnosis or temporal evaluation.
 */
export type PimPlane = 'ACTIVE' | 'ELIGIBLE'
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type Observation =
  | { state: 'ABSENT' }
  | { state: 'EXPLICIT_NULL' }
  | { state: 'PRESENT'; value: JsonValue }

export interface PimScheduleInput {
  tenantId: string
  plane: PimPlane
  record: unknown
}

export interface PimObservationBounds {
  /** All input rows, including duplicates and malformed records. */
  maxInputRows: number
  /** Sum of UTF-8 canonical record JSON plus JSON [tenantId, plane], per row. */
  maxInputBytes: number
  /** Distinct versions per conflicting identity, including the first version. */
  maxConflictVersions: number
  /** Sum of canonical raw JSON bytes across ALL conflicting identities. */
  maxConflictEvidenceBytes: number
}

const fields = [
  'id', 'principalId', 'roleDefinitionId', 'roleAssignmentScheduleId',
  'roleEligibilityScheduleId', 'directoryScopeId', 'appScopeId',
  'assignmentType', 'memberType', 'startDateTime', 'endDateTime', 'activatedUsing',
] as const
type Field = typeof fields[number]
type IdentityDiagnostic = 'RECORD_NOT_OBJECT' | 'IDENTITY_ABSENT' |
  'IDENTITY_EXPLICIT_NULL' | 'IDENTITY_EMPTY' | 'IDENTITY_NOT_STRING'
type RelationshipDiagnostic = 'RELATIONSHIP_NOT_OBJECT' | 'RELATIONSHIP_ID_ABSENT' |
  'RELATIONSHIP_ID_NULL' | 'RELATIONSHIP_ID_NOT_STRING' | 'RELATIONSHIP_ID_EMPTY'
export interface PimIdentity { tenantId: string; plane: PimPlane; instanceId: string }
export interface PimVariant {
  raw: { [key: string]: JsonValue }
  observations: Record<Field, Observation>
  diagnostics: RelationshipDiagnostic[]
}
export type PimObservationResult =
  | { ok: false; code: 'INVALID_BOUNDS' | 'INVALID_INPUT' | 'INVALID_CONTEXT' |
      'INVALID_JSON' | 'INPUT_ROW_LIMIT_EXCEEDED' | 'INPUT_BYTE_LIMIT_EXCEEDED' |
      'CONFLICT_EVIDENCE_LIMIT_EXCEEDED' }
  | { ok: true; instances: Array<{ identity: PimIdentity; variants: PimVariant[];
        diagnostic: 'DUPLICATE_INSTANCE_ID' | null }>;
      rejected: Array<{ tenantId: string; plane: PimPlane; raw: JsonValue;
        diagnostic: IdentityDiagnostic }> }

class Rejected extends Error {
  constructor(readonly code: Extract<PimObservationResult, { ok: false }>['code']) {
    super(code)
  }
}

/** Iterative traversal avoids a depth-dependent JS call stack; cycles/non-JSON
 * values are explicitly rejected. Accessors/toJSON are never evaluated. */
function canonicalJson(value: unknown, byteLimit: number): { text: string; bytes: number } {
  type Task = { kind: 'value'; value: unknown } | { kind: 'text'; text: string } |
    { kind: 'leave'; value: object }
  const tasks: Task[] = [{ kind: 'value', value }]
  const ancestors = new Set<object>()
  const chunks: string[] = []
  let bytes = 0
  const append = (text: string) => {
    bytes += Buffer.byteLength(text, 'utf8')
    if (bytes > byteLimit) throw new Rejected('INPUT_BYTE_LIMIT_EXCEEDED')
    chunks.push(text)
  }
  while (tasks.length) {
    const task = tasks.pop()!
    if (task.kind === 'text') { append(task.text); continue }
    if (task.kind === 'leave') { ancestors.delete(task.value); continue }
    const v = task.value
    if (v === null) { append('null'); continue }
    if (typeof v === 'string') {
      if (v.length > byteLimit - bytes) throw new Rejected('INPUT_BYTE_LIMIT_EXCEEDED')
      append(JSON.stringify(v)); continue
    }
    if (typeof v === 'boolean') { append(v ? 'true' : 'false'); continue }
    if (typeof v === 'number' && Number.isFinite(v)) {
      append(Object.is(v, -0) ? '-0' : JSON.stringify(v)); continue
    }
    if (typeof v !== 'object' || ancestors.has(v)) throw new Rejected('INVALID_JSON')
    const array = Array.isArray(v)
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
      throw new Rejected('INVALID_JSON')
    }
    const descriptors = Object.getOwnPropertyDescriptors(v)
    if (Reflect.ownKeys(v).some(key => typeof key !== 'string')) throw new Rejected('INVALID_JSON')
    const keys = array ? Object.keys(descriptors).filter(key => key !== 'length') : Object.keys(descriptors).sort()
    if (array && (keys.length !== v.length || keys.some((key, index) => key !== String(index)))) {
      throw new Rejected('INVALID_JSON')
    }
    if (keys.some(key => !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))) {
      throw new Rejected('INVALID_JSON')
    }
    ancestors.add(v)
    append(array ? '[' : '{')
    tasks.push({ kind: 'leave', value: v }, { kind: 'text', text: array ? ']' : '}' })
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!
      tasks.push({ kind: 'value', value: descriptors[key]!.value })
      if (!array) tasks.push({ kind: 'text', text: JSON.stringify(key) + ':' })
      if (i > 0) tasks.push({ kind: 'text', text: ',' })
    }
  }
  return { text: chunks.join(''), bytes }
}

function observe(raw: { [key: string]: JsonValue }, field: Field): Observation {
  if (!Object.hasOwn(raw, field)) return { state: 'ABSENT' }
  return raw[field] === null ? { state: 'EXPLICIT_NULL' } : { state: 'PRESENT', value: raw[field]! }
}

function identityProblem(raw: JsonValue): IdentityDiagnostic | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'RECORD_NOT_OBJECT'
  if (!Object.hasOwn(raw, 'id')) return 'IDENTITY_ABSENT'
  if (raw.id === null) return 'IDENTITY_EXPLICIT_NULL'
  if (typeof raw.id !== 'string') return 'IDENTITY_NOT_STRING'
  if (raw.id.length === 0) return 'IDENTITY_EMPTY'
  return null
}

function variant(raw: { [key: string]: JsonValue }): PimVariant {
  const observations = Object.fromEntries(fields.map(field => [field, observe(raw, field)])) as Record<Field, Observation>
  const diagnostics: RelationshipDiagnostic[] = []
  const link = observations.activatedUsing
  if (link.state === 'PRESENT') {
    const value = link.value
    if (typeof value !== 'object' || Array.isArray(value)) diagnostics.push('RELATIONSHIP_NOT_OBJECT')
    else if (!Object.hasOwn(value!, 'id')) diagnostics.push('RELATIONSHIP_ID_ABSENT')
    else if (value!.id === null) diagnostics.push('RELATIONSHIP_ID_NULL')
    else if (typeof value!.id !== 'string') diagnostics.push('RELATIONSHIP_ID_NOT_STRING')
    else if (value!.id.length === 0) diagnostics.push('RELATIONSHIP_ID_EMPTY')
  }
  return { raw, observations, diagnostics }
}

/** Atomic result: any input/conflict bound failure returns no partial payload.
 * Valid identities are exact nonempty strings; no trimming/case folding or ID
 * synthesis. Invalid record identity remains raw in rejected, never in a key.
 * Input must be ordinary parsed JSON data (no proxies or executable objects).
 */
export function normalizePimScheduleObservations(
  input: readonly PimScheduleInput[], bounds: PimObservationBounds,
): PimObservationResult {
  if (!bounds || !['maxInputRows', 'maxInputBytes', 'maxConflictVersions', 'maxConflictEvidenceBytes']
    .every(key => Number.isSafeInteger(bounds[key as keyof PimObservationBounds]) && bounds[key as keyof PimObservationBounds] >= 0)) {
    return { ok: false, code: 'INVALID_BOUNDS' }
  }
  if (!Array.isArray(input)) return { ok: false, code: 'INVALID_INPUT' }
  if (input.length > bounds.maxInputRows) return { ok: false, code: 'INPUT_ROW_LIMIT_EXCEEDED' }
  const groups = new Map<string, { identity: PimIdentity; versions: Map<string, { raw: JsonValue; bytes: number }> }>()
  const rejected: Extract<PimObservationResult, { ok: true }>['rejected'] = []
  let inputBytes = 0, conflictBytes = 0
  try {
    for (const entry of input) {
      if (!entry || typeof entry.tenantId !== 'string' || entry.tenantId.length === 0 ||
          (entry.plane !== 'ACTIVE' && entry.plane !== 'ELIGIBLE')) throw new Rejected('INVALID_CONTEXT')
      const context = canonicalJson([entry.tenantId, entry.plane], bounds.maxInputBytes - inputBytes)
      inputBytes += context.bytes
      const encoded = canonicalJson(entry.record, bounds.maxInputBytes - inputBytes)
      inputBytes += encoded.bytes
      const raw = JSON.parse(encoded.text) as JsonValue
      const problem = identityProblem(raw)
      if (problem) {
        rejected.push({ tenantId: entry.tenantId, plane: entry.plane, raw, diagnostic: problem })
        continue
      }
      const instanceId = (raw as { id: string }).id
      const identity = { tenantId: entry.tenantId, plane: entry.plane, instanceId }
      const key = JSON.stringify([identity.tenantId, identity.plane, identity.instanceId])
      let group = groups.get(key)
      if (!group) { group = { identity, versions: new Map() }; groups.set(key, group) }
      if (group.versions.has(encoded.text)) continue
      if (group.versions.size > 0) {
        if (group.versions.size + 1 > bounds.maxConflictVersions) throw new Rejected('CONFLICT_EVIDENCE_LIMIT_EXCEEDED')
        conflictBytes += encoded.bytes
        if (group.versions.size === 1) conflictBytes += group.versions.values().next().value!.bytes
        if (conflictBytes > bounds.maxConflictEvidenceBytes) throw new Rejected('CONFLICT_EVIDENCE_LIMIT_EXCEEDED')
      }
      group.versions.set(encoded.text, { raw, bytes: encoded.bytes })
    }
    const instances = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => ({
      identity: group.identity,
      variants: [...group.versions.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([, value]) => variant(value.raw as { [key: string]: JsonValue })),
      diagnostic: group.versions.size > 1 ? 'DUPLICATE_INSTANCE_ID' as const : null,
    }))
    return { ok: true, instances, rejected }
  } catch (error) {
    if (error instanceof Rejected) return { ok: false, code: error.code }
    throw error
  }
}
