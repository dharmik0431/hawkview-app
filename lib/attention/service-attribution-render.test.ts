import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
test('mounted service badges, matrix drawer and complete overview remain evidence scoped', () => {
 const env={...process.env};delete env.NODE_TEST_CONTEXT
 const result=spawnSync(process.execPath,['--test','scripts/customer-evidence-consumers.test.cjs'],{cwd:process.cwd(),env,encoding:'utf8'})
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr)
})
