import assert from 'node:assert/strict'
import test from 'node:test'
import { readDirectoryRoleResults, DIRECTORY_ROLE_CURRENT_MS } from './directory-role-reader.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const TEN = '22222222-2222-4222-8222-222222222222'
const MSFT = '33333333-3333-4333-8333-333333333333'
const INCARNATION = '44444444-4444-4444-8444-444444444444'
const SCOPE_INCARNATION = '55555555-5555-4555-8555-555555555555'
const COMPLETE_ID = '66666666-6666-4666-8666-666666666666'
const REVISION = '77777777-7777-4777-8777-777777777777'
const NOW = Date.UTC(2026, 9, 7, 6, 0, 0)
const CHECKED = new Date(NOW - 60_000)

const ROW = {
  id: 'assignment-1', principalId: 'principal-1', roleDefinitionId: 'definition-1',
  directoryScopeId: '/', appScopeId: null,
  roleDefinition: { id: 'definition-1', displayName: 'Global Reader', templateId: 'template-1' },
}

function completeState(overrides: Record<string, unknown> = {}) {
  return {
    roleScopeVersion: 'directory-role-assignments/v1', roleScopeIncarnation: SCOPE_INCARNATION,
    roleAttemptOutcome: null, roleAttemptTerminalAt: null, roleAttemptId: null,
    roleCompleteId: COMPLETE_ID, roleCompleteConnection: INCARNATION,
    roleCompleteConfiguration: REVISION, roleCompleteScope: SCOPE_INCARNATION,
    roleCompleteScopeVersion: 'directory-role-assignments/v1', roleCompleteMicrosoftTenantId: MSFT,
    roleCompleteCheckedAt: CHECKED, roleCompleteCount: 1,
    ...overrides,
  }
}

function db(options: { state?: unknown; snapshot?: unknown; authority?: unknown } = {}) {
  const authorityRow = options.authority === undefined
    ? [{ configurationRevision: REVISION, clientId: 'client', homeTenantId: MSFT, credentialReference: `encrypted-secret:${REVISION}`, operationId: null, fingerprint: null }]
    : (options.authority as unknown[])
  const reads: string[] = []
  return {
    reads,
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
      $queryRawUnsafe: async (query: string) => {
        reads.push(query.includes('pg_advisory') ? 'authority-lock' : 'authority-row')
        return query.includes('pg_advisory') ? [{ locked: 1 }] : authorityRow
      },
      $executeRawUnsafe: async () => 0,
    }),
    syncState: { findFirst: async () => { reads.push('sync-state'); return options.state === undefined ? completeState() : options.state } },
    tenantEntraSnapshot: { findFirst: async () => { reads.push('snapshot'); return options.snapshot === undefined ? { payload: [ROW], rolePublicationAttemptId: COMPLETE_ID, observedAt: CHECKED } : options.snapshot } },
  } as never
}

const input = { organizationId: ORG, customerTenantId: TEN, microsoftTenantId: MSFT, collectionIncarnation: INCARNATION, now: NOW }

test('a coherent complete receipt is current, with rows projected field by field', async () => {
  const result = await readDirectoryRoleResults(db(), input)
  assert.equal(result.status, 'current')
  assert.equal(result.observation?.observedCount, 1)
  assert.equal(result.observation?.verifiedCompleteEmpty, false)
  assert.deepEqual(result.observation?.assignments, [{
    id: 'assignment-1', principalId: 'principal-1', roleDefinitionId: 'definition-1',
    roleDisplayName: 'Global Reader', directoryScopeId: '/', appScopeId: null,
  }])
  // The provider payload is never spread: templateId is stored but must not reach the response.
  assert.equal(JSON.stringify(result).includes('templateId'), false)
  assert.equal(JSON.stringify(result).includes('template-1'), false)
  assert.equal(result.latestAttempt.outcome, null)
})

test('an unactivated tenant is never-vouched-for, even when a snapshot holds rows', async () => {
  for (const state of [
    null,
    completeState({ roleScopeVersion: null, roleScopeIncarnation: null }),
    completeState({ roleScopeVersion: 'directory-role-assignments/v0' }),
    completeState({ roleScopeIncarnation: null }),
  ]) {
    const result = await readDirectoryRoleResults(db({ state }), input)
    assert.equal(result.status, 'not-activated')
    assert.equal(result.observation, null)
  }
})

test('activated but never completed is distinct from an empty result', async () => {
  const result = await readDirectoryRoleResults(db({ state: completeState({ roleCompleteId: null, roleCompleteCheckedAt: null }) }), input)
  assert.equal(result.status, 'never-collected')
  assert.equal(result.observation, null)
})

test('every coherence key is load-bearing: changing any one supersedes the receipt', async () => {
  const mismatches: Array<[string, Record<string, unknown>]> = [
    ['scope version', { roleCompleteScopeVersion: 'directory-role-assignments/v0' }],
    ['microsoft tenant', { roleCompleteMicrosoftTenantId: '99999999-9999-4999-8999-999999999999' }],
    ['scope incarnation (re-activation)', { roleCompleteScope: '88888888-8888-4888-8888-888888888888' }],
    ['connection incarnation', { roleCompleteConnection: '88888888-8888-4888-8888-888888888888' }],
    ['authority revision', { roleCompleteConfiguration: '88888888-8888-4888-8888-888888888888' }],
  ]
  for (const [label, overrides] of mismatches) {
    const result = await readDirectoryRoleResults(db({ state: completeState(overrides) }), input)
    assert.equal(result.status, 'superseded', label)
    assert.equal(result.observation, null, label)
  }
  // A missing authority row is also not a current success.
  const noAuthority = await readDirectoryRoleResults(db({ authority: [] }), input)
  assert.equal(noAuthority.status, 'superseded')
})

test('an unstamped snapshot is legacy evidence and is never read as this attempt', async () => {
  const legacy = await readDirectoryRoleResults(db({ snapshot: { payload: [ROW], rolePublicationAttemptId: null, observedAt: CHECKED } }), input)
  assert.equal(legacy.status, 'superseded')
  assert.equal(legacy.observation, null)
  const other = await readDirectoryRoleResults(db({ snapshot: { payload: [ROW], rolePublicationAttemptId: '00000000-0000-4000-8000-000000000000', observedAt: CHECKED } }), input)
  assert.equal(other.status, 'superseded')
  const missing = await readDirectoryRoleResults(db({ snapshot: null }), input)
  assert.equal(missing.status, 'superseded')
})

test('the receipt count and the stored rows must agree, including at zero', async () => {
  const short = await readDirectoryRoleResults(db({ state: completeState({ roleCompleteCount: 2 }) }), input)
  assert.equal(short.status, 'superseded')
  const nullCount = await readDirectoryRoleResults(db({ state: completeState({ roleCompleteCount: null }) }), input)
  assert.equal(nullCount.status, 'superseded')
  // The one trustworthy empty: a coherent COMPLETE whose counted rows are zero.
  const empty = await readDirectoryRoleResults(
    db({ state: completeState({ roleCompleteCount: 0 }), snapshot: { payload: [], rolePublicationAttemptId: COMPLETE_ID, observedAt: CHECKED } }),
    input
  )
  assert.equal(empty.status, 'current')
  assert.equal(empty.observation?.verifiedCompleteEmpty, true)
  assert.equal(empty.observation?.observedCount, 0)
})

test('an older coherent receipt is stale rather than current, and keeps its own clock', async () => {
  const old = new Date(NOW - DIRECTORY_ROLE_CURRENT_MS - 1000)
  const result = await readDirectoryRoleResults(db({ state: completeState({ roleCompleteCheckedAt: old }) }), input)
  assert.equal(result.status, 'stale')
  assert.equal(result.observation?.checkedAt, old.toISOString())
  assert.equal(result.observation?.ageMs, NOW - old.getTime())
})

test('a failed or partial attempt never replaces a complete result and never implies zero', async () => {
  for (const outcome of ['FAILED', 'PARTIAL', 'EXPIRED'] as const) {
    const result = await readDirectoryRoleResults(
      db({ state: completeState({ roleAttemptOutcome: outcome, roleAttemptTerminalAt: new Date(NOW - 10_000), roleAttemptId: COMPLETE_ID }) }),
      input
    )
    assert.equal(result.status, 'current', outcome)
    assert.equal(result.observation?.observedCount, 1, outcome)
    assert.equal(result.latestAttempt.outcome, outcome)
    assert.equal(result.latestAttempt.terminalAt, new Date(NOW - 10_000).toISOString())
  }
  const running = await readDirectoryRoleResults(db({ state: completeState({ roleAttemptId: COMPLETE_ID }) }), input)
  assert.equal(running.latestAttempt.outcome, 'RUNNING')
  assert.equal(running.observation?.observedCount, 1)
})

test('malformed stored rows are dropped rather than rendered, and then fail the count check', async () => {
  const result = await readDirectoryRoleResults(
    db({ snapshot: { payload: [{ principalId: 'no-id' }, ROW], rolePublicationAttemptId: COMPLETE_ID, observedAt: CHECKED }, state: completeState({ roleCompleteCount: 2 }) }),
    input
  )
  assert.equal(result.status, 'superseded')
  const nonArray = await readDirectoryRoleResults(
    db({ snapshot: { payload: { not: 'an array' }, rolePublicationAttemptId: COMPLETE_ID, observedAt: CHECKED } }),
    input
  )
  assert.equal(nonArray.status, 'superseded')
})
