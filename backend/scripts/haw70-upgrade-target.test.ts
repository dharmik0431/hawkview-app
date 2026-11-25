import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { Socket, Server } from 'node:net'
import { syncBuiltinESMExports } from 'node:module'
import { inspect } from 'node:util'
import test from 'node:test'
import { assertDisposableTestDatabase } from '../src/prisma/native-alert-test-database.js'
import { inspectHaw70UpgradeTarget } from './haw70-upgrade-target.js'

const candidate = '1'.repeat(40)
const environment = Object.freeze({
  CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
  GITHUB_REPOSITORY: 'dharmik0431/hawkview-app', GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_API_URL: 'https://api.github.com', GITHUB_WORKFLOW: 'Required quality gates',
  GITHUB_JOB: 'backend-quality', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch',
  GITHUB_REF: 'refs/heads/codex/synthetic-upgrade',
  GITHUB_WORKFLOW_REF: 'dharmik0431/hawkview-app/.github/workflows/quality-gates.yml@refs/heads/codex/synthetic-upgrade',
  GITHUB_SHA: candidate, GITHUB_WORKFLOW_SHA: candidate, GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
  HAWKVIEW_CI_MIGRATION_PROFILE: 'haw70-upgrade', HAWKVIEW_RUN_HAW70_UPGRADE: '1',
  HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: '1', HAWKVIEW_CI_DISPOSABLE_POSTGRES: '1', TZ: 'UTC',
  HAWKVIEW_HAW70_TENANT_DELETE_WITNESS: '1', HAWKVIEW_HAW70_AUDIT_WRITER_WITNESS: '1',
  HAWKVIEW_HAW70_DELETE_LOCK_ORDER_WITNESS: '1',
  DATABASE_URL: 'postgresql://hawkview_ci:hawkview_ci@127.0.0.1:5432/hawkview_ci',
})
const check = (overrides: Record<string, string | undefined> = {}) => inspectHaw70UpgradeTarget({
  environment: { ...environment, ...overrides }, expectedCandidateCommit: candidate,
})
const refusal = /HAW-70 upgrade context or target is not qualified/

test('exact synthetic hosted claims return immutable non-executable, credential-free metadata', () => {
  const input = { environment, expectedCandidateCommit: candidate }
  const before = JSON.stringify(input)
  const result = inspectHaw70UpgradeTarget(input)
  assert.equal(result.claimsMatchProposedProfile, true)
  assert.equal(result.executionAllowed, false)
  assert.equal(result.candidateCommit, candidate)
  assert.deepEqual(result.target, { host: '127.0.0.1', port: 5432, database: 'hawkview_ci', user: 'hawkview_ci' })
  assert.equal(result.runId, '12345')
  assert.equal(result.runAttempt, '1')
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.target))
  assert.throws(() => { (result as { executionAllowed: boolean }).executionAllowed = true }, TypeError)
  assert.ok(!JSON.stringify(result).includes('postgresql://'))
  assert.equal(JSON.stringify(input), before)
})

test('every required context field fails closed when missing or changed', () => {
  for (const key of Object.keys(environment)) {
    for (const value of [undefined, '', 'not-the-registered-value']) {
      assert.throws(() => check({ [key]: value }), refusal, key)
    }
  }
})

test('fresh, unknown and non-dispatch profile requests never select the upgrade', () => {
  for (const value of ['fresh', 'HAW70-UPGRADE', ' haw70-upgrade', 'haw70-upgrade\n', 'upgrade']) {
    assert.throws(() => check({ HAWKVIEW_CI_MIGRATION_PROFILE: value }), refusal)
  }
  for (const value of ['pull_request', 'pull_request_target', 'push', 'schedule', 'workflow_call']) {
    assert.throws(() => check({ GITHUB_EVENT_NAME: value }), refusal)
  }
  for (const value of ['true', '0', ' 1', '1\n']) {
    assert.throws(() => check({ HAWKVIEW_RUN_HAW70_UPGRADE: value }), refusal)
  }
})

test('expected candidate is mandatory and must match both workflow and checkout claims', () => {
  for (const sha of ['', 'HEAD', '1'.repeat(39), 'A'.repeat(40), `${candidate}\n`, '2'.repeat(40)]) {
    assert.throws(() => inspectHaw70UpgradeTarget({ environment, expectedCandidateCommit: sha }), refusal)
  }
  assert.throws(() => check({ GITHUB_SHA: '2'.repeat(40) }), refusal)
  assert.throws(() => check({ GITHUB_WORKFLOW_SHA: '2'.repeat(40) }), refusal)
  for (const value of [undefined, null, {}, [], { environment },
    { environment, expectedCandidateCommit: candidate, approved: true }]) {
    assert.throws(() => inspectHaw70UpgradeTarget(value as never), refusal)
  }
})

test('workflow identity, branch reference and run identifiers must agree exactly', () => {
  for (const ref of ['refs/tags/v1', 'refs/pull/1/merge', 'refs/heads/', 'refs/heads/a..b',
    'refs/heads/a//b', 'refs/heads/.hidden', 'refs/heads/a.lock', 'refs/heads/a/..', 'refs/heads/a\n']) {
    assert.throws(() => check({ GITHUB_REF: ref,
      GITHUB_WORKFLOW_REF: `dharmik0431/hawkview-app/.github/workflows/quality-gates.yml@${ref}` }), refusal)
  }
  for (const ref of ['other/repo/.github/workflows/quality-gates.yml@refs/heads/codex/synthetic-upgrade',
    'dharmik0431/hawkview-app/.github/workflows/other.yml@refs/heads/codex/synthetic-upgrade',
    'dharmik0431/hawkview-app/.github/workflows/quality-gates.yml@refs/heads/other']) {
    assert.throws(() => check({ GITHUB_WORKFLOW_REF: ref }), refusal)
  }
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    for (const value of ['0', '-1', '01', '1.0', '1e3', '1\n', '9'.repeat(21)]) {
      assert.throws(() => check({ [key]: value }), refusal)
    }
  }
})

test('the shared local fixture allowance cannot authorize this hosted-only profile', () => {
  const local = { ...environment, DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:55432/hv_qa_upgrade' }
  assert.equal(assertDisposableTestDatabase(local, { requireUtc: true }).port, '55432')
  assert.throws(() => inspectHaw70UpgradeTarget({ environment: local, expectedCandidateCommit: candidate }), refusal)
  const justLocal = { TZ: 'UTC', HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: '1', DATABASE_URL: environment.DATABASE_URL }
  assert.throws(() => inspectHaw70UpgradeTarget({ environment: justLocal, expectedCandidateCommit: candidate }), refusal)
})

test('exact service URL refuses aliases, normalization, credentials and routing suffixes', () => {
  const url = environment.DATABASE_URL
  const changed = [url.replace('127.0.0.1', 'localhost'), url.replace('127.0.0.1', '[::1]'),
    url.replace('127.0.0.1', 'database.invalid'), url.replace('5432', '55432'), url.replace(':5432', ''),
    url.replace('postgresql:', 'postgres:'), url.replace('postgresql:', 'https:'),
    url.replace('/hawkview_ci', '/production'), url.replace('hawkview_ci:', 'other:'),
    url.replace(':hawkview_ci@', ':other@'), url.replace('127.0.0.1', '%31%32%37.0.0.1'),
    ` ${url}`, `${url}\n`, `${url}/`, 'postgresql://fixture:secret@[invalid']
  for (const suffix of ['?', '#', '?host=database.invalid', '?%68ost=database.invalid',
    '?options=-csearch_path%3Dother', '?schema=public', '?service=other', '#ignored']) changed.push(url + suffix)
  for (const value of changed) assert.throws(() => check({ DATABASE_URL: value }), refusal)
})

test('ambient PG, Prisma, dotenv, preload and alternate datasource controls are refused even when empty', () => {
  for (const key of ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
    'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGPASSFILE', 'PGSSLMODE', 'PRISMA_SCHEMA_ENGINE_BINARY',
    'PRISMA_CONFIG', 'DOTENV_CONFIG_PATH', 'NODE_OPTIONS', 'NODE_PATH', 'DIRECT_URL',
    'SHADOW_DATABASE_URL', 'DATABASE_DIRECT_URL', 'OTHER_DATABASE_URL', 'database_url',
    'npm_config_node_options', 'npm_config_script_shell']) {
    for (const value of ['', 'synthetic-override']) assert.throws(() => check({ [key]: value }), refusal)
    assert.equal(check({ [key]: undefined }).executionAllowed, false)
  }
  assert.equal(check({ UNRELATED_BUILD_LABEL: 'synthetic' }).executionAllowed, false)
})

test('refusal diagnostics never include supplied credentials, values or exception causes', () => {
  const secret = 'SYNTHETIC_UNPUBLISHED_CREDENTIAL_SENTINEL'
  for (const overrides of [{ DATABASE_URL: `postgresql://user:${secret}@[invalid` },
    { PGOPTIONS: secret }, { GITHUB_WORKFLOW_REF: secret }]) {
    let caught: unknown
    try { check(overrides) } catch (error) { caught = error }
    assert.ok(caught instanceof Error)
    assert.match(caught.message, refusal)
    assert.equal('cause' in caught, false)
    assert.equal('input' in caught, false)
    const surface = [String(caught), caught.stack, JSON.stringify(caught), inspect(caught, { showHidden: true })].join('\n')
    assert.ok(!surface.includes(secret))
  }
})

test('module evaluation and accepted/refused synthetic checks open no socket and start no child', async t => {
  let attempts = 0
  const blocked = () => { attempts += 1; throw new Error('Unexpected effect') }
  t.mock.method(Socket.prototype, 'connect', blocked)
  t.mock.method(Server.prototype, 'listen', blocked)
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    t.mock.method(childProcess, name, blocked)
  }
  syncBuiltinESMExports()
  try {
    const fresh = await import(new URL('./haw70-upgrade-target.ts?no-effects', import.meta.url).href)
    assert.equal(fresh.inspectHaw70UpgradeTarget({ environment, expectedCandidateCommit: candidate }).executionAllowed, false)
    assert.throws(() => fresh.inspectHaw70UpgradeTarget({ environment: {}, expectedCandidateCommit: candidate }), refusal)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(attempts, 0)
})
