import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Reflector } from '@nestjs/core'
import type { ExecutionContext } from '@nestjs/common'
import {
  DIRECTORY_ROLE_CURRENT_MS,
  DIRECTORY_ROLE_RESPONSE_VERSION,
  DIRECTORY_ROLE_SOURCE,
  type DirectoryRoleResults,
} from './directory-role-reader.js'
import {
  DIRECTORY_ROLE_EXPORT_FILENAME,
  DIRECTORY_ROLE_EXPORT_MAX_BYTES,
  DIRECTORY_ROLE_EXPORT_MAX_ROWS,
  DIRECTORY_ROLE_EXPORT_QUALIFICATION,
  DIRECTORY_ROLE_EXPORT_UNAVAILABLE,
  DIRECTORY_ROLE_EXPORT_VERSION,
  assertNoExportInputs,
  buildDirectoryRoleExport,
} from './directory-role-export.js'
import { TenantsController } from './tenants.controller.js'
import { IdentityAuthGuard } from '../auth/identity-auth.guard.js'
import type { AuthenticatedIdentity, AuthenticatedRequest } from '../auth/auth.types.js'

const TENANT = '11111111-2222-4333-8444-555555555555'
const CHECKED_AT = '2026-10-09T11:00:00.000Z'
const GENERATED_AT = new Date('2026-10-09T12:34:56.000Z')

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    principalId: randomUUID(),
    roleDefinitionId: randomUUID(),
    roleDisplayName: 'Global Reader',
    directoryScopeId: '/',
    appScopeId: null,
    ...overrides,
  } as never
}

/** A coherent admitted projection, as the existing reader would return it. */
function results(overrides: Partial<DirectoryRoleResults> = {}, observation: Record<string, unknown> = {}) {
  const assignments = (observation.assignments as never[]) ?? [assignment()]
  const base: DirectoryRoleResults = {
    responseVersion: DIRECTORY_ROLE_RESPONSE_VERSION,
    source: DIRECTORY_ROLE_SOURCE,
    status: 'current',
    latestAttempt: { outcome: null, terminalAt: null },
    health: { version: 1, reasonCode: 'COMPLETE_OBSERVATION_CURRENT', recoveryCode: 'NONE' } as never,
    observation: {
      checkedAt: CHECKED_AT,
      ageMs: 1000,
      observedCount: assignments.length,
      assignments,
      verifiedCompleteEmpty: assignments.length === 0,
      ...observation,
    },
    ...overrides,
  } as DirectoryRoleResults
  return base
}

const build = (input: Partial<Parameters<typeof buildDirectoryRoleExport>[0]> = {}) =>
  buildDirectoryRoleExport({
    results: input.results ?? results(),
    customerTenantId: input.customerTenantId ?? TENANT,
    generatedAt: input.generatedAt ?? GENERATED_AT,
  })

// ---------------------------------------------------------------- pure exporter

test('an admitted current projection exports verbatim, qualified, with its own generation clock', () => {
  const source = results()
  const outcome = build({ results: source })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.filename, 'hawkview-directory-roles.json')
  assert.deepEqual(outcome.envelope, {
    exportVersion: 'directory-role-export/v1',
    qualification: 'derived-stored-directory-snapshot',
    customerTenantId: TENANT,
    generatedAt: '2026-10-09T12:34:56.000Z',
    results: source,
  })
  // The whole admitted projection, unmodified — not a copy with fields dropped.
  assert.deepEqual(outcome.envelope.results, source)
  assert.equal(outcome.envelope.results.observation?.assignments.length, 1)
  // Generation time is not the completion time, and the export never restates
  // one as the other.
  assert.notEqual(outcome.envelope.generatedAt, outcome.envelope.results.observation?.checkedAt)
  assert.equal(outcome.envelope.results.observation?.checkedAt, CHECKED_AT)
  // The measured length is the length of exactly what will be serialised.
  assert.equal(outcome.bytes, Buffer.byteLength(JSON.stringify(outcome.envelope), 'utf8'))
})

test('a stale projection is exportable and keeps the reader’s own qualification', () => {
  const stale = results({ status: 'stale' }, { ageMs: DIRECTORY_ROLE_CURRENT_MS + 1 })
  const outcome = build({ results: stale })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  // Carried through, never re-derived from the generation clock.
  assert.equal(outcome.envelope.results.status, 'stale')
  assert.equal(outcome.envelope.results.observation?.ageMs, DIRECTORY_ROLE_CURRENT_MS + 1)
})

test('a verified-complete-empty observation is a successful export, not a failure', () => {
  const empty = results({}, { assignments: [], observedCount: 0, verifiedCompleteEmpty: true })
  const outcome = build({ results: empty })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.envelope.results.observation?.observedCount, 0)
  assert.equal(outcome.envelope.results.observation?.verifiedCompleteEmpty, true)
  assert.deepEqual(outcome.envelope.results.observation?.assignments, [])
})

test('every non-admitted status refuses, with a finite code and nothing downloadable', () => {
  for (const status of ['not-activated', 'never-collected', 'superseded'] as const) {
    const outcome = build({ results: results({ status, observation: null }) })
    assert.equal(outcome.ok, false, status)
    if (outcome.ok) continue
    assert.equal(outcome.code, DIRECTORY_ROLE_EXPORT_UNAVAILABLE)
    assert.equal(outcome.refusal, 'NOT_ADMITTED')
    // There is no envelope and no filename to turn into a file.
    assert.equal('envelope' in outcome, false, status)
    assert.equal('filename' in outcome, false, status)
  }
  // An admitted status with no observation is still not exportable.
  for (const status of ['current', 'stale'] as const) {
    const outcome = build({ results: results({ status, observation: null }) })
    assert.equal(outcome.ok, false, status)
    if (!outcome.ok) assert.equal(outcome.refusal, 'NOT_ADMITTED', status)
  }
})

test('a non-admitted status is refused even when an observation is retained beside it', () => {
  // This is the case that actually pins the status gate. Every refusal above
  // also has a null observation, so the second gate alone would satisfy them —
  // removing the status check left the whole suite green until this existed.
  // The reader already keeps a completed observation beside an outstanding
  // attempt, so a retained observation under an untrustworthy status is the
  // shape the gate exists to refuse.
  for (const status of ['not-activated', 'never-collected', 'superseded'] as const) {
    const retained = results({ status })
    assert.notEqual(retained.observation, null, 'the fixture must carry a coherent observation')
    const outcome = build({ results: retained })
    assert.equal(outcome.ok, false, status)
    if (!outcome.ok) {
      assert.equal(outcome.code, DIRECTORY_ROLE_EXPORT_UNAVAILABLE, status)
      assert.equal(outcome.refusal, 'NOT_ADMITTED', status)
    }
  }
})

test('a self-contradictory admitted result is refused rather than exported in part', () => {
  const cases: [string, DirectoryRoleResults][] = [
    ['count disagrees with rows', results({}, { observedCount: 7 })],
    ['empty flag contradicts rows', results({}, { verifiedCompleteEmpty: true })],
    ['empty rows without the flag', results({}, { assignments: [], observedCount: 0, verifiedCompleteEmpty: false })],
    ['unreadable completion time', results({}, { checkedAt: 'not-a-date' })],
    ['blank completion time', results({}, { checkedAt: '' })],
    ['negative age', results({}, { ageMs: -1 })],
    ['fractional age', results({}, { ageMs: 1.5 })],
    ['current but older than the freshness rule', results({}, { ageMs: DIRECTORY_ROLE_CURRENT_MS + 1 })],
    ['stale but within the freshness rule', results({ status: 'stale' }, { ageMs: 1000 })],
    ['foreign response version', results({ responseVersion: 'directory-role-results/v2' as never })],
    ['foreign source', results({ source: 'somewhere else' as never })],
    ['row with no id', results({}, { assignments: [assignment({ id: '' })] })],
    ['row with a numeric id', results({}, { assignments: [assignment({ id: 7 })] })],
    ['row with a numeric nullable field', results({}, { assignments: [assignment({ roleDisplayName: 7 })] })],
    ['row that is not an object', results({}, { assignments: [null as never] })],
    ['missing latest attempt', results({ latestAttempt: null as never })],
    ['numeric terminal time', results({ latestAttempt: { outcome: null, terminalAt: 7 } as never })],
  ]
  for (const [label, candidate] of cases) {
    const outcome = build({ results: candidate })
    assert.equal(outcome.ok, false, label)
    if (!outcome.ok) assert.equal(outcome.refusal, 'RESULT_INCOHERENT', label)
  }
})

test('the row ceiling is exact, and an overflow refuses instead of dropping rows', () => {
  const rows = (count: number) => Array.from({ length: count }, () => assignment({
    principalId: null, roleDefinitionId: null, roleDisplayName: null, directoryScopeId: null,
  }))
  const atLimit = rows(DIRECTORY_ROLE_EXPORT_MAX_ROWS)
  const ok = build({ results: results({}, { assignments: atLimit, observedCount: atLimit.length }) })
  assert.equal(ok.ok, true, '1000 rows is permitted')
  if (ok.ok) assert.equal(ok.envelope.results.observation?.assignments.length, 1000)

  const over = rows(DIRECTORY_ROLE_EXPORT_MAX_ROWS + 1)
  const refused = build({ results: results({}, { assignments: over, observedCount: over.length }) })
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.refusal, 'ROW_LIMIT_EXCEEDED')
})

test('the byte ceiling is exact to the byte, measured on the serialised envelope', () => {
  // Measure with an empty display name, then pad by exactly the remaining
  // budget: one ASCII character is one byte in the serialised JSON.
  const probe = build({ results: results({}, { assignments: [assignment({ roleDisplayName: '' })] }) })
  assert.equal(probe.ok, true)
  if (!probe.ok) return
  const room = DIRECTORY_ROLE_EXPORT_MAX_BYTES - probe.bytes

  const exact = build({ results: results({}, { assignments: [assignment({ roleDisplayName: 'x'.repeat(room) })] }) })
  assert.equal(exact.ok, true, 'exactly at the ceiling is permitted')
  if (exact.ok) assert.equal(exact.bytes, DIRECTORY_ROLE_EXPORT_MAX_BYTES)

  const over = build({ results: results({}, { assignments: [assignment({ roleDisplayName: 'x'.repeat(room + 1) })] }) })
  assert.equal(over.ok, false, 'one byte over refuses')
  if (!over.ok) assert.equal(over.refusal, 'BYTE_LIMIT_EXCEEDED')
})

test('a multi-byte character counts as its UTF-8 length, not as one character', () => {
  const probe = build({ results: results({}, { assignments: [assignment({ roleDisplayName: '' })] }) })
  assert.equal(probe.ok, true)
  if (!probe.ok) return
  const room = DIRECTORY_ROLE_EXPORT_MAX_BYTES - probe.bytes
  // '€' is three UTF-8 bytes. Filling the budget by character count would pass.
  const name = '€'.repeat(Math.floor(room / 3) + 1)
  const over = build({ results: results({}, { assignments: [assignment({ roleDisplayName: name })] }) })
  assert.equal(over.ok, false)
  if (!over.ok) assert.equal(over.refusal, 'BYTE_LIMIT_EXCEEDED')
})

test('an unusable generation clock or tenant reference refuses rather than inventing one', () => {
  // Called directly, not through `build`: that helper defaults a nullish clock,
  // which would quietly substitute a valid one and make this test vacuous.
  for (const clock of [new Date(Number.NaN), undefined, '2026-10-09', null, 0]) {
    const outcome = buildDirectoryRoleExport({
      results: results(), customerTenantId: TENANT, generatedAt: clock as never,
    })
    assert.equal(outcome.ok, false, String(clock))
    if (!outcome.ok) assert.equal(outcome.refusal, 'GENERATION_TIME_UNUSABLE', String(clock))
  }
  for (const id of ['', 'not-a-uuid', '../../etc/passwd', `${TENANT} `, 7, undefined, null]) {
    const outcome = buildDirectoryRoleExport({
      results: results(), customerTenantId: id as never, generatedAt: GENERATED_AT,
    })
    assert.equal(outcome.ok, false, String(id))
    if (!outcome.ok) assert.equal(outcome.refusal, 'TENANT_REFERENCE_UNUSABLE', String(id))
  }
})

test('the export claims no authenticity and no provider original, and names what it is', () => {
  const outcome = build()
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  const serialised = JSON.stringify(outcome.envelope)
  assert.match(serialised, /derived-stored-directory-snapshot/)
  // No checksum, signature or stored-digest equivalence claim anywhere.
  for (const forbidden of ['checksum', 'signature', 'signed', 'contentDigest', 'digest', 'authentic', 'verifiedBy']) {
    assert.doesNotMatch(Object.keys(flatten(outcome.envelope)).join(' '), new RegExp(forbidden, 'i'), forbidden)
  }
})

function flatten(value: unknown, prefix = '', into: Record<string, true> = {}): Record<string, true> {
  if (!value || typeof value !== 'object') return into
  for (const [key, child] of Object.entries(value)) {
    into[`${prefix}${key}`] = true
    flatten(child, `${prefix}${key}.`, into)
  }
  return into
}

test('the attachment filename is a constant and carries no caller text', () => {
  const outcome = build({ customerTenantId: TENANT })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.filename, DIRECTORY_ROLE_EXPORT_FILENAME)
  // Nothing a caller controls can reach a header or a saved file's name.
  assert.doesNotMatch(outcome.filename, /[";\r\n\\/]/)
  assert.doesNotMatch(outcome.filename, new RegExp(TENANT))
})

test('body or query input on the export is refused rather than ignored', () => {
  assert.doesNotThrow(() => assertNoExportInputs(undefined, {}))
  assert.doesNotThrow(() => assertNoExportInputs(null, undefined))
  for (const body of [{ customerTenantId: TENANT }, { subject: randomUUID() }, [], 'export', 0]) {
    assert.throws(() => assertNoExportInputs(body, {}), /do not accept|does not accept/)
  }
  for (const query of [{ tenant: TENANT }, { identity: randomUUID() }, { window: '7d' }]) {
    assert.throws(() => assertNoExportInputs(undefined, query), /does not accept/)
  }
})

// ------------------------------------------------------------------ controller

const identity: AuthenticatedIdentity = {
  subject: randomUUID(), sessionId: randomUUID(), email: 'synthetic@example.invalid',
  assuranceLevel: 'aal2', authenticatedAt: new Date(GENERATED_AT),
} as AuthenticatedIdentity

function controllerFixture(answer: () => unknown) {
  const order: string[] = []
  const seen: { identity: unknown; tenantId: unknown }[] = []
  const service = {
    getDirectoryRoleResultsForIdentity: async (caller: unknown, tenantId: unknown) => {
      order.push('authorized-service')
      seen.push({ identity: caller, tenantId })
      return answer()
    },
  }
  // Any provider or notification call would be a defect: this export reads
  // nothing live. A proxy makes that observable instead of assumed.
  const noRemote = new Proxy({}, { get: () => () => { throw new Error('unexpected provider call') } })
  const controller = new TenantsController(service as never, noRemote as never)
  const headers: Record<string, string> = {}
  const response = { setHeader: (key: string, value: string) => { order.push(`header:${key}`); headers[key] = value } }
  return { controller, order, seen, headers, response, service }
}

test('the controller authorizes through the existing service before anything is generated', async () => {
  const f = controllerFixture(() => results())
  const envelope = await f.controller.exportDirectoryRoles(
    { auth: identity, query: {} } as AuthenticatedRequest, TENANT, f.response as never
  )
  assert.equal(f.seen.length, 1, 'authorized exactly once')
  assert.deepEqual(f.seen[0], { identity, tenantId: TENANT })
  // Authorization strictly precedes every header and the generated payload.
  assert.equal(f.order[0], 'authorized-service')
  assert.deepEqual(f.headers, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="hawkview-directory-roles.json"',
  })
  assert.equal(envelope.qualification, DIRECTORY_ROLE_EXPORT_QUALIFICATION)
  assert.equal(envelope.exportVersion, DIRECTORY_ROLE_EXPORT_VERSION)
  assert.equal(envelope.customerTenantId, TENANT)
})

test('the export route uses exactly the results route’s tenant entitlement', async () => {
  // Not a restatement of the service's own authorization — that is existing
  // reviewed code — but proof that this route goes through the same door with
  // the same arguments rather than a parallel one.
  const f = controllerFixture(() => results())
  await f.controller.exportDirectoryRoles({ auth: identity, query: {} } as AuthenticatedRequest, TENANT, f.response as never)
  await f.controller.getDirectoryRoleResults({ auth: identity } as AuthenticatedRequest, TENANT, f.response as never)
  assert.equal(f.seen.length, 2)
  assert.deepEqual(f.seen[0], f.seen[1])
})

test('a tenant the caller cannot read is denied with no payload and no attachment', async () => {
  const denial = new Error('Customer tenant was not found.')
  const f = controllerFixture(() => { throw denial })
  await assert.rejects(
    f.controller.exportDirectoryRoles({ auth: identity, query: {} } as AuthenticatedRequest, TENANT, f.response as never),
    /Customer tenant was not found/
  )
  // The nondisclosing denial reaches the caller unchanged, and nothing about a
  // file was ever set up.
  assert.deepEqual(f.headers, {})
})

test('a non-admitted result is a 409 refusal with a finite code and no attachment headers', async () => {
  const f = controllerFixture(() => results({ status: 'superseded', observation: null }))
  const error: any = await f.controller
    .exportDirectoryRoles({ auth: identity, query: {} } as AuthenticatedRequest, TENANT, f.response as never)
    .then(() => null, (thrown: unknown) => thrown)
  assert.ok(error, 'the refusal is thrown, not returned as a file')
  assert.equal(error.getStatus(), 409)
  assert.deepEqual(error.getResponse(), {
    statusCode: 409, code: 'DIRECTORY_ROLE_EXPORT_UNAVAILABLE', refusal: 'NOT_ADMITTED',
  })
  assert.deepEqual(f.headers, {}, 'no attachment is announced for a refusal')
})

test('caller input is refused before the service is consulted', async () => {
  for (const [body, query] of [[{ subject: randomUUID() }, {}], [undefined, { tenant: TENANT }]] as const) {
    const f = controllerFixture(() => results())
    await assert.rejects(
      f.controller.exportDirectoryRoles(
        { auth: identity, body, query } as AuthenticatedRequest, TENANT, f.response as never
      ),
      /does not accept/
    )
    assert.equal(f.seen.length, 0, 'authorization is never even attempted')
    assert.deepEqual(f.headers, {})
  }
})

test('the actual guard denies the export handler before any authorization or payload', async () => {
  const f = controllerFixture(() => results())
  let current: AuthenticatedIdentity = identity
  let tokenRejected = false
  let sessionDenied = false
  const sessions = {
    check: async () => {
      if (sessionDenied) throw new Error('A fresh console sign-in is required.')
      return { idleExpiresAt: GENERATED_AT.toISOString() }
    },
  }
  const guard = new IdentityAuthGuard(
    new Reflector(),
    { verify: async () => { if (tokenRejected) throw new Error('synthetic token rejected'); return current } } as never,
    sessions as never
  )
  const invoke = async (headers: Record<string, string> = { authorization: 'Bearer synthetic' }) => {
    const request = { headers, query: {} } as unknown as AuthenticatedRequest
    const context = {
      getHandler: () => TenantsController.prototype.exportDirectoryRoles,
      getClass: () => TenantsController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext
    assert.equal(await guard.canActivate(context), true)
    return TenantsController.prototype.exportDirectoryRoles.call(f.controller, request, TENANT, f.response as never)
  }

  await assert.rejects(invoke({}), /bearer token is required/)
  assert.equal(f.seen.length, 0)

  tokenRejected = true
  await assert.rejects(invoke(), /synthetic token rejected/)
  assert.equal(f.seen.length, 0)
  tokenRejected = false

  current = { ...identity, assuranceLevel: 'aal1' }
  await assert.rejects(invoke(), /Multi-factor/)
  assert.equal(f.seen.length, 0)
  current = identity

  sessionDenied = true
  await assert.rejects(invoke(), /fresh console sign-in/)
  assert.equal(f.seen.length, 0, 'a denied console session never reaches the tenant read')
  sessionDenied = false

  // Admitted: only now does the authorized read happen.
  const envelope = await invoke()
  assert.equal(f.seen.length, 1)
  assert.equal(envelope.customerTenantId, TENANT)
})
