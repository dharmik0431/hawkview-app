import assert from 'node:assert/strict'
import test from 'node:test'
import { createAdapter } from './prisma.service.js'

test('the API adapter bounds its actual pg pool without opening a database connection', async () => {
  const adapter = createAdapter('postgresql://test:test@127.0.0.1:1/test')
  const connection = await adapter.connect()

  try {
    const pool = connection.underlyingDriver()
    assert.equal(pool.options.max, 3)
    assert.equal(pool.totalCount, 0)
  } finally {
    await connection.dispose()
  }
})
