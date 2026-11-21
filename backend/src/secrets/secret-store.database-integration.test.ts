import assert from 'node:assert/strict'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PrismaService } from '../prisma/prisma.service.js'
import { SecretStoreService } from './secret-store.service.js'
import {
  CURRENT_KEY_VARIABLE,
  KEY_VERSION_VARIABLE,
  PREVIOUS_KEY_VARIABLE,
} from './secret-encryption-keys.js'
import { PLATFORM_OWNED } from './secret-owner.js'
import { TenantVisitLeaseLostError } from '../tenants/tenant-visit-lease-error.js'
import { releaseTenantVisitLease, tryAcquireTenantVisitLease } from '../tenants/tenant-visit-lease-store.js'
import type { Prisma } from '../generated/prisma/client.js'

/** The rotation, against a real database with the shipped migrations applied.
 *
 * WHY THIS FILE EXISTS SEPARATELY from `secret-store.service.test.ts`. That file
 * proves the crypto and the control flow against an in-memory stand-in, and a
 * stand-in cannot enforce a NOT NULL, a CHECK, or the absence of a column
 * default. The property this migration turns on — that a writer which forgets the
 * key version FAILS rather than being silently guessed for — exists only in
 * Postgres and is invisible to every double.
 *
 * It is also the check the work was asked for: decrypt both secrets before the
 * rotation and after it, against a disposable database, and confirm nothing
 * became unreadable.
 *
 * Gated like every other database test here. Run with a disposable local
 * cluster:
 *   HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS=1 DATABASE_URL=postgresql://...@127.0.0.1:5432/hawkview_test \
 *     npx tsx --test src/secrets/secret-store.database-integration.test.ts
 */

const skip = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1'
const registeredVisitCi = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1' &&
  process.env.HAWKVIEW_CI_DISPOSABLE_POSTGRES === '1' && process.env.GITHUB_ACTIONS === 'true'

const KEY_ONE = '11'.repeat(32)
const KEY_TWO = '22'.repeat(32)

function useKeys(configuration: { current: string; version?: string; previous?: string }) {
  process.env[CURRENT_KEY_VARIABLE] = configuration.current
  if (configuration.version === undefined) delete process.env[KEY_VERSION_VARIABLE]
  else process.env[KEY_VERSION_VARIABLE] = configuration.version
  if (configuration.previous === undefined) delete process.env[PREVIOUS_KEY_VARIABLE]
  else process.env[PREVIOUS_KEY_VARIABLE] = configuration.previous
}

function disposable() {
  const url = assertDisposableTestDatabase()
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'Disposable local/CI PostgreSQL only')
  // The host check alone is not enough: this suite's `finally` blocks DELETE,
  // so a developer whose local database is named `hawkview` rather than
  // `hawkview_test` would have it emptied by running the tests. Loopback-only
  // is strong right up until someone's laptop is the exception.
  //
  // Both assertions must refuse BEFORE any connection is opened — a guard that
  // rejected after connecting would already have run the DELETE.
  //
  // Same pattern as risk-assessment-connected.database-integration.test.ts:31;
  // an existing convention in this repo rather than a new one.
  assert.match(
    url.pathname,
    /test|qa|^\/hawkview_ci$/i,
    'Explicit test/QA or repository CI database only')
  return url
}

test('a rotation preserves every stored secret, against real Postgres',
  { skip, timeout: 30_000 }, async () => {
    disposable()
    const prisma = new PrismaService()
    await prisma.$connect()

    // Two secrets, mirroring what production holds: the connector client secret
    // and the consent-state signing key.
    const run = randomUUID().slice(0, 8)
    const names = [
      `test-${run}-connector-client-secret`,
      `test-${run}-consent-state-secret`,
    ]
    const values = ['client-secret-value-éß', 'consent-state-value']

    try {
      const service = new SecretStoreService(prisma)

      // BEFORE. Sealed under version 1, and readable.
      useKeys({ current: KEY_ONE })
      const references: string[] = []
      for (let index = 0; index < names.length; index += 1) {
        references.push(await service.store(names[index], values[index], PLATFORM_OWNED))
      }
      for (let index = 0; index < names.length; index += 1) {
        assert.equal(await service.access(references[index]), values[index],
          'a freshly stored secret must read back exactly')
      }

      // ROTATION WINDOW. New key current, old key still held.
      useKeys({ current: KEY_TWO, version: '2', previous: KEY_ONE })

      const pending = await service.rotationStatus()
      const ours = pending.secrets.filter((row) => names.includes(row.name))
      assert.equal(ours.length, 2)
      assert.equal(ours.every((row) => row.readable), true, 'both must still open')
      assert.equal(ours.every((row) => row.keyVersion === 1), true, 'neither is re-sealed yet')

      // AFTER. The values are identical, which is the whole claim.
      for (let index = 0; index < names.length; index += 1) {
        assert.equal(await service.access(references[index]), values[index],
          'ROTATION MUST NOT CHANGE OR DESTROY A STORED SECRET')
      }

      const resealed = await service.rotationStatus()
      const after = resealed.secrets.filter((row) => names.includes(row.name))
      assert.equal(after.every((row) => row.keyVersion === 2), true, 'reading should have re-sealed both')

      // THE OLD KEY IS NOW UNNECESSARY — the step that makes a rotation finished
      // rather than merely begun.
      useKeys({ current: KEY_TWO, version: '2' })
      for (let index = 0; index < names.length; index += 1) {
        assert.equal(await service.access(references[index]), values[index],
          'the previous key must no longer be required')
      }
    } finally {
      await prisma.encryptedSecret.deleteMany({ where: { name: { in: names } } })
      await prisma.$disconnect()
      useKeys({ current: KEY_ONE })
    }
  })

test('the database refuses a secret whose key version is not stated',
  { skip, timeout: 30_000 }, async () => {
    // THE PROPERTY NO DOUBLE CAN TEST. The migration adds the column with a
    // default and then drops it, so a writer that omits the version violates NOT
    // NULL instead of being silently labelled version 1 while sealed with another
    // key. That mislabelled row would be exactly as unreadable as an unlabelled
    // one, and would be found much later.
    const url = disposable()
    const client = new pg.Client({ connectionString: url.toString() })
    await client.connect()
    const name = `test-${randomUUID().slice(0, 8)}-no-version`
    try {
      await assert.rejects(
        () => client.query(
          `INSERT INTO encrypted_secrets (id, name, ciphertext, initialization_vector, authentication_tag, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, '\\x00', '\\x00', '\\x00', now(), now())`,
          [name]),
        (error: unknown) => {
          // 23502 is not_null_violation. Anything else means the column took a
          // default after all, and the safety property is gone.
          assert.equal((error as { code?: string }).code, '23502')
          return true
        })

      // POSITIVE CONTROL: the same insert WITH a version succeeds, so the
      // rejection above is about the missing version and not a broken statement.
      await client.query(
        `INSERT INTO encrypted_secrets (id, name, ciphertext, initialization_vector, authentication_tag, key_version, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, '\\x00', '\\x00', '\\x00', 1, now(), now())`,
        [name])

      // And a version below one is refused by the check constraint.
      await assert.rejects(
        () => client.query(
          `UPDATE encrypted_secrets SET key_version = 0 WHERE name = $1`, [name]),
        (error: unknown) => (error as { code?: string }).code === '23514')
    } finally {
      await client.query('DELETE FROM encrypted_secrets WHERE name = $1', [name])
      await client.end()
    }
  })

test('physical owned credential reseal rejects takeover after read and retains its lease lock through atomic rotation', {
  skip: !registeredVisitCi, concurrency: false, timeout: 60_000,
}, async context => {
  assert.equal(assertDisposableTestDatabase().port, '5432')
  const savedKeys = Object.fromEntries([CURRENT_KEY_VARIABLE, KEY_VERSION_VARIABLE, PREVIOUS_KEY_VARIABLE]
    .map(key => [key, process.env[key]]))
  const writer = new PrismaService(), observer = new PrismaService()
  const name = `test-visit-reseal-${randomUUID()}`
  let organizationId: string | undefined
  context.after(async () => {
    try {
      await observer.encryptedSecret.deleteMany({ where: { name } })
      if (organizationId) await observer.organization.deleteMany({ where: { id: organizationId } })
    } finally {
      await Promise.all([writer.$disconnect(), observer.$disconnect()])
      for (const [key, value] of Object.entries(savedKeys)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
  await Promise.all([writer.$connect(), observer.$connect()])
  const organization = await writer.organization.create({ data: { name: 'Credential reseal visit CI', slug: name } })
  organizationId = organization.id
  const tenant = await writer.customerTenant.create({ data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' } })
  const scope = { organizationId, customerTenantId: tenant.id }
  const owner = await tryAcquireTenantVisitLease(writer, scope, 300_000)
  assert.ok(owner)
  useKeys({ current: KEY_ONE })
  const service = new SecretStoreService(writer)
  const reference = await service.store(name, 'synthetic-visit-credential', PLATFORM_OWNED)
  const readSecret = () => observer.encryptedSecret.findUniqueOrThrow({ where: { name } })
  const before = await readSecret()
  useKeys({ current: KEY_TWO, version: '2', previous: KEY_ONE })
  let successor: NonNullable<Awaited<ReturnType<typeof tryAcquireTenantVisitLease>>> | undefined
  const displacedDatabase = new Proxy(writer, { get(target, property) {
    if (property === 'encryptedSecret') return new Proxy(target.encryptedSecret, { get(delegate, method) {
      if (method === 'findUnique') return async (args: Prisma.EncryptedSecretFindUniqueArgs) => {
        const secret = await delegate.findUnique(args)
        assert.equal(await releaseTenantVisitLease(observer, owner), true)
        const acquired = await tryAcquireTenantVisitLease(observer, scope, 300_000)
        assert.ok(acquired)
        successor = acquired
        return secret
      }
      const value = Reflect.get(delegate, method)
      return typeof value === 'function' ? value.bind(delegate) : value
    } })
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  await assert.rejects(new SecretStoreService(displacedDatabase).access(reference, owner), TenantVisitLeaseLostError)
  assert.deepEqual(await readSecret(), before, 'stale visit changes no seal bytes, version or update timestamp')
  assert.ok(successor)
  let observedReseal = false
  const rollbackDatabase = new Proxy(writer, { get(target, property) {
    if (property === '$transaction') return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      writer.$transaction(async transaction => {
        await work(transaction)
        assert.equal((await transaction.encryptedSecret.findUniqueOrThrow({ where: { name } })).keyVersion, 2)
        assert.deepEqual(await readSecret(), before, 'reseal remains invisible until its guarded transaction commits')
        await assert.rejects(observer.$transaction(tx => tx.$queryRawUnsafe(
          'SELECT generation FROM tenant_sync_visit_leases WHERE customer_tenant_id=$1::uuid FOR UPDATE NOWAIT', tenant.id,
        )), (error: unknown) => /55P03|could not obtain lock/i.test(String(error)))
        observedReseal = true
        throw new Error('Synthetic failure after guarded reseal')
      }, { timeout: 20_000 })
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  assert.equal(await new SecretStoreService(rollbackDatabase).access(reference, successor), 'synthetic-visit-credential',
    'ordinary storage failure preserves the existing successful-read policy')
  assert.equal(observedReseal, true)
  assert.deepEqual(await readSecret(), before, 'failed transaction rolls the ciphertext and version back together')
  assert.equal(await service.access(reference, successor), 'synthetic-visit-credential')
  assert.equal((await readSecret()).keyVersion, 2)
  useKeys({ current: KEY_TWO, version: '2' })
  assert.equal(await service.access(reference, successor), 'synthetic-visit-credential', 'the successor completes rotation without changing plaintext')
})
