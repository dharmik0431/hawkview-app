import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { captureManagedAuthority, publishManagedAuthority, withManagedAuthority,
  type AuthorityDatabase, type AuthorityTransaction, type PreparedManagedPublication } from './managed-connector-authority.js'

const skip = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1'
function request(expectedRevision: string | null = null): PreparedManagedPublication {
  return { expectedRevision, revision: randomUUID(), operationId: randomUUID(), clientId: randomUUID(),
    homeTenantId: randomUUID(), credentialExpiresAt: null, sealed: { ciphertext: Buffer.from('synthetic-seal'),
      initializationVector: Buffer.alloc(12), authenticationTag: Buffer.alloc(16), keyVersion: 1 } }
}
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

test('managed authority physical transactions', { skip, timeout: 30000 }, async t => {
  const url = assertDisposableTestDatabase()
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 })
  const schema = 'authority_test_' + randomUUID().replaceAll('-', '')
  const observer = await pool.connect()
  await observer.query(`CREATE SCHEMA ${schema}`)
  await observer.query(`SET search_path TO ${schema}`)
  // Minimal real pre-migration tables. Full-chain replay is a separate release check.
  await observer.query(`CREATE TABLE platform_microsoft_connectors (
    id varchar(32) PRIMARY KEY DEFAULT 'default', client_id uuid NOT NULL, home_tenant_id uuid NOT NULL,
    credential_reference varchar(500) NOT NULL, credential_expires_at timestamptz,
    configured_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL);
    CREATE TABLE encrypted_secrets (id uuid PRIMARY KEY, name varchar(200) UNIQUE NOT NULL,
    ciphertext bytea NOT NULL, initialization_vector bytea NOT NULL, authentication_tag bytea NOT NULL,
    key_version integer NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);`)
  const migration = await readFile(new URL('../../prisma/migrations/20261002050000_managed_connector_authority/migration.sql', import.meta.url), 'utf8')
  await observer.query(migration)
  const host = (hook?: (query: string) => Promise<void>, beforeCommit?: () => Promise<void>): AuthorityDatabase => ({
    async $transaction<T>(work: (tx: AuthorityTransaction) => Promise<T>, options?: { isolationLevel: 'ReadCommitted' }) {
      assert.equal(options?.isolationLevel, 'ReadCommitted')
      const client = await pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        await client.query(`SET LOCAL search_path TO ${schema}`)
        await client.query("SET LOCAL statement_timeout = '5s'")
        const tx: AuthorityTransaction = {
          async $queryRawUnsafe<T>(query: string, ...values: any[]): Promise<T> {
            const result = await client.query(query, values)
            await hook?.(query)
            return result.rows as T
          },
          async $executeRawUnsafe(query: string, ...values: any[]): Promise<number> {
            const result = await client.query(query, values)
            await hook?.(query)
            return result.rowCount ?? 0
          },
        }
        const result = await work(tx)
        await beforeCommit?.()
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
  })
  const db = host()
  const reset = async () => { await observer.query('TRUNCATE platform_microsoft_connectors, encrypted_secrets, managed_connector_authority_revisions') }
  const state = async () => ({ connector: (await observer.query('SELECT * FROM platform_microsoft_connectors')).rows,
    secrets: (await observer.query('SELECT * FROM encrypted_secrets ORDER BY id')).rows,
    revisions: (await observer.query('SELECT * FROM managed_connector_authority_revisions ORDER BY revision')).rows })
  const waitForAdvisoryWait = async () => {
    const until = Date.now() + 3000
    while (Date.now() < until) {
      const result = await observer.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
        AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())`)
      if (result.rowCount) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('expected actual advisory lock waiter')
  }
  try {
    await t.test('absent-row publication races: one coherent winner and no loser secret', async () => {
      const entered = gate(), release = gate()
      const first = request(), second = request()
      const a = publishManagedAuthority(host(async query => {
        if (query.includes('pg_advisory_xact_lock(')) { entered.resolve(); await release.promise }
      }), first)
      await entered.promise
      const b = publishManagedAuthority(db, second)
      try { await waitForAdvisoryWait() } finally { release.resolve() }
      assert.equal((await a).status, 'published')
      assert.equal((await b).status, 'superseded')
      assert.equal((await state()).secrets.length, 1)
      assert.equal((await captureManagedAuthority(db))?.configurationRevision, first.revision)
    })
    await t.test('replay, conflicts, stale CAS, immutable replacement and no revision ABA', async () => {
      await reset()
      const a = request()
      assert.equal((await publishManagedAuthority(db, a)).status, 'published')
      const initial = await state()
      assert.equal((await publishManagedAuthority(db, a)).status, 'replayed')
      assert.deepEqual(await state(), initial)
      for (const altered of [
        { ...a, clientId: randomUUID() }, { ...a, homeTenantId: randomUUID() },
        { ...a, revision: randomUUID() }, { ...a, expectedRevision: randomUUID() },
        { ...a, credentialExpiresAt: new Date('2030-01-01T00:00:00Z') },
        ...['ciphertext', 'initializationVector', 'authenticationTag'].map(key => ({ ...a,
          sealed: { ...a.sealed, [key]: Buffer.alloc(a.sealed[key as 'ciphertext'].length, 1) } })),
        { ...a, sealed: { ...a.sealed, keyVersion: 2 } },
      ]) assert.equal((await publishManagedAuthority(db, altered)).status, 'conflict')
      assert.deepEqual(await state(), initial)
      const b = { ...request(a.revision), clientId: a.clientId, homeTenantId: a.homeTenantId }
      assert.equal((await publishManagedAuthority(db, b)).status, 'published')
      const next = await state()
      assert.deepEqual(next.secrets.find(row => row.id === a.revision), initial.secrets[0])
      assert.equal((await publishManagedAuthority(db, a)).status, 'superseded')
      assert.equal((await publishManagedAuthority(db, request(a.revision))).status, 'superseded')
      assert.equal((await publishManagedAuthority(db, { ...request(b.revision), revision: a.revision })).status, 'conflict')
      assert.deepEqual(await state(), next)
      let ran = false
      assert.equal((await withManagedAuthority(db, a.revision, async () => { ran = true })).status, 'superseded')
      assert.equal(ran, false)
    })
    for (const point of ['secret', 'connector', 'commit']) {
      await t.test(`rollback after ${point} preserves old authority and releases locks`, async () => {
        await reset()
        const a = request(); await publishManagedAuthority(db, a)
        const initial = await state()
        const fail = async () => { throw new Error('synthetic rollback') }
        const failureHost = host(async query => {
          if ((point === 'secret' && query.includes('INSERT INTO encrypted_secrets')) ||
              (point === 'connector' && query.includes('INSERT INTO platform_microsoft_connectors'))) await fail()
        }, point === 'commit' ? fail : undefined)
        await assert.rejects(publishManagedAuthority(failureHost, request(a.revision)), /synthetic rollback/)
        assert.deepEqual(await state(), initial)
        assert.equal((await publishManagedAuthority(db, request(a.revision))).status, 'published')
      })
    }
    await t.test('shared readers coexist and retain authority through callback commit', async () => {
      await reset()
      const a = request(); await publishManagedAuthority(db, a)
      const entered = gate(), release = gate()
      const reader = withManagedAuthority(db, a.revision, async () => { entered.resolve(); await release.promise; return 'done' })
      await entered.promise
      assert.equal((await captureManagedAuthority(db))?.configurationRevision, a.revision)
      const b = request(a.revision), writer = publishManagedAuthority(db, b)
      try { await waitForAdvisoryWait() } finally { release.resolve() }
      assert.deepEqual(await reader, { status: 'current', value: 'done' })
      assert.equal((await writer).status, 'published')
    })
    await t.test('bootstrap exclusive lock hides uncommitted config from capture', async () => {
      await reset()
      const entered = gate(), release = gate()
      const writer = publishManagedAuthority(host(undefined, async () => {
        entered.resolve(); await release.promise; throw new Error('synthetic rollback')
      }), request())
      // Attach rejection handler before releasing the transaction.
      const rejected = assert.rejects(writer, /synthetic rollback/)
      await entered.promise
      const reader = captureManagedAuthority(db)
      try { await waitForAdvisoryWait() } finally { release.resolve() }
      await rejected
      assert.equal(await reader, null)
      assert.equal((await state()).secrets.length, 0)
    })
    await t.test('publication fingerprint snapshots mutable caller buffers before waiting', async () => {
      await reset()
      const entered = gate(), release = gate(), a = request()
      const original = Buffer.from(a.sealed.ciphertext)
      const pending = publishManagedAuthority(host(async query => {
        if (query.includes('pg_advisory_xact_lock(')) { entered.resolve(); await release.promise }
      }), a)
      await entered.promise
      a.sealed.ciphertext.fill(42)
      release.resolve()
      assert.equal((await pending).status, 'published')
      assert.deepEqual((await state()).secrets[0].ciphertext, original)
      assert.equal((await publishManagedAuthority(db, { ...a, sealed: { ...a.sealed, ciphertext: original } })).status, 'replayed')
    })
    await t.test('legacy revision without an immutable secret cannot be reused after replacement', async () => {
      await reset()
      const legacy = randomUUID()
      await observer.query(`INSERT INTO platform_microsoft_connectors
        (configuration_revision, client_id, home_tenant_id, credential_reference, updated_at)
        VALUES ($1, $2, $3, 'legacy-synthetic-reference', now())`, [legacy, randomUUID(), randomUUID()])
      const next = request(legacy)
      assert.equal((await publishManagedAuthority(db, next)).status, 'published')
      assert.equal((await publishManagedAuthority(db, { ...request(next.revision), revision: legacy })).status, 'conflict')
    })
    await t.test('migration rejects half-shaped publication metadata', async () => {
      await assert.rejects(observer.query('UPDATE platform_microsoft_connectors SET publication_fingerprint = NULL'), /managed_connector_publication_shape/)
      await assert.rejects(observer.query('UPDATE platform_microsoft_connectors SET configuration_operation_id = NULL'), /managed_connector_publication_shape/)
      await assert.rejects(observer.query("UPDATE platform_microsoft_connectors SET publication_fingerprint = 'invalid'"), /managed_connector_publication_shape/)
    })
  } finally {
    await observer.query(`DROP SCHEMA ${schema} CASCADE`)
    observer.release()
    await pool.end()
  }
})
