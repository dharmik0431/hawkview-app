import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('actual tenant page deferred requests preserve tenant/account scope and report request completion separately', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      fileURLToPath(
        new URL('../scripts/tenant-workspace-request.test.cjs', import.meta.url)
      ),
    ],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    }
  )
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  for (const outcome of ['failed', 'partial', 'unknown']) {
    assert.ok(
      result.stdout.includes(`PASS actual deferred POST returning ${outcome}`),
      result.stdout
    )
  }
})
