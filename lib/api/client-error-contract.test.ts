import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const client = readFileSync(new URL('./client.ts', import.meta.url), 'utf8')

test('API client preserves a backend-issued safe error code separately from its message', () => {
  assert.match(client, /public code: string \| null = null/)
  assert.match(client, /typeof body\?\.error\?\.code === 'string'/)
  assert.match(client, /typeof body\?\.code === 'string'/)
})
