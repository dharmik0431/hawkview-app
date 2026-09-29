import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaService } from '../prisma/prisma.service.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { persistAuthenticationRecords } from './authentication-ingestion-integrity.js'

/** Only PostgreSQL knows what PostgreSQL stored, so only PostgreSQL can prove
 *  this bound is held. A JavaScript size model cannot: a written numeric keeps
 *  its scale through `jsonb_set` while `JSON.parse` destroys it, so an estimate
 *  understates the row — measured at 502 bytes on a 400-digit case. No margin can
 *  bound that, which is why the module measures instead of estimating. These are
 *  the two cases that a JavaScript-sized candidate was accepted on and should
 *  not have been. They must fail against any revision that stops measuring. */
const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const MAX_ROW = 16_384, MAX_BATCH = 2_097_152, MARKER_BYTES = 134
const MARKED_AT = new Date('2026-09-29T00:00:00.000Z')

async function fixture(work: (f: any) => Promise<void>) {
  assertDisposableTestDatabase()
  const prisma = new PrismaService()
  await prisma.$connect()
  const organizationId = randomUUID(), customerTenantId = randomUUID()
  const scope = { organizationId, customerTenantId }
  const p = prisma as any
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Capacity fixture', slug: `capacity-${organizationId}` } })
    await prisma.customerTenant.create({ data: { id: customerTenantId, organizationId, microsoftTenantId: randomUUID(), displayName: 'Capacity tenant', status: 'ACTIVE' } })
    const record = (id: string, raw: any = {}) => ({
      ...scope, microsoftSignInId: id,
      eventDateTime: new Date('2026-09-08T12:00:00Z'), ingestedAt: new Date('2026-09-08T12:01:00Z'),
      expiresAt: new Date('2026-12-07T12:00:00Z'), riskLevel: 'high',
      raw: { id, createdDateTime: '2026-09-08T12:00:00Z', userId: '33333333-3333-4333-8333-333333333333',
             appId: '44444444-4444-4444-8444-444444444444', status: { errorCode: 50126 }, ipAddress: '192.0.2.1', ...raw },
    })
    const one = async (sql: string, ...args: unknown[]) => (await p.$queryRawUnsafe(sql, ...args))[0]
    await work({ prisma, p, scope, record, one,
      storedText: async (json: string) => Number((await one(`SELECT octet_length($1::jsonb::text) AS n`, json)).n),
      count: async () => Number((await one(`SELECT count(*) AS c FROM sign_in_logs WHERE customer_tenant_id=$1::uuid`, customerTenantId)).c),
      marked: async () => Number((await one(`SELECT count(*) AS c FROM sign_in_logs WHERE customer_tenant_id=$1::uuid AND raw ? 'hawkviewAuthenticationIntegrity'`, customerTenantId)).c) })
  } finally {
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.$disconnect()
  }
}

test('a stored numeric keeps a scale JavaScript cannot see, so the marked row is refused on the database’s own measurement',
  { skip: !enabled, timeout: 60_000 }, () => fixture(async (f) => {
    const inner = { id: 'scale', createdDateTime: '2026-09-08T12:00:00Z', userId: '33333333-3333-4333-8333-333333333333',
      appId: '44444444-4444-4444-8444-444444444444', status: { errorCode: 50126 }, ipAddress: '192.0.2.1' }
    // The literal is never parsed by JavaScript, so the scale survives to the column.
    let pad = 15_500, text = '', stored = 0
    for (let attempt = 0; attempt < 40; attempt += 1) {
      text = JSON.stringify({ ...inner, pad: 'x'.repeat(pad) }).replace(/}$/, `,"n": 1.${'0'.repeat(400)}}`)
      stored = await f.storedText(text)
      if (stored > MAX_ROW - MARKER_BYTES && stored <= MAX_ROW) break
      pad += MAX_ROW - 60 - stored
      assert.ok(pad > 0, 'could not size the fixture')
    }
    const javascriptView = Buffer.byteLength(JSON.stringify(JSON.parse(text)))
    assert.ok(stored > MAX_ROW - MARKER_BYTES && stored <= MAX_ROW,
      `fixture must sit inside the row bound but within a marker of it: ${stored}`)
    assert.ok(javascriptView < stored - 300,
      `the premise: PostgreSQL stores ${stored} bytes where JavaScript computes ${javascriptView}`)

    await f.p.$executeRawUnsafe(
      `INSERT INTO sign_in_logs (id,organization_id,customer_tenant_id,microsoft_sign_in_id,event_date_time,expires_at,risk_level,raw)
       VALUES (gen_random_uuid(),$1::uuid,$2::uuid,'scale',now(),now()+interval '90 days','high',$3::jsonb)`,
      f.scope.organizationId, f.scope.customerTenantId, text)

    // A differing fingerprint forces STORED_FINGERPRINT_MISMATCH, so a marker is due.
    await assert.rejects(
      () => persistAuthenticationRecords(f.prisma, f.scope, [f.record('scale', { status: { errorCode: 0 } })] as never, undefined, MARKED_AT),
      /IDENTITY_AUTH_CAPACITY/, 'marking it would breach the stored bound, so the write must be refused')

    const after = await f.one(
      `SELECT raw ? 'hawkviewAuthenticationIntegrity' AS marked, octet_length(raw::text) AS n
         FROM sign_in_logs WHERE customer_tenant_id=$1::uuid AND microsoft_sign_in_id='scale'`, f.scope.customerTenantId)
    assert.equal(after.marked, false, 'evidence is never truncated and quarantine is never dropped to make room')
    assert.equal(Number(after.n), stored, 'the stored row is left byte-identical')
  }))

test('rows that each fit can still put the selected-plus-inserted set past the batch bound',
  { skip: !enabled, timeout: 60_000 }, () => fixture(async (f) => {
    const N = 65
    // Sized so the pre-existing INPUT byte check stays silent: otherwise this
    // would pass for the wrong reason and prove nothing about the stored union.
    let pad = 15_700, compact = 0, stored = 0
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const raw = f.record('probe', { pad: 'z'.repeat(pad) }).raw
      compact = Buffer.byteLength(JSON.stringify(raw))
      stored = await f.storedText(JSON.stringify(raw))
      if (2 * N * compact < MAX_BATCH && 2 * N * stored + N * MARKER_BYTES > MAX_BATCH) break
      pad += 2 * N * compact < MAX_BATCH ? 5 : -20
    }
    assert.ok(2 * N * compact < MAX_BATCH, `input bound must stay silent: ${2 * N * compact}`)
    assert.ok(2 * N * stored + N * MARKER_BYTES > MAX_BATCH, `stored union must cross: ${2 * N * stored + N * MARKER_BYTES}`)

    const padText = 'z'.repeat(pad)
    await persistAuthenticationRecords(f.prisma, f.scope,
      Array.from({ length: N }, (_, i) => f.record(`old-${i}`, { pad: padText })) as never, undefined, MARKED_AT)
    assert.equal(await f.count(), N, 'the existing rows seeded cleanly')
    const maxRow = Number((await f.one(
      `SELECT max(octet_length(raw::text)) AS m FROM sign_in_logs WHERE customer_tenant_id=$1::uuid`, f.scope.customerTenantId)).m)
    assert.ok(maxRow <= MAX_ROW, `every row is individually inside the row bound: ${maxRow}`)

    await assert.rejects(() => persistAuthenticationRecords(f.prisma, f.scope, [
      ...Array.from({ length: N }, (_, i) => f.record(`old-${i}`, { pad: padText, status: { errorCode: 0 } })),
      ...Array.from({ length: N }, (_, i) => f.record(`new-${i}`, { pad: padText })),
    ] as never, undefined, MARKED_AT), /IDENTITY_AUTH_CAPACITY/, 'the union of updated and inserted rows must be refused')

    assert.equal(await f.count(), N, 'refused means rolled back: nothing new persisted')
    assert.equal(await f.marked(), 0, 'and no marker was left behind')
  }))
