import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { runRiskKeyOperator } from './risk-key-operator.js'
import { wrappedRiskName, WRAPPED_RISK_PROVIDER } from './wrapped-risk-crypto.js'

test('operator arguments/config fail closed before IO; dry-run and explicit confirmed apply stay separate', async () => {
  const scope = { environment: 'synthetic', organizationId: randomUUID(), customerTenantId: randomUUID() }
  const versionId = randomUUID()
  const argv = ['--environment', scope.environment, '--organization', scope.organizationId, '--tenant', scope.customerTenantId, '--version', versionId]
  const config = { DATABASE_URL: 'postgresql://synthetic.invalid/synthetic', SECRET_ENCRYPTION_KEY: '41'.repeat(32),
    HAWKVIEW_IDENTITY_RISK_MODE: 'shadow', HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-pilot-v1', HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: scope.environment,
    HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: JSON.stringify({ organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, expiresAt: new Date(Date.now() + 3600000).toISOString() }) }
  const previous = Object.fromEntries(Object.keys(config).map(name => [name, process.env[name]]))
  let reads = 0; let creates = 0
  const winner = { ...scope, id: randomUUID(), provider: WRAPPED_RISK_PROVIDER, immutableKeyId: '' }
  winner.immutableKeyId = wrappedRiskName(winner)
  const deps = { preflight: async () => { reads++; return { activeVersionId: null } }, create: async () => { creates++; return winner } }
  const apply = [...argv, '--apply', '--confirm-scope', `${scope.environment}/${scope.organizationId}/${scope.customerTenantId}/${versionId}`]
  Object.assign(process.env, config)
  try {
    for (const invalid of [[], ['--root', 'SECRET_SENTINEL'], [...argv, '--apply'], [...argv, '--apply', '--apply'],
      [...argv, '--version', versionId], [...argv, '--confirm-scope', 'SECRET_SENTINEL'], [...apply.slice(0,-1), 'wrong'],
      argv.map((x,i) => i === 7 ? '*' : x), argv.map((x,i) => i === 1 ? 'x'.repeat(257) : x), ['--help', 'x']]) {
      const result = await runRiskKeyOperator(invalid, deps)
      assert.equal(result.exitCode, 1); assert.equal(JSON.parse(result.output).code, 'INVALID_ARGUMENTS')
      assert.doesNotMatch(result.output, /SECRET_SENTINEL|postgresql|41{10}/)
    }
    assert.equal(reads, 0); assert.equal(creates, 0)
    for (const [name, value] of [['HAWKVIEW_IDENTITY_RISK_MODE','off'], ['HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER','managed-kms'],
      ['HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE','{}'], ['SECRET_ENCRYPTION_KEY','SECRET_SENTINEL'], ['DATABASE_URL','']]) {
      process.env[name!] = value
      assert.equal((await runRiskKeyOperator(argv, deps)).exitCode, 1)
      Object.assign(process.env, config)
    }
    assert.equal(reads, 0)
    assert.equal((await runRiskKeyOperator(argv.map((x,i) => i===5 ? randomUUID() : x), deps)).exitCode, 1)
    assert.equal(reads, 0)
    assert.equal((await runRiskKeyOperator(['--help'], deps)).exitCode, 0)
    const dry = JSON.parse((await runRiskKeyOperator(argv, deps)).output)
    assert.equal(dry.outcome, 'PREFLIGHT_OK'); assert.equal(dry.action, 'WOULD_CREATE'); assert.equal(creates, 0)
    const result = JSON.parse((await runRiskKeyOperator(apply, deps)).output)
    assert.equal(result.outcome, 'ENSURED'); assert.equal(result.requestedVersionId, versionId)
    assert.equal(result.activeVersionId, winner.id, 'A concurrent active winner is reported truthfully, never overwritten')
    assert.equal(creates, 1)
    const failure = await runRiskKeyOperator(apply, { ...deps, create: async () => { throw new Error('password=SECRET_SENTINEL postgresql://private') } })
    assert.deepEqual(JSON.parse(failure.output), { schemaVersion:1, outcome:'FAILED', code:'APPLY_UNCONFIRMED' })
    const before = creates
    assert.equal((await runRiskKeyOperator(apply, { ...deps, preflight: async () => { throw new Error('SECRET_SENTINEL') } })).exitCode, 1)
    assert.equal(creates, before)
    assert.equal((await runRiskKeyOperator(apply, { ...deps, preflight: async () => { delete process.env.HAWKVIEW_IDENTITY_RISK_MODE; return {activeVersionId:null} } })).exitCode, 1)
    assert.equal(creates, before, 'Config is rechecked after preflight')
  } finally { for (const [name,value] of Object.entries(previous)) { if(value===undefined) delete process.env[name]; else process.env[name]=value } }
})
