import { assemblePimSchedulePages } from './pim-schedule-page-assembly.js'
import { normalizePimScheduleObservations } from './pim-schedule-observation.js'
import { copyPimLimits, PIM_FAILURES, pimDigest, pimJsonText, type JsonValue, type ParsedEnvelope,
  type ParsedObservationRow, type PimContext, type PimFailure, type PimLimits, type PreparedPimCollection } from './pim-schedule-contract.js'

export function copyPimEnvelopes(input: readonly ParsedEnvelope[], limits: PimLimits): ParsedEnvelope[] {
  if (!Array.isArray(input) || input.length > limits.pages) throw new Error('INVALID_PIM_ENVELOPES')
  let retained = 0, wire = 0
  return input.map((p, i) => {
    if (p.pageIndex !== i || typeof p.requestedToken !== 'string' || !p.requestedToken
      || !Number.isSafeInteger(p.byteLength) || p.byteLength < 0 || p.byteLength > limits.pageBytes) throw new Error('INVALID_PIM_ENVELOPE')
    wire += p.byteLength
    const text = pimJsonText(p.envelope, limits.materializedBytes - retained)
    retained += Buffer.byteLength(text) + Buffer.byteLength(p.requestedToken)
    if (retained > limits.materializedBytes || wire > limits.wireBytes) throw new Error('PIM_PAYLOAD_LIMIT')
    return { pageIndex: i, requestedToken: p.requestedToken, byteLength: p.byteLength, envelope: JSON.parse(text) as JsonValue }
  })
}
function providerTime(raw: JsonValue, field: string): Date | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw[field]
  // Derived clock only. Invalid/absent/null fields remain intact in raw/observations.
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v)) return null
  const date = new Date(v)
  return Number.isFinite(date.getTime()) ? date : null
}

export function preparePimCollection(context: Pick<PimContext, 'customerTenantId' | 'plane'>,
  input: readonly ParsedEnvelope[], requestedLimits: PimLimits): PreparedPimCollection {
  const limits = copyPimLimits(requestedLimits), envelopes = copyPimEnvelopes(input, limits)
  const bounds = { maxPages: limits.pages, maxInputRows: limits.rows, maxInputBytes: limits.materializedBytes,
    maxConflictVersions: limits.maxConflictVersions, maxConflictEvidenceBytes: limits.maxConflictEvidenceBytes }
  const assembled = assemblePimSchedulePages({ tenantId: context.customerTenantId, plane: context.plane },
    envelopes.map(p => ({ requestedPageToken: p.requestedToken, envelope: p.envelope })), bounds)
  if (!assembled.ok) throw new Error('PIM_ASSEMBLY_' + assembled.code)
  // The assembler's grouped variants are evidence, not occurrence identity. Walk the
  // validated input in order, retaining even identical duplicates and rejected identities.
  const rawRows = envelopes.flatMap(p => (p.envelope as { value: JsonValue[] }).value)
  const counts = new Map<string, number>()
  for (const raw of rawRows) {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.id === 'string' && raw.id.length) {
      counts.set(raw.id, (counts.get(raw.id) ?? 0) + 1)
    }
  }
  const rows: ParsedObservationRow[] = rawRows.map((raw, occurrenceOrdinal) => {
    const one = normalizePimScheduleObservations([{ tenantId: context.customerTenantId, plane: context.plane, record: raw }], bounds)
    if (!one.ok) throw new Error('PIM_ASSEMBLY_' + one.code)
    const instance = one.instances[0], variant = instance?.variants[0]
    const diagnostics: string[] = variant ? [...variant.diagnostics] : [one.rejected[0].diagnostic]
    if (instance && counts.get(instance.identity.instanceId)! > 1) diagnostics.push('DUPLICATE_INSTANCE_ID')
    return { occurrenceOrdinal, instanceId: instance?.identity.instanceId ?? null, plane: context.plane, raw,
      observations: variant ? variant.observations as unknown as JsonValue : {}, diagnostics,
      providerStartDateTime: providerTime(raw, 'startDateTime'), providerEndDateTime: providerTime(raw, 'endDateTime') }
  })
  const retained = Buffer.byteLength(pimJsonText(envelopes, limits.materializedBytes))
  // Date columns are derived separately; JSON size accounts for their ISO representation.
  pimJsonText(rows.map(r => ({ ...r, providerStartDateTime: r.providerStartDateTime?.toISOString() ?? null,
    providerEndDateTime: r.providerEndDateTime?.toISOString() ?? null })), limits.materializedBytes - retained)
  return { envelopes, rows, traversalOutcome: 'EXHAUSTED', contentDigest: pimDigest(context.plane, rows, limits.materializedBytes) }
}

/** Re-derive rather than trusting caller-supplied rows, diagnostics, ordinals or digest. */
export function copyPreparedPim(context: PimContext, input: PreparedPimCollection, limits: PimLimits): PreparedPimCollection {
  if (input.traversalOutcome !== 'EXHAUSTED' || !Array.isArray(input.rows)) throw new Error('INVALID_PIM_PUBLICATION')
  const prepared = preparePimCollection(context, input.envelopes, limits)
  if (input.contentDigest !== prepared.contentDigest || input.rows.length !== prepared.rows.length) throw new Error('INVALID_PIM_PUBLICATION')
  for (let i = 0; i < input.rows.length; i++) {
    const a = input.rows[i], b = prepared.rows[i]
    if (a.occurrenceOrdinal !== i || a.plane !== context.plane || a.instanceId !== b.instanceId
      || (a.providerStartDateTime?.getTime() ?? null) !== (b.providerStartDateTime?.getTime() ?? null)
      || (a.providerEndDateTime?.getTime() ?? null) !== (b.providerEndDateTime?.getTime() ?? null)
      || pimJsonText([a.raw, a.observations, a.diagnostics], limits.materializedBytes)
        !== pimJsonText([b.raw, b.observations, b.diagnostics], limits.materializedBytes)) throw new Error('INVALID_PIM_PUBLICATION')
  }
  return prepared
}
export function copyPimFailure(input: PimFailure, limits: PimLimits): PimFailure {
  if (!PIM_FAILURES.includes(input.failureKind) || !['TRUNCATED_BUDGET', 'TRUNCATED_DEADLINE', 'ERRORED'].includes(input.traversalOutcome)
    || !Array.isArray(input.wireFailures) || input.wireFailures.length > 1) throw new Error('INVALID_PIM_FAILURE')
  const envelopes = copyPimEnvelopes(input.envelopes, limits)
  const wireFailures = input.wireFailures.map(w => {
    if (w.failureKind !== 'INVALID_JSON' || w.pageIndex !== envelopes.length || !Number.isSafeInteger(w.byteLength)
      || w.byteLength < 0 || w.byteLength > limits.pageBytes) throw new Error('INVALID_PIM_WIRE_FAILURE')
    return { pageIndex: w.pageIndex, byteLength: w.byteLength, failureKind: 'INVALID_JSON' as const }
  })
  if (envelopes.reduce((n, p) => n + p.byteLength, 0) + wireFailures.reduce((n, w) => n + w.byteLength, 0) > limits.wireBytes) throw new Error('PIM_PAYLOAD_LIMIT')
  return { failureKind: input.failureKind, traversalOutcome: input.traversalOutcome, envelopes, wireFailures }
}
