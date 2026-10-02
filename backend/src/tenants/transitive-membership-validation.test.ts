import assert from 'node:assert/strict'
import test from 'node:test'
import { AUTH_REGISTRATION_FALLBACK_LIMITS, TenantSyncService, type AuthRegistrationFallbackLimits } from './tenant-sync.service.js'
import { createAssessmentProtectionLoader } from '../identity-risk/risk-assessment-protection-loader.js'

const NOW = new Date('2026-10-01T12:00:00.000Z')
const ORG = '10000000-0000-4000-8000-000000000001', TENANT = '10000000-0000-4000-8000-000000000002'
const USER = '10000000-0000-4000-8000-000000000003', GROUP = '10000000-0000-4000-8000-000000000004', ROLE = '10000000-0000-4000-8000-000000000005'
type Row = { id: string; [key: string]: any }
type Internal = {
  fetchGraphPage: (url: string, token: string, label: string, options: any) => Promise<Response>
  enrichAuthenticationRegistrationsWithConditionalAccessContext: (token: string, rows: unknown[], limits: Readonly<AuthRegistrationFallbackLimits>) => Promise<Row[]>
}
const registration = (id = USER): Row => ({ id, isMfaRegistered: true, methodsRegistered: ['fido2'], perUserMfaState: 'enforced', retainedFact: { source: 'fixture' }, conditionalAccessContext: { transitiveGroupIds: [GROUP], membershipComplete: true, observedAt: '2026-09-30T12:00:00.000Z' } })
const good = (id = '1', body: unknown = { value: [] }, status: unknown = 200) => ({ id, status, body })
function fixture(replies: Array<unknown | (() => unknown)>, overrides: Partial<AuthRegistrationFallbackLimits> = {}) {
  const subject = new TenantSyncService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as unknown as Internal
  const limits = { ...AUTH_REGISTRATION_FALLBACK_LIMITS, batchSize: 1, ...overrides }
  const requests: any[] = []
  subject.fetchGraphPage = async (url, _token, _label, options) => {
    assert.equal(url, 'https://graph.microsoft.com/v1.0/$batch')
    assert.ok(options.timeoutMs <= limits.requestTimeoutMs)
    assert.equal(options.deadlineAt, NOW.getTime() + limits.collectorDeadlineMs)
    const request = JSON.parse(options.init.body)
    assert.ok(request.requests.length <= limits.batchSize)
    requests.push(request)
    assert.ok(requests.length <= replies.length, 'unexpected extra request')
    const reply = replies[requests.length - 1]
    const value = typeof reply === 'function' ? reply() : reply
    return value instanceof Response ? value : new Response(JSON.stringify(value))
  }
  return { requests, run: (rows = [registration()]) => subject.enrichAuthenticationRegistrationsWithConditionalAccessContext('unused-mocked-token', rows, limits) }
}
function incomplete(row: Row, reason = 'INCOMPLETE_GRAPH_RESPONSE') {
  assert.deepEqual(row.conditionalAccessContext, { transitiveGroupIds: [], membershipComplete: false, observedAt: NOW.toISOString(), reasonCode: reason })
}
test.beforeEach(t => {
  assert.ok('mock' in t)
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unmocked network forbidden') })
})
for (const values of [[], [{ id: GROUP }], [{ id: 'z', optional: 7 }, { id: 'a' }, { id: 'z' }], [{ id: 'x'.repeat(128) }]]) {
  test(`valid terminal IDs remain complete: ${values.length} rows`, async () => {
    const f = fixture([{ responses: [good('1', { value: values })] }])
    const [row] = await f.run()
    assert.deepEqual(row.conditionalAccessContext, { transitiveGroupIds: [...new Set(values.map(v => v.id))].sort(), membershipComplete: true, observedAt: NOW.toISOString() })
    assert.equal(f.requests.length, 1)
  })
}
const invalidRows: unknown[] = [null, [], 4, {}, { id: null }, { id: 42 }, { id: false }, { id: '' }, { id: '   ' }, { id: ' x' }, { id: 'x ' }, { id: 'x'.repeat(129) }]
for (const [index, bad] of invalidRows.entries()) {
  test(`invalid membership row ${index} invalidates the whole user response`, async () => {
    for (const value of [[bad], [{ id: GROUP }, bad]]) incomplete((await fixture([{ responses: [good('1', { value })] }]).run())[0])
  })
}
for (const marker of [false, 0, null, [], {}, '', 'next-page']) {
  test(`present continuation ${JSON.stringify(marker)} is incomplete`, async () => incomplete((await fixture([{ responses: [good('1', { value: [], '@odata.nextLink': marker })] }]).run())[0]))
}
for (const body of [null, [], {}, { value: null }, { value: {} }]) {
  test(`invalid body ${JSON.stringify(body)} is incomplete`, async () => incomplete((await fixture([{ responses: [good('1', body)] }]).run())[0]))
}
for (const status of ['200', 201, 206, 429, 500, null, 401, 403]) {
  test(`status ${JSON.stringify(status)} is never coerced`, async () => incomplete((await fixture([{ responses: [good('1', { value: [] }, status)] }]).run())[0], status === 401 || status === 403 ? 'PERMISSION_LIMITED' : 'INCOMPLETE_GRAPH_RESPONSE'))
}
const badBatches = [[], [good(), good()], [good(), good('1', {}, 403)], [good('1', {}, 403), good()], [good(), good('extra')], [good('')], [good(' ')], [{ ...good(), id: 1 }], [null], [[]], [4]]
for (const [index, responses] of badBatches.entries()) {
  test(`ambiguous batch ${index} fails closed without last-write-wins`, async () => incomplete((await fixture([{ responses }]).run())[0]))
}
test('all expected responses plus an extra invalidates every requested user', async () => {
  const rows = await fixture([{ responses: [good('1'), good('2', {}, 403), good('extra')] }], { batchSize: 2 }).run([registration('a'), registration('b')])
  rows.forEach(row => incomplete(row))
})
test('reordered responses retain per-user qualification in a valid envelope', async () => {
  const rows = await fixture([{ responses: [good('2'), good('1', {}, 403)] }], { batchSize: 2 }).run([registration('a'), registration('b')])
  incomplete(rows[0], 'PERMISSION_LIMITED'); assert.equal(rows[1].conditionalAccessContext.membershipComplete, true)
})
test('missing response invalidates the batch, not just the absent user', async () => {
  const rows = await fixture([{ responses: [good('1')] }], { batchSize: 2 }).run([registration('a'), registration('b')])
  rows.forEach(row => incomplete(row))
})
test('malformed user value leaves a different user complete in a valid batch', async () => {
  const rows = await fixture([{ responses: [good('1', { value: [null] }), good('2')] }], { batchSize: 2 }).run([registration('a'), registration('b')])
  incomplete(rows[0]); assert.equal(rows[1].conditionalAccessContext.membershipComplete, true)
})
test('valid -> malformed -> valid batches preserve facts, input rows, and request limits', async () => {
  const input = [registration('a'), registration('b'), registration('c'), registration('b')], before = structuredClone(input)
  const f = fixture([{ responses: [good()] }, { responses: [good(), good()] }, { responses: [good()] }])
  const rows = await f.run(input)
  assert.equal(f.requests.length, 3); assert.equal(rows.length, 4)
  assert.equal(rows[0].conditionalAccessContext.membershipComplete, true); incomplete(rows[1]); incomplete(rows[3]); assert.equal(rows[2].conditionalAccessContext.membershipComplete, true)
  rows.forEach((row, i) => {
    const { conditionalAccessContext: _context, ...facts } = row
    const { conditionalAccessContext: _prior, ...expected } = before[i]
    assert.deepEqual(facts, expected)
  })
  assert.deepEqual(input, before)
})
for (const [label, fatal] of [['JSON', () => new Response('{')], ['shape', () => ({ responses: null })], ['transport', () => { throw new Error('synthetic transport failure') }]] as const) {
  test(`later fatal ${label} invalidates all contexts and stops requesting`, async () => {
    const f = fixture([{ responses: [good()] }, fatal, { responses: [good()] }])
    ;(await f.run([registration('a'), registration('b'), registration('c')])).forEach(row => incomplete(row, 'COLLECTION_FAILED'))
    assert.equal(f.requests.length, 2)
  })
}
test('deadline after a rejected batch retains global failure and forbids another request', async t => {
  const f = fixture([{ responses: [good()] }, () => { t.mock.timers.setTime(NOW.getTime() + 50); return { responses: [good(), good()] } }, { responses: [good()] }], { collectorDeadlineMs: 50 })
  ;(await f.run([registration('a'), registration('b'), registration('c')])).forEach(row => incomplete(row, 'COLLECTION_FAILED'))
  assert.equal(f.requests.length, 2)
})
test('raw response bytes and preflight user/batch bounds remain enforced', async () => {
  const f = fixture([{ responses: [good('1', { value: [], padding: 'x'.repeat(1000) })] }], { responseBytes: 100 })
  incomplete((await f.run())[0], 'COLLECTION_FAILED')
  for (const limits of [{ maxUsers: 1 }, { maxBatches: 1 }]) {
    const bounded = fixture([], limits)
    ;(await bounded.run([registration('a'), registration('b')])).forEach(row => incomplete(row, 'BOUNDED_LIMIT_EXCEEDED'))
    assert.equal(bounded.requests.length, 0)
  }
})
// Use real serialized bytes, including contexts from structurally rejected batches.
const contextBytes = (ids: string[], complete: boolean) => Buffer.byteLength(JSON.stringify({ transitiveGroupIds: ids, membershipComplete: complete, observedAt: NOW.toISOString(), ...(!complete ? { reasonCode: 'INCOMPLETE_GRAPH_RESPONSE' } : {}) }))
function idsForBytes(target: number) {
  const added = target - contextBytes([], true), count = Math.ceil((added + 1) / 131)
  let characters = added - 3 * count + 1 - 5 * count
  assert.ok(characters >= 0)
  const ids = Array.from({ length: count }, (_, i) => { const extra = Math.min(123, characters); characters -= extra; return String(i).padStart(5, '0') + 'x'.repeat(extra) })
  assert.equal(characters, 0); assert.equal(contextBytes(ids, true), target)
  return ids
}
test('a structurally rejected batch counts at the exact aggregate-byte boundary', async () => {
  const large = Array.from({ length: 1000 }, (_, i) => String(i).padStart(5, '0') + 'x'.repeat(123))
  const filler = idsForBytes(4 * 1024 * 1024 - 31 * contextBytes(large, true) - contextBytes([], false))
  const replies = [...Array.from({ length: 31 }, () => ({ responses: [good('1', { value: large.map(id => ({ id })) })] })), { responses: [good('1', { value: filler.map(id => ({ id })) })] }, { responses: [good(), good()] }, { responses: [good(), good()] }]
  const input = Array.from({ length: 34 }, (_, i) => registration(String(i).padStart(3, '0')))
  const exact = fixture(replies.slice(0, 33)), accepted = await exact.run(input.slice(0, 33))
  assert.equal(accepted[31].conditionalAccessContext.membershipComplete, true); incomplete(accepted[32]); assert.equal(exact.requests.length, 33)
  const overflow = fixture(replies)
  ;(await overflow.run(input)).forEach(row => incomplete(row, 'COLLECTION_FAILED'))
  assert.equal(overflow.requests.length, 34)
})

async function protection(row: Row, selectors: Record<string, unknown>) {
  const scope = { organizationId: ORG, customerTenantId: TENANT }
  const policy = { id: 'only-policy', displayName: 'Only policy', state: 'enabled', conditions: { users: selectors, applications: { includeApplications: ['All'] } }, grantControls: { operator: 'OR', builtInControls: ['mfa'] } }
  const payloads: Record<string, unknown[]> = { CONDITIONAL_ACCESS: [policy], AUTHENTICATION_STRENGTHS: [], AUTH_REGISTRATIONS: [row], DIRECTORY_ROLES: [{ principalId: GROUP, roleDefinition: { templateId: ROLE } }], SECURITY_DEFAULTS: [{ isEnabled: false }] }
  const read: Parameters<typeof createAssessmentProtectionLoader>[0] = async (_deadline, _max, work) => {
    const client = { query: async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith("SELECT set_config('statement_timeout'")) return { rows: [] }
      assert.equal(values[0], ORG); assert.equal(values[1], TENANT)
      if (sql.includes('protection:scope')) return { rows: [{ ...scope, microsoftTenantId: '10000000-0000-4000-8000-000000000006', organizationStatus: 'ACTIVE', tenantStatus: 'ACTIVE', connectionStatus: 'CONNECTED', usersSyncStatus: 'SUCCEEDED', usersLastSuccessfulAt: NOW, usersLastAttemptAt: NOW, usersUpdatedAt: NOW, usersGenerationValid: true }] }
      if (sql.includes('protection:users')) return { rows: [{ ...scope, microsoftUserId: USER, userType: 'Member', userGenerationValid: true, accountEnabled: true }] }
      if (sql.includes('protection:snapshot')) {
        const resourceType = String(values[2]), payload = payloads[resourceType]
        return { rows: [{ ...scope, resourceType, observedAt: NOW, syncStatus: 'SUCCEEDED', lastSuccessfulAt: NOW, lastAttemptAt: NOW, syncUpdatedAt: NOW, generationValid: true, shapeValid: true, capped: false, payloadBytes: Buffer.byteLength(JSON.stringify(payload)), payload }] }
      }
      throw new Error('unexpected query')
    } }
    return work(client as never, NOW.getTime() + 12000)
  }
  return (await createAssessmentProtectionLoader(read)(scope, [USER], NOW, NOW.getTime() + 15000)).get(USER)!
}
const consumerBad = [
  { responses: [good('1', { value: [{ id: 42 }] })] }, { responses: [good('1', { value: [{}] })] }, { responses: [good('1', { value: [null] })] },
  { responses: [good('1', { value: [], '@odata.nextLink': 42 })] }, { responses: [good('1', { value: [], '@odata.nextLink': {} })] },
  { responses: [good(), good('1', {}, 403)] }, { responses: [good('1', {}, 403), good()] },
]
for (const [index, reply] of consumerBad.entries()) {
  for (const selectors of [{ includeUsers: ['All'], excludeGroups: [GROUP] }, { includeGroups: [GROUP] }, { includeUsers: ['All'], excludeRoles: [ROLE] }]) {
    test(`actual producer->public loader ${index} cannot infer missing group/role exclusions`, async () => {
      const [row] = await fixture([reply]).run(), result = await protection(row, selectors)
      assert.equal(result.conditionalAccess.status, 'UNKNOWN'); assert.equal(result.registration.state, 'REGISTERED')
      assert.equal('riskReductionAllowed' in result.conditionalAccess, false); assert.match(result.explanation, /does not reduce finding priority/)
    })
  }
}
test('public loader distinguishes true empty, matching group, and opaque producer IDs', async () => {
  for (const selectors of [{ includeUsers: ['All'], excludeGroups: [GROUP] }, { includeUsers: ['All'], excludeRoles: [ROLE] }]) {
    const [empty] = await fixture([{ responses: [good()] }]).run()
    assert.equal((await protection(empty, selectors)).conditionalAccess.status, 'COVERED_BY_CONDITIONAL_ACCESS')
    const [matched] = await fixture([{ responses: [good('1', { value: [{ id: GROUP }] })] }]).run()
    const excluded = (await protection(matched, selectors)).conditionalAccess
    assert.equal(excluded.status, 'NOT_COVERED')
    assert.ok(excluded.reasonCodes.includes('EFFECTIVE_EXCLUSION'))
  }
  for (const id of ['x', 'x'.repeat(128)]) {
    const [opaque] = await fixture([{ responses: [good('1', { value: [{ id }] })] }]).run()
    assert.equal(opaque.conditionalAccessContext.membershipComplete, true)
    assert.equal((await protection(opaque, { includeGroups: [GROUP] })).conditionalAccess.status, 'UNKNOWN')
  }
})
test('optional membership failure does not suppress independent user policy or registration facts', async () => {
  const [row] = await fixture([{ responses: [good('1', { value: [null] })] }]).run(), result = await protection(row, { includeUsers: ['All'] })
  assert.equal(result.conditionalAccess.status, 'COVERED_BY_CONDITIONAL_ACCESS'); assert.equal(result.registration.state, 'REGISTERED')
})
