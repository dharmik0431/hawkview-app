import assert from 'node:assert/strict'
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
  const url = new URL(process.env.DATABASE_URL ?? '')
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
