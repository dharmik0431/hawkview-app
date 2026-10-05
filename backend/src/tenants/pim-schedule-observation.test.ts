import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePimScheduleObservations as normalize, type PimObservationBounds,
  type PimObservationResult, type PimScheduleInput } from './pim-schedule-observation.js'

// Synthetic test sizes, not product defaults. Every invocation supplies limits.
const bounds: PimObservationBounds = { maxInputRows: 100, maxInputBytes: 100_000,
  maxConflictVersions: 10, maxConflictEvidenceBytes: 20_000 }
const active = { id: 'arasi-0001', roleAssignmentScheduleId: 'aras-0001',
  roleDefinitionId: 'role-GA', principalId: 'prin-u1', directoryScopeId: '/',
  assignmentType: 'Activated', memberType: 'Direct', startDateTime: '2026-10-01T00:00:00Z',
  endDateTime: '2026-10-01T08:00:00Z', activatedUsing: { id: 'elig-inst-1' } }
const eligible = { id: 'erasi-0001', roleEligibilityScheduleId: 'eras-0001',
  roleDefinitionId: 'role-GA', principalId: 'prin-u1', directoryScopeId: '/',
  memberType: 'Direct', startDateTime: '2026-10-01T00:00:00Z', endDateTime: '2027-10-01T00:00:00Z' }
const row = (record: unknown, tenantId = 'T-alpha', plane: 'ACTIVE' | 'ELIGIBLE' = 'ACTIVE'): PimScheduleInput => ({ tenantId, plane, record })
function accepted(result: PimObservationResult) {
  assert.equal(result.ok, true)
  if (!result.ok) throw Error('Expected accepted observations')
  return result
}
function failed(input: readonly PimScheduleInput[], limits: PimObservationBounds, code: string) {
  assert.deepEqual(normalize(input, limits), { ok: false, code })
}

test('N1/N3/F01: same holding and schedule still retain distinct instance IDs', () => {
  const r = accepted(normalize([row(active), row({ ...active, id: 'arasi-0002' })], bounds))
  assert.equal(r.instances.length, 2)
  assert.deepEqual(r.instances.map(x => x.identity.instanceId), ['arasi-0001', 'arasi-0002'])
  assert.ok(r.instances.every(x => x.diagnostic === null))
  for (const x of r.instances) assert.deepEqual(x.variants[0]!.observations.roleAssignmentScheduleId,
    { state: 'PRESENT', value: 'aras-0001' })
})
test('F04/F05: tenant and plane are independent identity dimensions, with no inferred relationship', () => {
  const inputs = [row(active), row(active, 'T-beta'), row(active, 'T-alpha', 'ELIGIBLE')]
  const r = accepted(normalize(inputs, bounds))
  assert.equal(r.instances.length, 3)
  assert.ok(r.instances.every(x => x.diagnostic === null && x.variants.length === 1))
  assert.deepEqual(new Set(r.instances.map(x => JSON.stringify(x.identity))), new Set([
    JSON.stringify({ tenantId: 'T-alpha', plane: 'ACTIVE', instanceId: active.id }),
    JSON.stringify({ tenantId: 'T-beta', plane: 'ACTIVE', instanceId: active.id }),
    JSON.stringify({ tenantId: 'T-alpha', plane: 'ELIGIBLE', instanceId: active.id }),
  ]))
})
test('eligible schedule reference remains separate; missing active-plane fields stay absent', () => {
  const v = accepted(normalize([row(eligible, 'T-alpha', 'ELIGIBLE')], bounds)).instances[0]!.variants[0]!
  assert.deepEqual(v.raw, eligible)
  assert.deepEqual(v.observations.roleEligibilityScheduleId, { state: 'PRESENT', value: 'eras-0001' })
  assert.deepEqual(v.observations.roleAssignmentScheduleId, { state: 'ABSENT' })
  assert.deepEqual(v.observations.assignmentType, { state: 'ABSENT' })
  assert.deepEqual(v.observations.activatedUsing, { state: 'ABSENT' })
})
test('N2/F02/F02r: conflicts preserve all versions and are independent of input order', () => {
  const a = { ...active, roleDefinitionId: 'role-UA' }, b = { ...active, roleDefinitionId: 'role-X' }
  const first = normalize([row(active), row(a), row(b), row(active)], bounds)
  assert.deepEqual(first, normalize([row(b), row(active), row(a), row(b)], bounds))
  const group = accepted(first).instances[0]!
  assert.equal(group.diagnostic, 'DUPLICATE_INSTANCE_ID')
  assert.equal(group.variants.length, 3)
  assert.deepEqual(new Set(group.variants.map(v => v.raw.roleDefinitionId)), new Set(['role-GA', 'role-UA', 'role-X']))
})
test('F03/F03a: equal nested objects coalesce despite property insertion order', () => {
  const first = { id: 'i', unknown: { z: [1, { b: 2, a: 1 }], a: null } }
  const second = { unknown: { a: null, z: [1, { a: 1, b: 2 }] }, id: 'i' }
  const r = accepted(normalize([row(first), row(second)], bounds))
  assert.equal(r.instances[0]!.diagnostic, null)
  assert.equal(r.instances[0]!.variants.length, 1)
  assert.deepEqual(r.instances[0]!.variants[0]!.raw, first)
})
for (const [name, first, second] of [
  ['array order', { extension: [1, 2] }, { extension: [2, 1] }],
  ['absent versus null', {}, { startDateTime: null }],
  ['enum case', { memberType: 'Direct' }, { memberType: 'direct' }],
  // F03e reconciliation: keep identity valid and constant; test a nonidentity field.
  ['number versus string', { extensionValue: '11' }, { extensionValue: 11 }],
  ['unknown property', { extension: { retained: true } }, { extension: { retained: false } }],
  ['different raw scope fields', { directoryScopeId: '/' }, { appScopeId: '/' }],
] as const) test('structural conflict retains ' + name, () => {
  const r = accepted(normalize([row({ id: 'i', ...first }), row({ id: 'i', ...second })], bounds))
  assert.equal(r.instances[0]!.diagnostic, 'DUPLICATE_INSTANCE_ID')
  assert.equal(r.instances[0]!.variants.length, 2)
})
test('F15b/F16: separate scoped instances never collapse or parse their scope strings', () => {
  const values = [{ id: 'a', directoryScopeId: '/administrativeUnits/au-7' }, { id: 'b', appScopeId: '/' }]
  const r = accepted(normalize(values.map(x => row(x)), bounds))
  assert.equal(r.instances.length, 2)
  assert.deepEqual(r.instances.map(x => x.variants[0]!.raw), values)
})
for (const [label, field, observation, diagnostic] of [
  ['F17 absent', {}, { state: 'ABSENT' }, []],
  ['F18 null', { activatedUsing: null }, { state: 'EXPLICIT_NULL' }, []],
  ['F19 valid', { activatedUsing: { id: 'elig-inst-1' } }, { state: 'PRESENT', value: { id: 'elig-inst-1' } }, []],
  ['F20 empty object', { activatedUsing: {} }, { state: 'PRESENT', value: {} }, ['RELATIONSHIP_ID_ABSENT']],
  ['F21 number', { activatedUsing: 17 }, { state: 'PRESENT', value: 17 }, ['RELATIONSHIP_NOT_OBJECT']],
  ['F22 null id', { activatedUsing: { id: null } }, { state: 'PRESENT', value: { id: null } }, ['RELATIONSHIP_ID_NULL']],
] as const) test('N4/N5/N7/N13-N16 linkage: ' + label, () => {
  const raw = { id: 'i', assignmentType: 'Activated', ...field }
  const v = accepted(normalize([row(raw)], bounds)).instances[0]!.variants[0]!
  assert.deepEqual(v.raw, raw)
  assert.deepEqual(v.observations.activatedUsing, observation)
  assert.deepEqual(v.diagnostics, diagnostic)
  assert.deepEqual(v.observations.assignmentType, { state: 'PRESENT', value: 'Activated' })
})
test('N6/N8/N9: id-only, unknown enums, null dates and missing groupId do not invent semantics', () => {
  for (const raw of [{ id: 'i', '@odata.type': '#unknown' },
    { id: 'i', assignmentType: 'FutureEnum', memberType: 'Inherited', startDateTime: null, endDateTime: 'not-a-date' },
    { id: 'i', memberType: 'Group' }]) {
    const v = accepted(normalize([row(raw)], bounds)).instances[0]!.variants[0]!
    assert.deepEqual(v.raw, raw); assert.deepEqual(v.diagnostics, [])
  }
})
for (const [raw, diagnostic] of [
  [{ extension: 1 }, 'IDENTITY_ABSENT'], [{ id: null }, 'IDENTITY_EXPLICIT_NULL'],
  [{ id: '' }, 'IDENTITY_EMPTY'], [{ id: 17 }, 'IDENTITY_NOT_STRING'],
  [{ id: false }, 'IDENTITY_NOT_STRING'], [{ id: [] }, 'IDENTITY_NOT_STRING'],
  [null, 'RECORD_NOT_OBJECT'], [17, 'RECORD_NOT_OBJECT'], [[], 'RECORD_NOT_OBJECT'],
] as const) test('malformed identity retained: ' + JSON.stringify(raw), () => {
  const r = accepted(normalize([row(raw)], bounds))
  assert.deepEqual(r.instances, [])
  assert.deepEqual(r.rejected, [{ tenantId: 'T-alpha', plane: 'ACTIVE', raw, diagnostic }])
})
test('resolved F03e: numeric id does not acquire a fabricated duplicate identity', () => {
  const r = accepted(normalize([row({ id: 'arasi-011' }), row({ id: 11 })], bounds))
  assert.equal(r.instances.length, 1); assert.equal(r.instances[0]!.diagnostic, null)
  assert.equal(r.rejected[0]!.diagnostic, 'IDENTITY_NOT_STRING')
  assert.deepEqual(r.rejected[0]!.raw, { id: 11 })
})
test('N11/N12: no retained-state merge, clocks, coverage or holder counts; input is not mutated or aliased', () => {
  const raw = { id: 'i', extension: { values: [1, 2] } }, saved = structuredClone(raw)
  const first = accepted(normalize([row(raw)], bounds))
  assert.deepEqual(Object.keys(first).sort(), ['instances', 'ok', 'rejected'])
  assert.deepEqual(Object.keys(first.instances[0]!).sort(), ['diagnostic', 'identity', 'variants'])
  assert.deepEqual(raw, saved)
  ;(first.instances[0]!.variants[0]!.raw.extension as { values: number[] }).values.push(3)
  assert.deepEqual(raw, saved)
  const next = accepted(normalize([row({ id: 'i' })], bounds))
  assert.deepEqual(next.instances[0]!.variants[0]!.raw, { id: 'i' })
})
test('unknown nested JSON, dangerous property names, unicode and signed zero retain parsed values', () => {
  const raw = JSON.parse('{"id":"i","__proto__":{"polluted":true},"constructor":null,"u":"é😀","n":-0}')
  const v = accepted(normalize([row(raw)], bounds)).instances[0]!.variants[0]!
  assert.deepEqual(v.raw, raw)
  assert.ok(Object.is(v.raw.n, -0))
  assert.equal(({} as { polluted?: boolean }).polluted, undefined)
})
test('input row bounds count duplicate and rejected rows before normalization, including zero', () => {
  assert.deepEqual(normalize([], { maxInputRows: 0, maxInputBytes: 0, maxConflictVersions: 0, maxConflictEvidenceBytes: 0 }),
    { ok: true, instances: [], rejected: [] })
  const rows = [row({ id: 'i' }), row({ id: 'i' }), row({ id: null })]
  accepted(normalize(rows, { ...bounds, maxInputRows: 3 }))
  failed(rows, { ...bounds, maxInputRows: 2 }, 'INPUT_ROW_LIMIT_EXCEEDED')
})
test('input UTF-8 byte bound includes context, repeated and rejected JSON; exact boundary is inclusive', () => {
  const rows = [row({ id: 'é', text: '😀' }), row({ id: 'é', text: '😀' }), row({ id: null })]
  const bytes = rows.reduce((sum, x) => sum + Buffer.byteLength(JSON.stringify([x.tenantId, x.plane])) + Buffer.byteLength(JSON.stringify(x.record)), 0)
  accepted(normalize(rows, { ...bounds, maxInputBytes: bytes }))
  failed(rows, { ...bounds, maxInputBytes: bytes - 1 }, 'INPUT_BYTE_LIMIT_EXCEEDED')
})
test('F27-F29 conflict version cap is inclusive and counts distinct versions, never truncates', () => {
  const rows = [1, 2, 3].map(n => row({ id: 'i', n }))
  accepted(normalize(rows.slice(0, 2), { ...bounds, maxConflictVersions: 3 }))
  const r = accepted(normalize([...rows, rows[0]!], { ...bounds, maxConflictVersions: 3 }))
  assert.equal(r.instances[0]!.variants.length, 3)
  failed([...rows, row({ id: 'i', n: 4 })], { ...bounds, maxConflictVersions: 3 }, 'CONFLICT_EVIDENCE_LIMIT_EXCEEDED')
  failed(rows.slice(0, 2), { ...bounds, maxConflictVersions: 1 }, 'CONFLICT_EVIDENCE_LIMIT_EXCEEDED')
})
test('F30-F31 conflict bytes include first versions and aggregate across identities, not duplicates', () => {
  const raw = [{ id: 'a', n: 1 }, { id: 'a', n: 2 }, { id: 'b', n: 1 }, { id: 'b', n: 2 }]
  const rows = raw.map(x => row(x)), bytes = raw.reduce((sum, x) => sum + Buffer.byteLength(JSON.stringify(x)), 0)
  accepted(normalize([...rows, rows[0]!], { ...bounds, maxConflictEvidenceBytes: bytes }))
  failed(rows, { ...bounds, maxConflictEvidenceBytes: bytes - 1 }, 'CONFLICT_EVIDENCE_LIMIT_EXCEEDED')
  failed([...rows].reverse(), { ...bounds, maxConflictEvidenceBytes: bytes - 1 }, 'CONFLICT_EVIDENCE_LIMIT_EXCEEDED')
})
test('all bounds must be explicit nonnegative safe integers; no hidden defaults', () => {
  for (const key of Object.keys(bounds)) for (const value of [undefined, null, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '10']) {
    failed([], { ...bounds, [key]: value } as PimObservationBounds, 'INVALID_BOUNDS')
  }
  failed([], undefined as unknown as PimObservationBounds, 'INVALID_BOUNDS')
})
test('invalid contexts and non-JSON values fail explicitly without input-bearing errors', () => {
  for (const entry of [row({}, ''), { ...row({}), plane: 'other' }, { ...row({}), tenantId: 17 }]) {
    failed([entry as PimScheduleInput], bounds, 'INVALID_CONTEXT')
  }
  for (const raw of [undefined, NaN, Infinity, BigInt(1), new Date(0), { id: 'i', x: undefined }, [ , 1]]) {
    failed([row(raw)], bounds, 'INVALID_JSON')
  }
  const cyclic: { x?: unknown } = {}; cyclic.x = cyclic
  failed([row(cyclic)], bounds, 'INVALID_JSON')
  let invoked = 0
  const accessor = Object.defineProperty({ id: 'i' }, 'secret', { enumerable: true, get() { invoked++; return 'secret' } })
  failed([row(accessor)], bounds, 'INVALID_JSON'); assert.equal(invoked, 0)
})
test('deep parsed JSON is handled iteratively within byte limits', () => {
  const depth = 12000
  const raw = JSON.parse('{"id":"i","extension":' + '['.repeat(depth) + '0' + ']'.repeat(depth) + '}')
  const v = accepted(normalize([row(raw)], bounds)).instances[0]!.variants[0]!
  let nested = v.raw.extension
  for (let i = 0; i < depth; i++) { assert.ok(Array.isArray(nested)); nested = nested[0] }
  assert.equal(nested, 0)
})
