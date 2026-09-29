import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
test('actual Dashboard reports bounded critical counts and retains genuine evidence warnings', () => {
 const env={...process.env};delete env.NODE_TEST_CONTEXT
 const result=spawnSync(process.execPath,['--test','scripts/dashboard-kpi.test.cjs'],{cwd:process.cwd(),env,encoding:'utf8'})
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr)
})
