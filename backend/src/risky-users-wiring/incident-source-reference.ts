import type { SourceEventReference } from '../evaluation-core/contract.js'
import type { NormalizedEvent } from '../risky-users-normalization/contract.js'

export const SOURCE_REFERENCE_SELECTION = 'LATEST_QUALIFYING_EVENT_FOR_SIGNAL' as const
export const SOURCE_REFERENCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const keys = ['version', 'selection', 'organizationId', 'customerTenantId', 'source',
  'eventId', 'eventAt', 'subjectRef', 'subjectBinding'].sort().join(',')

/** Metadata only. An invalid optional reference must never suppress a valid finding. */
export function readSourceEventReference(value: unknown): SourceEventReference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string'
    || !descriptors[key]?.enumerable || !('value' in descriptors[key]!))
    || Object.keys(value).sort().join(',') !== keys) return undefined
  const v = value as Record<string, unknown>
  if (v.version !== 1 || v.selection !== SOURCE_REFERENCE_SELECTION
    || typeof v.organizationId !== 'string' || !SOURCE_REFERENCE_UUID.test(v.organizationId)
    || typeof v.customerTenantId !== 'string' || !SOURCE_REFERENCE_UUID.test(v.customerTenantId)
    || (v.source !== 'GRAPH_SIGN_INS' && v.source !== 'M365_AUDIT_STS')
    || typeof v.subjectRef !== 'string' || !/^subject:[0-9a-f-]{36}$/.test(v.subjectRef)
    || !SOURCE_REFERENCE_UUID.test(v.subjectRef.slice(8))
    || (v.subjectBinding !== 'DIRECTORY_OBJECT_ID' && v.subjectBinding !== 'NORMALIZED_UPN')
    || (v.source === 'GRAPH_SIGN_INS' && v.subjectBinding !== 'DIRECTORY_OBJECT_ID')
    || (v.source === 'M365_AUDIT_STS' && v.subjectBinding !== 'NORMALIZED_UPN')
    || typeof v.eventId !== 'string' || v.eventId.length < 1
    || v.eventId.length > (v.source === 'GRAPH_SIGN_INS' ? 200 : 189)
    || /[\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(v.eventId)
    || typeof v.eventAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.eventAt)
    || !Number.isFinite(Date.parse(v.eventAt)) || new Date(v.eventAt).toISOString() !== v.eventAt) return undefined
  return { version: 1, selection: SOURCE_REFERENCE_SELECTION, organizationId: v.organizationId,
    customerTenantId: v.customerTenantId, source: v.source, eventId: v.eventId,
    eventAt: v.eventAt, subjectRef: v.subjectRef, subjectBinding: v.subjectBinding }
}

export function sourceEventReference(event: NormalizedEvent): SourceEventReference | undefined {
  return readSourceEventReference({ version: 1, selection: SOURCE_REFERENCE_SELECTION,
    organizationId: event.organizationId, customerTenantId: event.customerTenantId,
    source: event.source, eventId: event.eventId, eventAt: event.eventAt,
    subjectRef: event.subjectRef, subjectBinding: event.subjectBinding })
}

/** Same ordering as the normalized producer: latest time, then lexical source/event ID. */
export function latestSourceReference(
  previous: SourceEventReference | undefined, next: SourceEventReference | undefined,
): SourceEventReference | undefined {
  if (!next) return previous
  if (!previous) return next
  const left = `${previous.eventAt}|${previous.source}|${previous.eventId}`
  const right = `${next.eventAt}|${next.source}|${next.eventId}`
  return right > left ? next : previous
}
