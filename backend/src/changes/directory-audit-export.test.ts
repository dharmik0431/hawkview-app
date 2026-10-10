import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  DIRECTORY_AUDIT_EXPORT_CANDIDATE_CAP,
  DIRECTORY_AUDIT_EXPORT_QUALIFICATION,
  DIRECTORY_AUDIT_EXPORT_READ_BUDGET_BYTES,
  DIRECTORY_AUDIT_EXPORT_TOO_LARGE,
  DIRECTORY_AUDIT_EXPORT_VERSION,
  EXPORTED_DIRECTORY_FIELDS,
  DIRECTORY_AUDIT_EXPORT_REDACTED,
  OMITTED_TOP_LEVEL_DIRECTORY_FIELDS,
  UNBOUNDED_WINDOW,
  assertNoExportExtras,
  exportRequestSuppliedBody,
  redactSensitiveDetailPairs,
  sensitiveNameRuleAgrees,
  buildDirectoryAuditExportEnvelope,
  directoryAuditExportFilename,
  envelopeByteLength,
  parseExportTenantId,
  parseExportWindow,
  singleExportValue,
} from './directory-audit-export.js'
import { classifyEvidence, PRIMARY_CHANGE_CLASSIFICATIONS } from './change-classification.js'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { request as httpRequest } from 'node:http'
import { ChangesController } from './changes.controller.js'
import { ChangesService } from './changes.service.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'

const ORG_A = '11111111-2222-4333-8444-555555555555'
const ORG_B = '99999999-8888-4777-8666-555555555555'
const TENANT_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const TENANT_B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

// --------------------------------------------------------------- pure contract

test('the tenant identifier is required, a single value, and a real UUID', () => {
  assert.equal(parseExportTenantId(TENANT_A.toUpperCase()), TENANT_A)
  for (const bad of [undefined, null]) {
    assert.throws(() => parseExportTenantId(bad), /Select a tenant/)
  }
  for (const bad of ['', '   ']) {
    assert.throws(() => parseExportTenantId(bad), /with a value, or omit it/)
  }
  for (const bad of ['not-a-uuid', '../../etc/passwd', '0'.repeat(36)]) {
    assert.throws(() => parseExportTenantId(bad), /valid tenant/, String(bad))
  }
  // A non-string is refused one guard earlier, by the single-value check.
  for (const bad of [7, true, { tenantId: TENANT_A }]) {
    assert.throws(() => parseExportTenantId(bad), /as a single value/, String(bad))
  }
  assert.throws(() => parseExportTenantId([TENANT_A, TENANT_B]), /at most once/)
})

test('only 0 to 3 fractional digits are accepted, and 4 or more is refused rather than rounded', () => {
  assert.deepEqual(parseExportWindow('2026-03-01T00:00:00Z', undefined), {
    since: '2026-03-01T00:00:00.000Z', until: null,
  })
  assert.deepEqual(parseExportWindow('2026-03-01T00:00:00.5Z', undefined).since, '2026-03-01T00:00:00.500Z')
  assert.deepEqual(parseExportWindow('2026-03-01T00:00:00.123Z', undefined).since, '2026-03-01T00:00:00.123Z')
  // Four or more digits must not be silently truncated to .123 — which is what
  // would shift a half-open bound against microsecond-stored event times.
  for (const over of [
    '2026-03-01T00:00:00.1234Z',
    '2026-03-01T00:00:00.123456Z',
    '2026-03-01T00:00:00.1234567Z',
    '2026-03-01T00:00:00.123456+01:00',
  ]) {
    assert.throws(() => parseExportWindow(over, undefined), /at most three fractional-second digits/, over)
    assert.throws(() => parseExportWindow(undefined, over), /at most three fractional-second digits/, over)
  }
})

test('date-only and offsetless instants stay invalid, and an offset is canonicalized', () => {
  for (const bad of ['2026-03-01', '2026-03-01T00:00:00', '2026-03-01 00:00:00Z', 'whenever', 'null']) {
    assert.throws(() => parseExportWindow(bad, undefined), /UTC designator or offset|ISO 8601/, bad)
  }
  assert.equal(parseExportWindow('2026-03-01T01:00:00+01:00', undefined).since, '2026-03-01T00:00:00.000Z')
  assert.equal(parseExportWindow('2026-03-01T00:00:00-05:00', undefined).since, '2026-03-01T05:00:00.000Z')
})

test('an impossible calendar day is refused instead of rolling into the next month', () => {
  for (const bad of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-06-31T00:00:00Z', '2026-11-31T00:00:00Z']) {
    assert.ok(Number.isFinite(Date.parse(bad)), `${bad} must parse, or this case proves nothing`)
    assert.throws(() => parseExportWindow(bad, undefined), /real calendar date/, bad)
  }
  assert.equal(parseExportWindow('2024-02-29T00:00:00Z', undefined).since, '2024-02-29T00:00:00.000Z')
})

test('the window is half-open, and blank or reversed input is refused', () => {
  assert.deepEqual(parseExportWindow(undefined, null), UNBOUNDED_WINDOW)
  for (const blank of ['', '  ']) {
    assert.throws(() => parseExportWindow(blank, undefined), /with a value, or omit it/)
    assert.throws(() => parseExportWindow(undefined, blank), /with a value, or omit it/)
  }
  assert.throws(() => parseExportWindow('2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z'), /start is before its end/)
  assert.throws(() => parseExportWindow('2026-04-01T00:00:00Z', '2026-03-01T00:00:00Z'), /start is before its end/)
  assert.throws(() => parseExportWindow(['a', 'b'], undefined), /since at most once/)
  assert.equal(singleExportValue('tenantId', undefined), undefined)
})

test('the filename carries exact instants, so two windows inside one day cannot collide', () => {
  const morning = directoryAuditExportFilename(TENANT_A, {
    since: '2026-03-01T00:00:00.000Z', until: '2026-03-01T12:00:00.000Z',
  })
  const afternoon = directoryAuditExportFilename(TENANT_A, {
    since: '2026-03-01T12:00:00.000Z', until: '2026-03-02T00:00:00.000Z',
  })
  assert.notEqual(morning, afternoon)
  assert.match(morning, /2026-03-01T00-00-00\.000Z_to_2026-03-01T12-00-00\.000Z\.json$/)
  assert.match(directoryAuditExportFilename(TENANT_A, UNBOUNDED_WINDOW), /_earliest_to_latest\.json$/)
  for (const name of [morning, afternoon]) {
    assert.doesNotMatch(name, /[:"*?<>|\\/\r\n]/, name)
    assert.match(name, new RegExp(TENANT_A))
  }
})

test('the envelope declares what it is, and what it leaves out', () => {
  const envelope = buildDirectoryAuditExportEnvelope({
    customerTenantId: TENANT_A,
    generatedAt: new Date('2026-10-10T20:00:00.000Z'),
    window: UNBOUNDED_WINDOW,
    candidates: 3,
    records: [{ id: 'a' }, { id: 'b' }],
    excludedByClassification: 1,
  })
  assert.equal(envelope.exportVersion, DIRECTORY_AUDIT_EXPORT_VERSION)
  assert.equal(envelope.qualification, DIRECTORY_AUDIT_EXPORT_QUALIFICATION)
  assert.equal(envelope.candidates, 3)
  assert.equal(envelope.returned, 2)
  assert.equal(envelope.eligible, 2)
  assert.equal(envelope.excludedByClassification, 1)
  assert.equal(envelope.candidateCap, DIRECTORY_AUDIT_EXPORT_CANDIDATE_CAP)
  // The counts cover the COMPLETE candidate set, so they add up.
  assert.equal(envelope.returned + envelope.excludedByClassification, envelope.candidates)
  // Fidelity, stated rather than implied.
  assert.match(envelope.fidelity.storedRepresentation, /not original wire bytes/)
  assert.match(envelope.fidelity.storedRepresentation, /not the complete stored row/)
  assert.match(envelope.fidelity.availability, /from ingestion rather than from when the event occurred/)
  assert.match(envelope.fidelity.coverage, /not a claim that every retained Microsoft event is included/)
  // The two redaction timings are stated separately, because they differ: only
  // the parsed `raw` copy was redacted at write.
  assert.match(envelope.fidelity.redactionAtWrite, /Only the parsed "raw" copy/)
  assert.match(envelope.fidelity.redactionAtWrite, /stored as they were received/)
  assert.match(envelope.fidelity.redactionOnRead, /does not alter or correct what remains stored/)
  // The omission is scoped to the column, and says so.
  assert.deepEqual(envelope.fidelity.omittedTopLevelFields, OMITTED_TOP_LEVEL_DIRECTORY_FIELDS)
  assert.ok(envelope.fidelity.omittedTopLevelFields.includes('resultReason'))
  assert.equal(envelope.fidelity.includedFields.includes('resultReason'), false)
  assert.match(envelope.fidelity.omissionScope, /Only the top-level "resultReason" column is omitted/)
  assert.match(envelope.fidelity.omissionScope, /may still be present inside the exported "raw" copy/)
  assert.equal(envelopeByteLength(envelope), Buffer.byteLength(JSON.stringify(envelope), 'utf8'))
})

test('a request body or an unexpected parameter is refused rather than ignored', () => {
  const noBody = { headers: {}, body: undefined }
  assert.doesNotThrow(() => assertNoExportExtras(noBody, { tenantId: TENANT_A, since: 'x', until: 'y' }))
  assert.doesNotThrow(() => assertNoExportExtras(noBody, {}))
  assert.throws(() => assertNoExportExtras(noBody, { organizationId: ORG_B }), /does not accept organizationId/)
  assert.throws(() => assertNoExportExtras(noBody, { cursor: 'x' }), /does not accept cursor/)
})

test('an explicitly supplied empty JSON body is a body, and nothing sent is not', async () => {
  // A parsed value cannot tell these apart: both can arrive as `{}`. The
  // framing can.
  assert.equal(exportRequestSuppliedBody({ headers: {}, body: undefined }), false)
  assert.equal(exportRequestSuppliedBody({ headers: {}, body: {} }), false)
  assert.equal(exportRequestSuppliedBody({ headers: { 'content-length': '0' } }), false)
  // `{}` is two bytes on the wire.
  assert.equal(exportRequestSuppliedBody({
    headers: { 'content-length': '2', 'content-type': 'application/json' }, body: {},
  }), true)
  assert.equal(exportRequestSuppliedBody({ headers: { 'transfer-encoding': 'chunked' }, body: {} }), true)
  // A parser that consumed the framing still cannot hide a non-empty body.
  assert.equal(exportRequestSuppliedBody({ headers: {}, body: { tenantId: TENANT_B } }), true)
  assert.throws(
    () => assertNoExportExtras({ headers: { 'content-length': '2' }, body: {} }, { tenantId: TENANT_A }),
    /does not accept a request body/)
  assert.throws(
    () => assertNoExportExtras({ headers: {}, body: { tenantId: TENANT_B } }, {}),
    /does not accept a request body/)
})

test('a sensitive-named detail pair is redacted where property-name redaction cannot see it', async () => {
  // The exact shape the reviewer demonstrated: the property names here are
  // `key` and `value`, so the storage-time rule walks straight past it.
  const detail = [{ key: 'Authorization', value: 'Bearer leaked-token-value' }]
  assert.deepEqual(redactSensitiveDetailPairs(detail), [{ key: 'Authorization', value: DIRECTORY_AUDIT_EXPORT_REDACTED }])

  // Nested inside the parsed raw copy, and in modified-property form.
  const nested = {
    activity: 'kept',
    additionalDetails: [
      { key: 'Client-Secret', value: 'nested-secret-value' },
      { key: 'Correlation', value: 'kept-correlation' },
    ],
    targetResources: [{
      type: 'User',
      modifiedProperties: [
        { displayName: 'Included Updated Properties', oldValue: 'kept-old', newValue: 'kept-new' },
        { displayName: 'Refresh Token Valid From', oldValue: 'secret-old', newValue: 'secret-new' },
      ],
    }],
  }
  const safe = JSON.stringify(redactSensitiveDetailPairs(nested))
  for (const leak of ['nested-secret-value', 'secret-old', 'secret-new']) {
    assert.doesNotMatch(safe, new RegExp(leak), leak)
  }
  // Non-sensitive data is preserved, not collaterally destroyed.
  for (const kept of ['kept', 'kept-correlation', 'kept-old', 'kept-new', 'Included Updated Properties']) {
    assert.match(safe, new RegExp(kept), kept)
  }
  // A pair whose name is not sensitive keeps its value even when a sibling is.
  assert.deepEqual(
    redactSensitiveDetailPairs([{ key: 'Note', value: 'keep-me' }]),
    [{ key: 'Note', value: 'keep-me' }])
  // Scalars, arrays and null pass through unchanged.
  assert.deepEqual(redactSensitiveDetailPairs(null), null)
  assert.deepEqual(redactSensitiveDetailPairs(['a', 1, null]), ['a', 1, null])
})

test('the export safeguard uses the same sensitive-name rule as storage', async () => {
  // Pinned so the two cannot silently diverge: the safeguard is a read-time
  // application of the existing rule to a shape it cannot see, not a new policy.
  for (const name of [
    'password', 'clientSecret', 'refresh_token', 'Authorization', 'credential',
    'private-key', 'assertion', 'certificate',
  ]) {
    assert.ok(sensitiveNameRuleAgrees(name), name)
    assert.deepEqual(
      redactSensitiveDetailPairs([{ key: name, value: 'x' }]),
      [{ key: name, value: DIRECTORY_AUDIT_EXPORT_REDACTED }], name)
  }
  for (const name of ['Note', 'Correlation', 'activityDisplayName', 'resultReason']) {
    assert.equal(sensitiveNameRuleAgrees(name), false, name)
  }
})

test('the static export route is declared before the parameter route that would capture it', () => {
  // Nest matches in declaration order, so `:id` would otherwise swallow `export`.
  const order = Object.getOwnPropertyNames(ChangesController.prototype)
  assert.ok(order.includes('exportDirectoryAudit'))
  assert.ok(order.indexOf('exportDirectoryAudit') < order.indexOf('detail'),
    'the export handler must be declared before the :id handler')
  assert.equal(Reflect.getMetadata('path', ChangesController.prototype.exportDirectoryAudit), 'export')
  assert.equal(Reflect.getMetadata('path', ChangesController.prototype.detail), ':id')
})

// ------------------------------------------------------- SQL-semantic witness
//
// The guard lives in one SQL statement, so a double that just returns a canned
// row would assert nothing about it. This witness INTERPRETS the statement the
// service builds: it reads which predicates are present, which parameter each
// bound value lands in, and -- the property Root's review turns on -- which
// byte measure the tally expresses. A tally narrowed to the JSONB columns
// alone therefore produces a different answer here, rather than passing.
//
// A predicate that is absent from the SQL is simply not applied, so removing
// one changes the returned rows and fails the test that asserts it.

type StoredAudit = {
  organizationId: string
  customerTenantId: string
  id: string
  microsoftAuditId: string
  eventDateTime: string
  activityDisplayName: string
  category: string | null
  operationType: string | null
  result: string | null
  correlationId: string | null
  loggedByService: string | null
  initiatedBy: unknown
  targetResources: unknown
  additionalDetails: unknown
  raw: unknown
  ingestedAt: string
  expiresAt: string
  resultReason?: string | null
}

type StoredProjection = {
  organizationId: string
  customerTenantId: string
  source: string
  sourceEventId: string
  operationName: string
  category?: string | null
  workload?: string | null
  targetType?: string | null
  result?: string | null
  raw?: unknown
  beforeState?: unknown
  afterState?: unknown
  actorPrincipalName?: string | null
  actorDisplayName?: string | null
  targetDisplayName?: string | null
}

const SELECTED_AUDIT_COLUMNS = [
  'id', 'microsoftAuditId', 'eventDateTime', 'activityDisplayName', 'category',
  'operationType', 'result', 'correlationId', 'loggedByService', 'initiatedBy',
  'targetResources', 'additionalDetails', 'raw', 'ingestedAt', 'expiresAt',
] as const

const JSONB_AUDIT_COLUMNS = ['initiatedBy', 'targetResources', 'additionalDetails', 'raw'] as const

function paramIndex(sql: string, pattern: RegExp): number | null {
  const found = pattern.exec(sql)
  return found ? Number(found[1]) : null
}

function interpretExportSql(
  sql: string,
  values: readonly unknown[],
  store: { audits: StoredAudit[]; projections: StoredProjection[] },
) {
  const at = (index: number | null) => (index === null ? undefined : values[index - 1])

  const orgIds = at(paramIndex(sql, /d\.organization_id = ANY\(\$(\d+)::uuid\[\]\)/)) as string[] | undefined
  const tenantId = at(paramIndex(sql, /d\.customer_tenant_id = \$(\d+)::uuid/)) as string | undefined
  const expiryAfter = at(paramIndex(sql, /d\.expires_at > \$(\d+)::timestamptz/)) as Date | undefined
  const since = at(paramIndex(sql, /d\.event_date_time >= \$(\d+)::timestamptz/)) as string | undefined
  const until = at(paramIndex(sql, /d\.event_date_time < \$(\d+)::timestamptz/)) as string | undefined
  const probe = at(paramIndex(sql, /LIMIT \$(\d+)/)) as number | undefined
  const cap = at(paramIndex(sql, /t\.candidate_count <= \$(\d+)/)) as number | undefined
  const budget = at(paramIndex(sql, /t\.selected_bytes <= \$(\d+)/)) as number | undefined

  if (probe === undefined) throw new Error('the candidate statement has no bound LIMIT')
  if (cap === undefined || budget === undefined) throw new Error('the tally guard binds no ceiling')

  // `since`/`until` are accepted at millisecond precision only, and the stored
  // instants may carry microseconds. Truncating a row down to its millisecond
  // floor cannot cross a bound that itself sits on an exact millisecond, so
  // comparing in milliseconds here is faithful. The genuine microsecond
  // comparison is a PHYSICAL case, not this witness.
  const ms = (value: string) => Date.parse(value)

  const candidates = store.audits
    .filter((row) => (orgIds ? orgIds.includes(row.organizationId) : true))
    .filter((row) => (tenantId ? row.customerTenantId === tenantId : true))
    .filter((row) => (expiryAfter ? ms(row.expiresAt) > expiryAfter.getTime() : true))
    .filter((row) => (since ? ms(row.eventDateTime) >= ms(since) : true))
    .filter((row) => (until ? ms(row.eventDateTime) < ms(until) : true))
    .sort((left, right) =>
      ms(right.eventDateTime) - ms(left.eventDateTime) || right.id.localeCompare(left.id))
    .slice(0, probe)

  const scopesProjectionSource = /e\.source = 'DIRECTORY_AUDIT'/.test(sql)
  const scopesProjectionTenant = /e\.customer_tenant_id = \$\d+::uuid/.test(sql)
  const scopesProjectionOrg = /e\.organization_id = ANY\(\$\d+::uuid\[\]\)/.test(sql)

  const joined = candidates.map((row) => {
    const match = store.projections.find((projection) =>
      projection.sourceEventId === row.microsoftAuditId
      && (!scopesProjectionSource || projection.source === 'DIRECTORY_AUDIT')
      && (!scopesProjectionTenant || projection.customerTenantId === tenantId)
      && (!scopesProjectionOrg || (orgIds ?? []).includes(projection.organizationId)))
    // Key order mirrors the SELECT list, because the tally measures the row's
    // own JSON text.
    const out: Record<string, unknown> = {}
    for (const column of SELECTED_AUDIT_COLUMNS) out[column] = (row as Record<string, unknown>)[column]
    out.projectedSource = match?.source ?? null
    out.projectedOperationName = match?.operationName ?? null
    out.projectedCategory = match?.category ?? null
    out.projectedWorkload = match?.workload ?? null
    out.projectedTargetType = match?.targetType ?? null
    out.projectedResult = match?.result ?? null
    out.projectedActorPrincipalName = match?.actorPrincipalName ?? null
    out.projectedActorDisplayName = match?.actorDisplayName ?? null
    out.projectedTargetDisplayName = match?.targetDisplayName ?? null
    out.projectedRaw = match?.raw ?? null
    out.projectedBeforeState = match?.beforeState ?? null
    out.projectedAfterState = match?.afterState ?? null
    return out
  })

  // Whichever measure the statement expresses is the measure applied here.
  let selectedBytes: number
  if (/octet_length\(row_to_json\(j\)::text\)/.test(sql)) {
    selectedBytes = joined.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row), 'utf8'), 0)
  } else if (/octet_length\(/.test(sql)) {
    // A narrower tally -- e.g. the JSONB payload columns alone -- measured as
    // written, so the difference from the total is observable.
    selectedBytes = joined.reduce((total, row) =>
      total + JSONB_AUDIT_COLUMNS.reduce((sum, column) =>
        sum + (row[column] === null || row[column] === undefined
          ? 0
          : Buffer.byteLength(JSON.stringify(row[column]), 'utf8')), 0), 0)
  } else {
    throw new Error('the tally measures nothing')
  }

  const withinCeilings = joined.length <= Number(cap) && selectedBytes <= Number(budget)
  return [{
    candidate_count: joined.length,
    selected_bytes: BigInt(selectedBytes),
    records: withinCeilings && joined.length > 0 ? joined : null,
  }]
}

type HarnessOptions = {
  audits?: StoredAudit[]
  projections?: StoredProjection[]
  memberships?: string[]
  disabledAt?: Date | null
  missingUser?: boolean
  tenants?: { id: string; organizationId: string }[]
}

function harness(options: HarnessOptions = {}) {
  const store = { audits: options.audits ?? [], projections: options.projections ?? [] }
  const memberships = options.memberships ?? [ORG_A]
  const tenants = options.tenants ?? [
    { id: TENANT_A, organizationId: ORG_A },
    { id: TENANT_B, organizationId: ORG_B },
  ]
  const statements: string[] = []
  const prisma = {
    user: {
      findUnique: async () => options.missingUser
        ? null
        : { disabledAt: options.disabledAt ?? null, memberships: memberships.map((organizationId) => ({ organizationId })) },
    },
    customerTenant: {
      findFirst: async ({ where }: { where: { id: string; organizationId: { in: string[] } } }) => {
        const found = tenants.find((tenant) =>
          tenant.id === where.id && where.organizationId.in.includes(tenant.organizationId))
        return found ? { id: found.id } : null
      },
    },
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
      statements.push(sql)
      return interpretExportSql(sql, values, store)
    },
  }
  const service = new ChangesService(prisma as unknown as PrismaService)
  return { service, store, statements }
}

const IDENTITY = { subject: 'auth0|investigator' } as unknown as AuthenticatedIdentity
const NOW = () => new Date('2026-03-10T00:00:00.000Z')

let sequence = 0
function audit(overrides: Partial<StoredAudit> = {}): StoredAudit {
  sequence += 1
  const token = String(sequence).padStart(4, '0')
  return {
    organizationId: ORG_A,
    customerTenantId: TENANT_A,
    id: `00000000-0000-4000-8000-00000000${token}`,
    microsoftAuditId: `audit-${token}`,
    eventDateTime: `2026-03-0${(sequence % 9) + 1}T12:00:00.000+00:00`,
    activityDisplayName: 'Reset user password',
    category: 'UserManagement',
    operationType: 'Update',
    result: 'success',
    correlationId: randomUUID(),
    loggedByService: 'Core Directory',
    initiatedBy: { user: { userPrincipalName: 'admin@example.test' } },
    targetResources: [{ type: 'User', userPrincipalName: 'target@example.test' }],
    additionalDetails: [{ key: 'Note', value: 'kept' }],
    raw: { correlationId: 'c-1', resultReason: 'stored elsewhere' },
    ingestedAt: '2026-03-05T00:00:00.000+00:00',
    expiresAt: '2026-09-05T00:00:00.000+00:00',
    ...overrides,
  }
}

const PRIMARY_SHAPE = {} as const
/** Measured, not assumed: an operation the reviewed catalog does not admit. */
const EXCLUDED_SHAPE = { activityDisplayName: 'Export directory report', operationType: 'Read' } as const

function projectionFor(row: StoredAudit, overrides: Partial<StoredProjection> = {}): StoredProjection {
  return {
    organizationId: ORG_A,
    customerTenantId: TENANT_A,
    source: 'DIRECTORY_AUDIT',
    sourceEventId: row.microsoftAuditId,
    operationName: 'Reset user password',
    category: 'Passwords',
    targetType: null,
    result: 'success',
    raw: {},
    ...overrides,
  }
}

async function refusalFrom(run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    return error as { getStatus?: () => number; getResponse?: () => Record<string, unknown>; message?: string }
  }
  return null
}

// ------------------------------------------------------------- authorization

test('a tenant outside the caller organizations is refused in the nondisclosing wording', async () => {
  const { service, statements } = harness({ memberships: [ORG_A] })
  await assert.rejects(
    () => service.exportDirectoryAudit(IDENTITY, TENANT_B, undefined, undefined, { now: NOW }),
    /unavailable or outside retention/)
  // Nothing was read: the refusal is decided before the guarded statement runs.
  assert.equal(statements.length, 0)
})

test('an unknown tenant is refused in exactly the same wording as a foreign one', async () => {
  const { service } = harness({ memberships: [ORG_A] })
  const unknown = await refusalFrom(() =>
    service.exportDirectoryAudit(IDENTITY, '12345678-1234-4123-8123-123456789abc', undefined, undefined, { now: NOW }))
  const foreign = await refusalFrom(() =>
    service.exportDirectoryAudit(IDENTITY, TENANT_B, undefined, undefined, { now: NOW }))
  assert.equal(unknown?.message, foreign?.message)
  assert.match(String(unknown?.message), /unavailable or outside retention/)
})

test('a disabled or absent account cannot export at all', async () => {
  for (const options of [{ disabledAt: new Date('2026-01-01T00:00:00.000Z') }, { missingUser: true }]) {
    const { service, statements } = harness(options)
    await assert.rejects(
      () => service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW }),
      /cannot investigate changes/)
    assert.equal(statements.length, 0)
  }
})

test('records belonging to another organization are not exported with the tenant', async () => {
  // The tenant resolves inside ORG_A, but a row carrying ORG_B must not join the
  // export merely because it shares the customer tenant identifier.
  const mine = audit({ organizationId: ORG_A, eventDateTime: '2026-03-02T12:00:00.000+00:00' })
  const theirs = audit({ organizationId: ORG_B, eventDateTime: '2026-03-03T12:00:00.000+00:00' })
  const { service } = harness({ memberships: [ORG_A], audits: [mine, theirs] })
  const { envelope } = await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  assert.equal(envelope.candidates, 1)
  assert.deepEqual(envelope.records.map((record) => record.id), [mine.id])
})

test('a projection from another organization does not decide a row', async () => {
  const row = audit(EXCLUDED_SHAPE)
  const { service } = harness({
    memberships: [ORG_A],
    audits: [row],
    projections: [projectionFor(row, { organizationId: ORG_B })],
  })
  const { envelope } = await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  // Without an in-scope projection the stored row decides, and it is excluded.
  assert.equal(envelope.returned, 0)
  assert.equal(envelope.excludedByClassification, 1)
})

test('a projection from another evidence source does not decide a row', async () => {
  // The batched lookup is scoped to DIRECTORY_AUDIT. A management-activity
  // event sharing the identifier must not decide a directory record.
  const foreign = {
    source: 'M365_UNIFIED_AUDIT',
    workload: 'Azure Active Directory',
    operationName: 'Add directory role assignment',
    category: null,
  } as const
  // Precondition: this projection WOULD admit the row if it were used. Without
  // it the case passes whether or not the join is scoped, because a shapeless
  // foreign projection classifies as excluded anyway.
  assert.ok(
    PRIMARY_CHANGE_CLASSIFICATIONS.has(classifyEvidence({
      source: foreign.source, workload: foreign.workload, activity: foreign.operationName,
      category: foreign.category, actor: 'admin@example.test', result: 'success',
    })),
    'the foreign projection must be one that would be admitted')

  const row = audit(EXCLUDED_SHAPE)
  const { service } = harness({
    audits: [row],
    projections: [projectionFor(row, foreign)],
  })
  const { envelope } = await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  assert.equal(envelope.returned, 0)
  assert.equal(envelope.excludedByClassification, 1)
})

test('another tenant in the same organization is not exported', async () => {
  // Organization scoping alone would not separate these: both rows sit in
  // ORG_A, and the caller is authorized there.
  const requested = audit({ customerTenantId: TENANT_A, eventDateTime: '2026-03-02T12:00:00.000+00:00' })
  const sibling = audit({ customerTenantId: TENANT_B, eventDateTime: '2026-03-03T12:00:00.000+00:00' })
  const { service } = harness({
    memberships: [ORG_A, ORG_B],
    audits: [requested, sibling],
    tenants: [{ id: TENANT_A, organizationId: ORG_A }, { id: TENANT_B, organizationId: ORG_A }],
  })
  const { envelope } = await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  assert.equal(envelope.candidates, 1)
  assert.deepEqual(envelope.records.map((record) => (record as Record<string, unknown>).id), [requested.id])
})

// --------------------------------------------------------------- what is sent

test('an exported record carries exactly the declared top-level fields', async () => {
  // `raw` here deliberately does NOT echo the column, so this case isolates the
  // column omission; the ingestion-shaped case covers the raw copy.
  const row = audit({
    resultReason: 'operator-visible reason text',
    raw: { activityDisplayName: 'Reset user password', correlationId: 'c-1' },
  })
  const { service } = harness({ audits: [row] })
  const { envelope, filename } = await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  assert.equal(envelope.returned, 1)
  assert.deepEqual(Object.keys(envelope.records[0]!).sort(), [...EXPORTED_DIRECTORY_FIELDS].sort())
  assert.equal('resultReason' in (envelope.records[0] as Record<string, unknown>), false)
  assert.doesNotMatch(JSON.stringify(envelope), /operator-visible reason text/)
  assert.equal(filename, directoryAuditExportFilename(TENANT_A, UNBOUNDED_WINDOW))
})

test('the omission is the top-level column, and the raw copy is preserved', async () => {
  // Ingestion-shaped: the collector stores `resultReason` as a column AND
  // stores the whole parsed row in `raw`, so the same text is in both places.
  // Omitting the column does not remove it from the file, and claiming
  // otherwise is the overstatement the reviewer caught.
  const reason = 'Microsoft stated reason text'
  const row = audit({
    resultReason: reason,
    raw: { activityDisplayName: 'Reset user password', resultReason: reason, correlationId: 'c-1' },
  })
  const { service } = harness({ audits: [row] })
  const { envelope } = await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  const record = envelope.records[0] as Record<string, unknown>
  // The column is absent from the record.
  assert.equal('resultReason' in record, false)
  // And the same text IS still present, inside the preserved raw copy.
  assert.equal((record.raw as Record<string, unknown>).resultReason, reason)
  assert.match(JSON.stringify(envelope), new RegExp(reason))
  // So the declaration must scope the omission rather than imply absence.
  assert.match(envelope.fidelity.omissionScope, /may still be present inside the exported "raw" copy/)
  assert.equal(envelope.fidelity.omittedTopLevelFields.includes('resultReason'), true)
})

test('a stored microsecond instant is exported unrounded', async () => {
  // The record is copied, never round-tripped through a millisecond Date --
  // which is what would silently drop the microsecond tail.
  const stored = '2026-03-01T00:00:00.000500+00:00'
  assert.notEqual(new Date(Date.parse(stored)).toISOString(), stored,
    'this case only means something because a Date round-trip loses the tail')
  const { service } = harness({ audits: [audit({ eventDateTime: stored })] })
  const { envelope } = await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  assert.equal((envelope.records[0] as Record<string, unknown>).eventDateTime, stored)
})

test('values matching the redaction rule are replaced on the way out', async () => {
  const { service } = harness({
    audits: [audit({
      initiatedBy: { user: { userPrincipalName: 'admin@example.test', clientSecret: 'super-secret-value' } },
      additionalDetails: [{ key: 'Authorization', value: 'Bearer leaked-token-value' }],
      raw: { refresh_token: 'leaked-refresh-value', activity: 'kept' },
    })],
  })
  const { envelope } = await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  const text = JSON.stringify(envelope)
  // The bearer value is asserted against the COMPLETE serialized envelope.
  // My first version built this exact detail and then checked only the other
  // two strings, so it passed while the token was still in the file.
  for (const leak of ['super-secret-value', 'leaked-refresh-value', 'Bearer leaked-token-value', 'leaked-token-value']) {
    assert.doesNotMatch(text, new RegExp(leak), leak)
  }
  assert.match(text, /\[REDACTED\]/)
  assert.match(text, /kept/)
})

test('a sensitive detail nested in the stored raw copy does not reach the file', async () => {
  const { service } = harness({
    audits: [audit({
      additionalDetails: [{ key: 'Note', value: 'kept-detail' }],
      raw: {
        activityDisplayName: 'Reset user password',
        additionalDetails: [{ key: 'Authorization', value: 'Bearer nested-bearer-value' }],
        targetResources: [{
          modifiedProperties: [{ displayName: 'Client Secret', oldValue: 'old-nested-secret', newValue: 'new-nested-secret' }],
        }],
      },
    })],
  })
  const { envelope } = await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  const text = JSON.stringify(envelope)
  for (const leak of ['nested-bearer-value', 'old-nested-secret', 'new-nested-secret']) {
    assert.doesNotMatch(text, new RegExp(leak), leak)
  }
  assert.match(text, /kept-detail/)
})

test('records are ordered newest first and tie-broken by identifier', async () => {
  const tie = '2026-03-04T12:00:00.000+00:00'
  const rows = [
    audit({ id: '00000000-0000-4000-8000-0000000000a1', eventDateTime: tie }),
    audit({ id: '00000000-0000-4000-8000-0000000000a2', eventDateTime: tie }),
    audit({ eventDateTime: '2026-03-06T12:00:00.000+00:00' }),
  ]
  const { service } = harness({ audits: rows })
  const { envelope } = await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  assert.deepEqual(envelope.records.map((record) => record.eventDateTime), [
    '2026-03-06T12:00:00.000+00:00', tie, tie,
  ])
  assert.deepEqual(envelope.records.slice(1).map((record) => record.id), [
    '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a1',
  ])
})

// ------------------------------------------------------------- classification

test('a matching projection decides the row in both directions', async () => {
  const wouldBeExcluded = audit(EXCLUDED_SHAPE)
  const included = harness({
    audits: [wouldBeExcluded],
    projections: [projectionFor(wouldBeExcluded)],
  })
  const admitted = await included.service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  assert.equal(admitted.envelope.returned, 1)
  assert.equal(admitted.envelope.excludedByClassification, 0)

  const wouldBeIncluded = audit(PRIMARY_SHAPE)
  const excluded = harness({
    audits: [wouldBeIncluded],
    projections: [projectionFor(wouldBeIncluded, { operationName: 'Viewed directory report', category: 'Other' })],
  })
  const refusedRow = await excluded.service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  assert.equal(refusedRow.envelope.returned, 0)
  assert.equal(refusedRow.envelope.excludedByClassification, 1)
})

test('excluded rows are counted against the candidate set rather than hidden', async () => {
  const { service } = harness({ audits: [audit(PRIMARY_SHAPE), audit(EXCLUDED_SHAPE), audit(EXCLUDED_SHAPE)] })
  const { envelope } = await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  assert.equal(envelope.candidates, 3)
  assert.equal(envelope.returned, 1)
  assert.equal(envelope.excludedByClassification, 2)
  assert.equal(envelope.returned + envelope.excludedByClassification, envelope.candidates)
})

test('a window whose every candidate is excluded succeeds with an empty, truthful envelope', async () => {
  const { service } = harness({ audits: [audit(EXCLUDED_SHAPE), audit(EXCLUDED_SHAPE)] })
  const { envelope } = await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  assert.deepEqual(envelope.records, [])
  assert.equal(envelope.candidates, 2)
  assert.equal(envelope.excludedByClassification, 2)
  // Not presented as "no administrative events existed in the window".
  assert.match(envelope.fidelity.coverage, /not a claim that every retained Microsoft event is included/)
})

test('an expired but not yet deleted record is outside the export', async () => {
  const live = audit({ expiresAt: '2026-09-05T00:00:00.000+00:00' })
  const stale = audit({ expiresAt: '2026-03-09T23:59:59.999+00:00' })
  const { service } = harness({ audits: [live, stale] })
  const { envelope } = await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  assert.equal(envelope.candidates, 1)
  assert.deepEqual(envelope.records.map((record) => record.id), [live.id])
})

// ------------------------------------------------------------------ ceilings

test('the cap governs candidates, so a full page of eligible rows still refuses', async () => {
  // Root's counterexample: capping candidates and then describing overflow in
  // terms of ELIGIBLE rows would return three eligible records here and
  // silently drop everything older.
  const newestExcluded = audit({ ...EXCLUDED_SHAPE, eventDateTime: '2026-03-08T12:00:00.000+00:00' })
  const eligible = [
    audit({ eventDateTime: '2026-03-07T12:00:00.000+00:00' }),
    audit({ eventDateTime: '2026-03-06T12:00:00.000+00:00' }),
    audit({ eventDateTime: '2026-03-05T12:00:00.000+00:00' }),
  ]
  const { service } = harness({ audits: [newestExcluded, ...eligible] })
  const refusal = await refusalFrom(() => service.exportDirectoryAudit(
    IDENTITY, TENANT_A, undefined, undefined, { now: NOW, candidateCap: 3 }))
  const body = refusal?.getResponse?.() as Record<string, unknown>
  assert.equal(refusal?.getStatus?.(), 409)
  assert.equal(body.code, DIRECTORY_AUDIT_EXPORT_TOO_LARGE)
  assert.equal(body.refusal, 'CANDIDATE_CAP_EXCEEDED')
  assert.equal(body.candidateCap, 3)
  // A lower bound, not a total: the statement never counted past the probe.
  assert.equal(body.observedAtLeast, 4)
  assert.equal('candidates' in body, false)
  assert.equal('observedTotal' in body, false)
  // No payload was carried out of the database on refusal.
  assert.doesNotMatch(JSON.stringify(body), /admin@example\.test|Reset user password/)
})

test('the cap refuses one past itself and succeeds exactly at it', async () => {
  const rows = Array.from({ length: 4 }, (_, index) =>
    audit({ eventDateTime: `2026-03-0${index + 1}T12:00:00.000+00:00` }))
  const atCap = harness({ audits: rows.slice(0, 3) })
  const { envelope } = await atCap.service.exportDirectoryAudit(
    IDENTITY, TENANT_A, undefined, undefined, { now: NOW, candidateCap: 3 })
  assert.equal(envelope.candidates, 3)
  assert.equal(envelope.returned, 3)

  const overCap = harness({ audits: rows })
  await assert.rejects(() => overCap.service.exportDirectoryAudit(
    IDENTITY, TENANT_A, undefined, undefined, { now: NOW, candidateCap: 3 }), /Narrow the requested date range/)
})

test('the read budget covers the whole selected row, not only its JSONB payload', async () => {
  // Root's required case: the payload columns alone fit comfortably, and the
  // total selected representation does not. A tally narrowed to JSONB would
  // admit this export and read far more than the budget allows.
  const wide = 'Reset user password '.repeat(120)
  const rows = [audit({ activityDisplayName: wide }), audit({ activityDisplayName: wide }), audit()]
  const budget = 3000
  const jsonbBytes = rows.reduce((total, row) =>
    total + [row.initiatedBy, row.targetResources, row.additionalDetails, row.raw]
      .reduce((sum: number, value: unknown) => sum + Buffer.byteLength(JSON.stringify(value), 'utf8'), 0), 0)
  // The precondition is asserted, not narrated: without this the case could
  // pass for the wrong reason.
  assert.ok(jsonbBytes <= budget, `payload columns alone must fit: ${jsonbBytes} > ${budget}`)

  const { service } = harness({ audits: rows })
  const refusal = await refusalFrom(() => service.exportDirectoryAudit(
    IDENTITY, TENANT_A, undefined, undefined, { now: NOW, readBudgetBytes: budget }))
  const body = refusal?.getResponse?.() as Record<string, unknown>
  assert.equal(body.refusal, 'READ_BUDGET_EXCEEDED')
  assert.equal(body.readBudgetBytes, budget)
  assert.ok(Number(body.observedBytes) > budget)
  assert.ok(Number(body.observedBytes) > jsonbBytes)
  assert.doesNotMatch(JSON.stringify(body), /admin@example\.test/)
})

test('the budget is decided on what had to be read, not on what would have been sent', async () => {
  // Every candidate is excluded by classification, so the output would have
  // been empty; the export still refuses, because the read still happened.
  const wide = 'Export directory report '.repeat(120)
  const rows = [audit({ ...EXCLUDED_SHAPE, activityDisplayName: wide }), audit({ ...EXCLUDED_SHAPE, activityDisplayName: wide })]
  const { service } = harness({ audits: rows })
  const refusal = await refusalFrom(() => service.exportDirectoryAudit(
    IDENTITY, TENANT_A, undefined, undefined, { now: NOW, readBudgetBytes: 3000 }))
  assert.equal((refusal?.getResponse?.() as Record<string, unknown>).refusal, 'READ_BUDGET_EXCEEDED')
})

test('the serialized envelope has its own ceiling', async () => {
  const bulky = Array.from({ length: 220 }, (_, index) => audit({
    eventDateTime: `2026-03-0${(index % 9) + 1}T12:00:00.000+00:00`,
    additionalDetails: [{ key: 'Detail', value: 'd'.repeat(5000) }],
  }))
  const { service } = harness({ audits: bulky })
  const refusal = await refusalFrom(() => service.exportDirectoryAudit(
    IDENTITY, TENANT_A, undefined, undefined, { now: NOW, readBudgetBytes: 500_000_000 }))
  const body = refusal?.getResponse?.() as Record<string, unknown>
  assert.equal(body.refusal, 'ENVELOPE_CEILING_EXCEEDED')
  assert.equal(body.envelopeByteCeiling, 1_000_000)
  assert.ok(Number(body.observedBytes) > 1_000_000)
})

// ---------------------------------------------------------------- the window

test('the window is applied as half-open, excluding a record exactly at the upper bound', async () => {
  const atLowerBound = audit({ eventDateTime: '2026-03-01T00:00:00.000+00:00' })
  const inside = audit({ eventDateTime: '2026-03-01T06:00:00.000+00:00' })
  const atUpperBound = audit({ eventDateTime: '2026-03-02T00:00:00.000+00:00' })
  const { service } = harness({ audits: [atLowerBound, inside, atUpperBound] })
  const { envelope, filename } = await service.exportDirectoryAudit(
    IDENTITY, TENANT_A, '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z', { now: NOW })
  assert.deepEqual(envelope.records.map((record) => record.id), [inside.id, atLowerBound.id])
  assert.deepEqual(envelope.window, { since: '2026-03-01T00:00:00.000Z', until: '2026-03-02T00:00:00.000Z' })
  assert.match(filename, /2026-03-01T00-00-00\.000Z_to_2026-03-02T00-00-00\.000Z/)
})

test('an unbounded request binds no window parameter at all', async () => {
  const { service, statements } = harness({ audits: [audit()] })
  await service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
  assert.doesNotMatch(statements[0]!, /event_date_time >=/)
  assert.doesNotMatch(statements[0]!, /event_date_time </)
})

// ------------------------------------------------------------- the http seam

function responseDouble() {
  const headers: Record<string, string> = {}
  return { headers, response: { setHeader: (name: string, value: string) => { headers[name] = value } } }
}

test('a successful download is marked no-store and named as an attachment', async () => {
  const { service } = harness({ audits: [audit()] })
  const controller = new ChangesController(service)
  const { headers, response } = responseDouble()
  const envelope = await controller.exportDirectoryAudit(
    { auth: IDENTITY, body: undefined, headers: {} } as never,
    { tenantId: TENANT_A },
    response as never)
  assert.equal(headers['Cache-Control'], 'no-store')
  assert.equal(headers['Content-Type'], 'application/json; charset=utf-8')
  assert.match(headers['Content-Disposition']!, /^attachment; filename="hawkview_directory_audit_stored_redacted_/)
  assert.equal((envelope as { qualification: string }).qualification, DIRECTORY_AUDIT_EXPORT_QUALIFICATION)
})

test('a refused download announces no attachment and sets no headers', async () => {
  const { service } = harness({ audits: [audit(), audit()] })
  const controller = new ChangesController(service)
  const { headers, response } = responseDouble()
  await assert.rejects(() => controller.exportDirectoryAudit(
    { auth: IDENTITY, body: undefined, headers: {} } as never,
    { tenantId: TENANT_B },
    response as never))
  assert.deepEqual(headers, {})
})

test('an unexpected parameter is refused before anything is read', async () => {
  const { service, statements } = harness({ audits: [audit()] })
  const controller = new ChangesController(service)
  const { headers, response } = responseDouble()
  await assert.rejects(() => controller.exportDirectoryAudit(
    { auth: IDENTITY, body: undefined, headers: {} } as never,
    { tenantId: TENANT_A, organizationId: ORG_B },
    response as never), /does not accept organizationId/)
  assert.equal(statements.length, 0)
  assert.deepEqual(headers, {})
})

// ------------------------------------------------ actual HTTP dispatch seam
//
// The earlier route-order check read decorator metadata, which is structural
// evidence about the source rather than a dispatch witness. This boots a real
// Nest/Express application over the existing dependencies -- no new package,
// no change to global route or parser policy -- and issues real requests. The
// service is stubbed on purpose: what is under test is dispatch, framing and
// response headers, not service logic. A GET body is written through
// `node:http`, because `fetch` refuses to send one.

type HttpResult = { status: number; headers: Record<string, string | string[] | undefined>; text: string }

function httpGet(port: number, path: string, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: body === undefined
        ? {}
        : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers as HttpResult['headers'],
        text,
      }))
    })
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}

async function exportApp(stub: Partial<Record<'list' | 'detail' | 'exportDirectoryAudit', unknown>>) {
  @Module({
    controllers: [ChangesController],
    providers: [{ provide: ChangesService, useValue: stub }],
  })
  class ExportDispatchModule {}

  const app = await NestFactory.create(ExportDispatchModule, { logger: false })
  // The verified identity normally arrives from the application's own auth
  // layer; this supplies it so dispatch can be exercised in isolation.
  app.use((request: Record<string, unknown>, _response: unknown, next: () => void) => {
    request.auth = IDENTITY
    next()
  })
  await app.listen(0)
  const address = app.getHttpServer().address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { app, port }
}

test('over real HTTP, /api/changes/export reaches the export handler and not :id', async (context) => {
  const calls: string[] = []
  const { app, port } = await exportApp({
    list: async () => { calls.push('list'); return {} },
    detail: async (_identity: unknown, id: string) => { calls.push(`detail:${id}`); return { id } },
    exportDirectoryAudit: async () => {
      calls.push('export')
      const { service } = harness({ audits: [audit()] })
      return service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
    },
  })
  context.after(async () => { await app.close() })

  const exported = await httpGet(port, `/api/changes/export?tenantId=${TENANT_A}`)
  assert.equal(exported.status, 200)
  assert.deepEqual(calls, ['export'])
  assert.equal(exported.headers['cache-control'], 'no-store')
  assert.equal(exported.headers['content-type'], 'application/json; charset=utf-8')
  assert.match(
    String(exported.headers['content-disposition']),
    /^attachment; filename="hawkview_directory_audit_stored_redacted_/)
  assert.equal(JSON.parse(exported.text).qualification, DIRECTORY_AUDIT_EXPORT_QUALIFICATION)

  // The parameter route still works and is not shadowed in the other direction.
  const detail = await httpGet(port, `/api/changes/${TENANT_B}?tenantId=${TENANT_A}`)
  assert.equal(detail.status, 200)
  assert.deepEqual(calls, ['export', `detail:${TENANT_B}`])
})

test('over real HTTP, an explicitly supplied empty JSON body is refused with no attachment', async (context) => {
  const calls: string[] = []
  const { app, port } = await exportApp({
    detail: async () => ({}),
    exportDirectoryAudit: async () => {
      calls.push('export')
      const { service } = harness({ audits: [audit()] })
      return service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW })
    },
  })
  context.after(async () => { await app.close() })

  // Control: the same request without a body succeeds, so the refusal below is
  // caused by the body and not by the request being malformed.
  const allowed = await httpGet(port, `/api/changes/export?tenantId=${TENANT_A}`)
  assert.equal(allowed.status, 200)
  assert.equal(calls.length, 1)

  const refused = await httpGet(port, `/api/changes/export?tenantId=${TENANT_A}`, '{}')
  assert.equal(refused.status, 400)
  assert.match(refused.text, /does not accept a request body/)
  // The service was never reached, and nothing announced an attachment.
  assert.equal(calls.length, 1)
  assert.equal(refused.headers['content-disposition'], undefined)

  const populated = await httpGet(port, `/api/changes/export?tenantId=${TENANT_A}`, '{"tenantId":"other"}')
  assert.equal(populated.status, 400)
  assert.equal(populated.headers['content-disposition'], undefined)
  assert.equal(calls.length, 1)
})

test('over real HTTP, a refusal and an unexpected parameter announce no attachment', async (context) => {
  const { app, port } = await exportApp({
    detail: async () => ({}),
    exportDirectoryAudit: async () => {
      const { service } = harness({ audits: [audit(), audit()] })
      // Two candidates against a cap of one: the real refusal path.
      return service.exportDirectoryAudit(IDENTITY, TENANT_A, undefined, undefined, { now: NOW, candidateCap: 1 })
    },
  })
  context.after(async () => { await app.close() })

  const refused = await httpGet(port, `/api/changes/export?tenantId=${TENANT_A}`)
  assert.equal(refused.status, 409)
  const body = JSON.parse(refused.text)
  assert.equal(body.code, DIRECTORY_AUDIT_EXPORT_TOO_LARGE)
  assert.equal(body.refusal, 'CANDIDATE_CAP_EXCEEDED')
  assert.equal(refused.headers['content-disposition'], undefined)
  assert.notEqual(refused.headers['cache-control'], 'no-store')

  const widened = await httpGet(port, `/api/changes/export?tenantId=${TENANT_A}&organizationId=${ORG_B}`)
  assert.equal(widened.status, 400)
  assert.match(widened.text, /does not accept organizationId/)
  assert.equal(widened.headers['content-disposition'], undefined)
})
