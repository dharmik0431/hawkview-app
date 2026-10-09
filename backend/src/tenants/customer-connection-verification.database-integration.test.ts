import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import type { AuthorityDatabase, AuthorityTransaction } from '../microsoft/managed-connector-authority.js'
import { captureCustomerConnectionVerification, publishCustomerConnectionVerification,
  CustomerConnectionVerificationSuperseded } from './customer-connection-verification-store.js'

const skip = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1'

test('customer verification actual SQL revision CAS and transaction rollback', { skip, timeout: 60000 }, async t => {
  const url = assertDisposableTestDatabase()
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 5000 })
  const schema = 'customer_verification_' + randomUUID().replaceAll('-', '')
  const who = { organizationId: randomUUID(), customerTenantId: randomUUID(), microsoftTenantId: randomUUID() }
  const connectionId = randomUUID(), clientId = randomUUID(), incarnation = randomUUID()
  const published = { outcome: 'verified' as const, displayName: 'Verified customer', primaryDomain: 'customer.invalid',
    grantedPermissions: ['Organization.Read.All'], missingRequiredPermissions: [] }
  const events: Array<{ tag: string; count: number | null }> = []
  const host: AuthorityDatabase = {
    async $transaction<T>(work: (tx: AuthorityTransaction) => Promise<T>, options?: { isolationLevel: 'ReadCommitted' }): Promise<T> {
      assert.deepEqual(options, { isolationLevel: 'ReadCommitted' })
      const client = await pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        await client.query(`SET LOCAL search_path TO ${schema},public`)
        await client.query("SET LOCAL TimeZone='UTC'")
        await client.query("SET LOCAL DateStyle='ISO, MDY'")
        await client.query("SET LOCAL statement_timeout='5s'")
        await client.query("SET LOCAL lock_timeout='5s'")
        const tx: AuthorityTransaction = {
          async $queryRawUnsafe<R>(sql: string, ...values: any[]): Promise<R> {
            assert.doesNotMatch(sql, /advisory|DIRECTORY_ROLES|platform_microsoft_connectors/)
            const result = await client.query(sql, values)
            events.push({ tag: sql.match(/customer-fence:[a-z-]+/)?.[0] ?? 'unknown', count: result.rowCount })
            return result.rows as R
          },
          async $executeRawUnsafe(sql: string, ...values: any[]) {
            assert.doesNotMatch(sql, /advisory|DIRECTORY_ROLES|platform_microsoft_connectors/)
            const result = await client.query(sql, values)
            events.push({ tag: sql.match(/customer-fence:[a-z-]+/)?.[0] ?? 'unknown', count: result.rowCount })
            return result.rowCount ?? 0
          },
        }
        const result = await work(tx)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
  }
  let observer: pg.PoolClient | undefined
  try {
    observer = await pool.connect()
    await observer.query(`CREATE SCHEMA ${schema}`)
    await observer.query(`SET search_path TO ${schema},public`)
    // Actual migrated tables and enum types; no fixture reimplementation of publication SQL.
    for (const table of ['customer_tenants', 'tenant_connections']) {
      await observer.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`)
    }
    const reset = async () => {
      await observer!.query(`TRUNCATE ${schema}.tenant_connections, ${schema}.customer_tenants`)
      await observer!.query(`INSERT INTO customer_tenants
        (id,organization_id,microsoft_tenant_id,status,display_name,updated_at)
        VALUES($1,$2,$3,'ACTIVE','Before','2026-10-07 01:59:00.123456+00')`,
      [who.customerTenantId, who.organizationId, who.microsoftTenantId])
      await observer!.query(`INSERT INTO tenant_connections
        (id,organization_id,customer_tenant_id,status,connection_mode,client_id,credential_reference,
         collection_incarnation,consented_permissions,updated_at)
        VALUES($1,$2,$3,'CONNECTED','CUSTOMER_MANAGED',$4,'synthetic-customer-reference',$5,$6,'2026-10-07 02:00:00.654321+00')`,
      [connectionId, who.organizationId, who.customerTenantId, clientId, incarnation, ['Old.Read', 'Exchange.ManageAsAppV2']])
      events.length = 0
    }
    const snapshot = async () => ({
      tenant: (await observer!.query('SELECT to_jsonb(t) AS row FROM customer_tenants t')).rows,
      connection: (await observer!.query('SELECT to_jsonb(c) AS row FROM tenant_connections c')).rows,
    })
    const capture = async () => {
      const result = await captureCustomerConnectionVerification(host, who)
      assert.ok(result)
      return result
    }

    await t.test('clean captured success applies actual SQL and preserves incarnation and optional grant', async () => {
      await reset()
      const captured = await capture()
      assert.match(captured.tenant.revision, /\.123456\+00$/)
      assert.match(captured.connection.revision, /\.654321\+00$/)
      assert.deepEqual(await publishCustomerConnectionVerification(host, captured, published), { connected: true })
      const state = await snapshot(), tenant = state.tenant[0].row, connection = state.connection[0].row
      assert.equal(tenant.status, 'ACTIVE'); assert.equal(tenant.display_name, 'Verified customer')
      assert.equal(connection.status, 'CONNECTED'); assert.deepEqual(connection.consented_permissions, ['Organization.Read.All', 'Exchange.ManageAsAppV2'])
      assert.equal(connection.collection_incarnation, incarnation)
      assert.ok(connection.last_verified_at); assert.equal(connection.last_error_code, null)
      assert.deepEqual(events.map(event => event.tag), [
        'customer-fence:tenant-lock', 'customer-fence:connection-lock',
        'customer-fence:tenant-lock', 'customer-fence:connection-lock',
        'customer-fence:publish-connection', 'customer-fence:publish-tenant',
      ])
    })

    await t.test('connection revision-only conflict affects zero rows and never issues tenant CAS', async () => {
      await reset(); const captured = await capture()
      await observer!.query("UPDATE tenant_connections SET updated_at=updated_at+interval '1 microsecond'")
      const newer = await snapshot()
      await assert.rejects(() => publishCustomerConnectionVerification(host, captured, published), CustomerConnectionVerificationSuperseded)
      assert.deepEqual(await snapshot(), newer)
      assert.equal(events.find(event => event.tag === 'customer-fence:publish-connection')?.count, 0)
      assert.equal(events.some(event => event.tag === 'customer-fence:publish-tenant'), false)
    })

    await t.test('tenant revision conflict rolls back the already matched connection write', async () => {
      await reset(); const captured = await capture()
      await observer!.query("UPDATE customer_tenants SET updated_at=updated_at+interval '1 microsecond'")
      const newer = await snapshot()
      await assert.rejects(() => publishCustomerConnectionVerification(host, captured, published), CustomerConnectionVerificationSuperseded)
      assert.deepEqual(events.filter(event => event.tag.startsWith('customer-fence:publish-')), [
        { tag: 'customer-fence:publish-connection', count: 1 }, { tag: 'customer-fence:publish-tenant', count: 0 },
      ])
      assert.deepEqual(await snapshot(), newer)
    })

    for (const [name, sql, values] of [
      ['organization', 'UPDATE customer_tenants SET organization_id=$1', [randomUUID()]],
      ['Microsoft tenant', 'UPDATE customer_tenants SET microsoft_tenant_id=$1', [randomUUID()]],
      ['tenant identity', 'UPDATE customer_tenants SET id=$1', [randomUUID()]],
      ['disconnected', "UPDATE customer_tenants SET status='DISCONNECTED'", []],
      ['revoked', "UPDATE tenant_connections SET status='REVOKED'", []],
      ['mode', "UPDATE tenant_connections SET connection_mode='HAWKVIEW_MANAGED'", []],
    ] as const) await t.test(`changed ${name} rejects without changing newer stored rows`, async () => {
      await reset(); const captured = await capture()
      await observer!.query(sql, [...values])
      const newer = await snapshot()
      await assert.rejects(() => publishCustomerConnectionVerification(host, captured, published), CustomerConnectionVerificationSuperseded)
      assert.deepEqual(await snapshot(), newer)
      assert.equal(events.some(event => event.tag.startsWith('customer-fence:publish-')), false)
    })

    await t.test('two captured operations race and only one can publish', async () => {
      await reset()
      const first = await capture(), second = await capture()
      const results = await Promise.allSettled([
        publishCustomerConnectionVerification(host, first, published),
        publishCustomerConnectionVerification(host, second, { ...published, displayName: 'Other verification' }),
      ])
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
      const rejected = results.find(result => result.status === 'rejected')
      assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof CustomerConnectionVerificationSuperseded)
      assert.equal(events.filter(event => event.tag === 'customer-fence:publish-connection' && event.count === 1).length, 1)
      assert.equal(events.filter(event => event.tag === 'customer-fence:publish-tenant' && event.count === 1).length, 1)
      const state = await snapshot()
      assert.equal(state.connection[0].row.status, 'CONNECTED')
      assert.ok(['Verified customer', 'Other verification'].includes(state.tenant[0].row.display_name))
    })
  } finally {
    try { if (observer) await observer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) }
    finally { observer?.release(); await pool.end() }
  }
})
