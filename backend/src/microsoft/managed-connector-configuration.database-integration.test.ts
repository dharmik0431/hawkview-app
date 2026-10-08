import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { SecretStoreService } from '../secrets/secret-store.service.js'
import { PLATFORM_OWNED } from '../secrets/secret-owner.js'
import { MicrosoftConsentService } from './microsoft-consent.service.js'
import { captureManagedAuthority, publishManagedAuthority, type AuthorityDatabase, type AuthorityTransaction,
  type PreparedManagedPublication } from './managed-connector-authority.js'

const skip = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1'
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
const input = () => ({ clientId: randomUUID(), homeTenantId: randomUUID(), clientSecret: 'synthetic-' + randomUUID(),
  credentialExpiresAt: new Date('2030-01-01T00:00:00Z') })
const verified = () => ({ missingRequiredPermissions: [], displayName: 'Synthetic organization' })

test('managed configuration integrated service with actual Prisma transactions', { skip, timeout: 90000 }, async t => {
  const url = assertDisposableTestDatabase()
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 })
  const observer = await pool.connect(), schema = 'config_adapter_' + randomUUID().replaceAll('-', '')
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), max: 8 }, { schema }) })
  const envNames = ['SECRET_ENCRYPTION_KEY', 'SECRET_ENCRYPTION_KEY_VERSION', 'SECRET_ENCRYPTION_KEY_PREVIOUS']
  const saved = envNames.map(name => process.env[name])
  process.env.SECRET_ENCRYPTION_KEY = '35'.repeat(32)
  delete process.env.SECRET_ENCRYPTION_KEY_VERSION
  delete process.env.SECRET_ENCRYPTION_KEY_PREVIOUS
  let created = false
  try {
    await observer.query(`CREATE SCHEMA ${schema}`); created = true
    await observer.query(`SET search_path TO ${schema},public`)
    // Real migrated schema shapes; the CI job applies the complete migration chain.
    // Clone only these global tables so no test touches the shared public connector.
    for (const name of ['platform_microsoft_connectors', 'encrypted_secrets', 'managed_connector_authority_revisions']) {
      await observer.query(`CREATE TABLE ${schema}.${name} (LIKE public.${name} INCLUDING ALL)`)
    }
    const host = (hook?: (sql: string) => Promise<void>, beforeCommit?: () => Promise<void>): AuthorityDatabase => ({
      async $transaction<T>(work: (tx: AuthorityTransaction) => Promise<T>, options?: { isolationLevel: 'ReadCommitted' }) {
        assert.equal(options?.isolationLevel, 'ReadCommitted')
        return prisma.$transaction(async actual => {
          await actual.$executeRawUnsafe(`SET LOCAL search_path TO ${schema},public`)
          await actual.$executeRawUnsafe("SET LOCAL statement_timeout='5s'")
          const tx: AuthorityTransaction = {
            async $queryRawUnsafe<T>(sql: string, ...values: any[]): Promise<T> {
              const result = await actual.$queryRawUnsafe<T>(sql, ...values); await hook?.(sql); return result
            },
            async $executeRawUnsafe(sql: string, ...values: any[]): Promise<number> {
              const result = await actual.$executeRawUnsafe(sql, ...values); await hook?.(sql); return result
            },
          }
          const result = await work(tx); await beforeCommit?.(); return result
        }, { isolationLevel: 'ReadCommitted', maxWait: 6000, timeout: 10000 })
      },
    })
    const secret = new SecretStoreService(prisma as never)
    const service = (db = host(), store = secret) => {
      // Real delegates preserve the legacy path for meaningful baseline controls.
      const s = new MicrosoftConsentService({ ...db, platformMicrosoftConnector: prisma.platformMicrosoftConnector } as never, store)
      ;(s as any).verifyTenantWithCredentials = async () => verified()
      return s
    }
    const state = async () => ({
      connectors: (await observer.query('SELECT * FROM platform_microsoft_connectors ORDER BY id')).rows,
      secrets: (await observer.query('SELECT * FROM encrypted_secrets ORDER BY id')).rows,
      revisions: (await observer.query('SELECT * FROM managed_connector_authority_revisions ORDER BY revision')).rows,
    })
    const reset = async () => { await observer.query('TRUNCATE platform_microsoft_connectors, encrypted_secrets, managed_connector_authority_revisions') }

    for (const seeded of [false, true]) for (const winner of ['A', 'B'] as const) {
      await t.test(`two captured ${seeded ? 'existing revision' : 'absent'} requests: ${winner} wins without loser writes`, async () => {
        await reset()
        if (seeded) await service().configureManagedConnector(input())
        const before = await state(), aInput = input(), bInput = { ...aInput, clientSecret: 'synthetic-different-content' }
        const enteredA = gate(), enteredB = gate(), releaseA = gate(), releaseB = gate()
        const a = service(), b = service()
        ;(a as any).verifyTenantWithCredentials = async () => { enteredA.resolve(); await releaseA.promise; return verified() }
        ;(b as any).verifyTenantWithCredentials = async () => { enteredB.resolve(); await releaseB.promise; return verified() }
        const pendingA = a.configureManagedConnector(aInput).then(value => ({ value }), error => ({ error }))
        const pendingB = b.configureManagedConnector(bInput).then(value => ({ value }), error => ({ error }))
        try {
          await Promise.all([enteredA.promise, enteredB.promise])
          // Independent DB authority work finishes while both verifiers are paused.
          assert.equal((await captureManagedAuthority(host()))?.configurationRevision ?? null,
            before.connectors[0]?.configuration_revision ?? null)
          ;(winner === 'A' ? releaseA : releaseB).resolve()
          const accepted = await (winner === 'A' ? pendingA : pendingB)
          assert.ok('value' in accepted)
          const winningState = await state()
          ;(winner === 'A' ? releaseB : releaseA).resolve()
          const rejected = await (winner === 'A' ? pendingB : pendingA)
          assert.ok('error' in rejected)
          assert.equal(rejected.error.getStatus(), 409)
          assert.deepEqual(await state(), winningState)
          assert.equal(winningState.secrets.length, before.secrets.length + 1)
          assert.equal(await secret.access(winningState.connectors[0].credential_reference), winner === 'A' ? aInput.clientSecret : bInput.clientSecret)
          assert.deepEqual(winningState.secrets.filter(row => before.secrets.some(old => old.id === row.id)), before.secrets)
        } finally { releaseA.resolve(); releaseB.resolve(); await Promise.all([pendingA, pendingB]) }
      })
    }
    await t.test('provider error, missing permission and sealing error leave all state unchanged', async () => {
      await reset(); await service().configureManagedConnector(input())
      for (const kind of ['provider', 'permission', 'sealing']) {
        const before = await state(), store = new SecretStoreService(prisma as never), s = service(host(), store)
        if (kind === 'sealing') store.prepareManagedRevision = () => { throw new Error('synthetic sealing fault') }
        else (s as any).verifyTenantWithCredentials = async () => {
          if (kind === 'provider') throw new Error('synthetic provider fault')
          return { ...verified(), missingRequiredPermissions: ['Organization.Read.All'] }
        }
        await assert.rejects(s.configureManagedConnector(input()))
        assert.deepEqual(await state(), before)
      }
    })
    for (const fault of ['secret', 'connector', 'commit']) await t.test(`rollback after ${fault} leaves connector, secret and registry unchanged`, async () => {
      await reset(); await service().configureManagedConnector(input()); const before = await state()
      let publishing = false, injected = false
      const db = host(async sql => {
        if (sql.includes('INSERT INTO encrypted_secrets')) publishing = true
        if ((fault === 'secret' && sql.includes('INSERT INTO encrypted_secrets')) ||
            (fault === 'connector' && sql.includes('INSERT INTO platform_microsoft_connectors'))) {
          injected = true; throw new Error('synthetic transaction fault')
        }
      }, async () => { if (fault === 'commit' && publishing) { injected = true; throw new Error('synthetic transaction fault') } })
      await assert.rejects(service(db).configureManagedConnector(input()), /synthetic transaction fault/)
      assert.equal(injected, true)
      assert.deepEqual(await state(), before)
    })
    await t.test('legacy reference remains readable; new reference is immutable and DTO reveals no secret', async () => {
      await reset()
      const old = input(), legacyReference = await secret.store('hawkview-microsoft-connector-client-secret', old.clientSecret, PLATFORM_OWNED)
      await prisma.platformMicrosoftConnector.create({ data: { id: 'default', clientId: old.clientId,
        homeTenantId: old.homeTenantId, credentialReference: legacyReference } })
      const before = await state(), next = input(), result = await service().configureManagedConnector(next)
      assert.deepEqual(result, { configured: true, clientId: next.clientId, homeTenantId: next.homeTenantId,
        credentialExpiresAt: next.credentialExpiresAt.toISOString(), verifiedOrganization: 'Synthetic organization' })
      const after = await state(), current = after.connectors[0], newSecret = after.secrets.find(row => row.id === current.configuration_revision)
      assert.ok(newSecret)
      assert.equal(newSecret.name, 'hawkview-managed-revision:' + current.configuration_revision)
      assert.equal(await secret.access(current.credential_reference), next.clientSecret)
      assert.equal(await secret.access(legacyReference), old.clientSecret)
      assert.deepEqual(after.secrets.find(row => row.id === before.secrets[0].id), before.secrets[0])
      // Actual access path authenticates the name; substitution cannot decrypt.
      await prisma.encryptedSecret.update({ where: { id: newSecret.id }, data: { name: 'hawkview-managed-revision:' + randomUUID() } })
      await assert.rejects(secret.access(current.credential_reference))
    })
    await t.test('legacy first-use upgrade preserves credentials and expiry; concurrent callers publish one immutable successor', async () => {
      await reset()
      const old = input(), reference = await secret.store('hawkview-microsoft-connector-client-secret', old.clientSecret, PLATFORM_OWNED)
      await prisma.platformMicrosoftConnector.create({ data: { id: 'default', clientId: old.clientId, homeTenantId: old.homeTenantId,
        credentialReference: reference, credentialExpiresAt: old.credentialExpiresAt } })
      const before = await state()
      await Promise.all([service().upgradeLegacyManagedConnector(), service().upgradeLegacyManagedConnector()])
      const after = await state(), current = after.connectors[0]
      assert.notEqual(current.configuration_revision, before.connectors[0].configuration_revision)
      assert.equal(current.credential_reference, 'encrypted-secret:' + current.configuration_revision)
      assert.equal(current.client_id, old.clientId); assert.equal(current.home_tenant_id, old.homeTenantId)
      assert.deepEqual(current.credential_expires_at, old.credentialExpiresAt)
      assert.equal(after.secrets.length, 2)
      assert.deepEqual(after.secrets.find(row => row.id === before.secrets[0].id), before.secrets[0])
      assert.equal(await secret.access(current.credential_reference), old.clientSecret)
      await service().upgradeLegacyManagedConnector()
      assert.deepEqual(await state(), after)
    })
    for (const fault of ['secret', 'authority', 'commit'] as const) await t.test('legacy first-use upgrade rolls back at ' + fault, async () => {
      await reset()
      const old = input(), reference = await secret.store('hawkview-microsoft-connector-client-secret', old.clientSecret, PLATFORM_OWNED)
      await prisma.platformMicrosoftConnector.create({ data: { id: 'default', clientId: old.clientId, homeTenantId: old.homeTenantId, credentialReference: reference } })
      const before = await state()
      const broken = host(async sql => {
        if ((fault === 'secret' && sql.startsWith('INSERT INTO encrypted_secrets')) ||
          (fault === 'authority' && sql.startsWith('INSERT INTO platform_microsoft_connectors'))) throw Error('injected upgrade failure')
      }, async () => { if (fault === 'commit') throw Error('injected upgrade failure') })
      await assert.rejects(service(broken).upgradeLegacyManagedConnector(), /injected upgrade failure/)
      assert.deepEqual(await state(), before)
    })
    await t.test('legacy source-row lock prevents a mutable writer racing the immutable copy', async () => {
      await reset()
      const old = input(), reference = await secret.store('hawkview-microsoft-connector-client-secret', old.clientSecret, PLATFORM_OWNED)
      await prisma.platformMicrosoftConnector.create({ data: { id: 'default', clientId: old.clientId, homeTenantId: old.homeTenantId, credentialReference: reference } })
      const entered = gate(), release = gate(), client = await pool.connect()
      let upgrade: Promise<void> | undefined, writer: Promise<pg.QueryResult> | undefined
      try {
        await client.query(`SET search_path TO ${schema},public`)
        await client.query("SET statement_timeout='5s'")
        const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        upgrade = service(host(async sql => { if (sql.includes('/* managed:legacy-secret */')) { entered.resolve(); await release.promise } })).upgradeLegacyManagedConnector()
        await Promise.race([entered.promise, upgrade.then(() => { throw Error('upgrade settled before source-row lock') })])
        writer = client.query('UPDATE encrypted_secrets SET name=$1 WHERE id=$2::uuid', ['changed-after-copy', reference.slice('encrypted-secret:'.length)])
        const failedWriter = writer.then(() => { throw Error('mutable writer was not blocked by source-row lock') })
        const deadline = Date.now() + 4000
        let blocked = false
        while (Date.now() < deadline) {
          blocked = (await Promise.race([observer.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid]), failedWriter])).rows[0].blocked
          if (blocked) break
          await new Promise(resolve => setTimeout(resolve, 5))
        }
        assert.ok(blocked, 'legacy writer must block until the immutable copy commits')
        release.resolve(); await upgrade; await writer
        const current = (await state()).connectors[0]
        assert.equal(await secret.access(current.credential_reference), old.clientSecret)
      } finally {
        release.resolve()
        await Promise.allSettled([upgrade, writer])
        client.release()
      }
    })
    await t.test('identical prepared operation replays only while current; changed content conflicts and replacement supersedes it', async () => {
      await reset()
      let prepared: PreparedManagedPublication | undefined
      const store = new SecretStoreService(prisma as never), prepare = store.prepareManagedRevision.bind(store), requested = input()
      store.prepareManagedRevision = (revision, value) => {
        const sealed = prepare(revision, value)
        prepared = { expectedRevision: null, operationId: '', revision, clientId: requested.clientId,
          homeTenantId: requested.homeTenantId, credentialExpiresAt: requested.credentialExpiresAt, sealed }
        return sealed
      }
      await service(host(), store).configureManagedConnector(requested)
      const committed = await state()
      assert.ok(prepared); prepared.operationId = committed.connectors[0].configuration_operation_id
      assert.equal((await publishManagedAuthority(host(), prepared)).status, 'replayed')
      assert.deepEqual(await state(), committed)
      assert.equal((await publishManagedAuthority(host(), { ...prepared, clientId: randomUUID() })).status, 'conflict')
      assert.deepEqual(await state(), committed)
      await service().configureManagedConnector(input()); const replacement = await state()
      assert.equal((await publishManagedAuthority(host(), prepared)).status, 'superseded')
      assert.deepEqual(await state(), replacement)
    })
  } finally {
    await prisma.$disconnect()
    if (created) await observer.query(`DROP SCHEMA ${schema} CASCADE`)
    observer.release(); await pool.end()
    envNames.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i] })
  }
})
