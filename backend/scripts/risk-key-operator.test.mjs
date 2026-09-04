import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('built operator exits safely without config, arguments, secrets or startup side effects', () => {
  const entry = fileURLToPath(new URL('../dist/provision-risk-key.js', import.meta.url))
  const scope = ['--environment','synthetic','--organization','00000000-0000-0000-0000-000000000001',
    '--tenant','00000000-0000-0000-0000-000000000002','--version','00000000-0000-0000-0000-000000000003']
  for (const [args, code] of [[['--help'],0], [[],1], [scope,1], [['--password','PRIVATE_SENTINEL'],1]]) {
    const result = spawnSync(process.execPath, [entry,...args], { encoding:'utf8', timeout:5000, maxBuffer:65536,
      env: { SYSTEMROOT:process.env.SYSTEMROOT, PATH:process.env.PATH } })
    assert.ifError(result.error); assert.equal(result.status,code); assert.equal(result.signal,null)
    assert.equal(result.stderr,''); assert.equal(result.stdout.trim().split('\n').length,1)
    assert.equal(JSON.parse(result.stdout).schemaVersion,1)
    assert.doesNotMatch(result.stdout,/PRIVATE_SENTINEL|Nest|postgresql|password|SECRET_ENCRYPTION_KEY/)
  }
})
