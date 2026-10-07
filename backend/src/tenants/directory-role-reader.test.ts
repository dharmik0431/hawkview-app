import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readDirectoryRoleResults, DIRECTORY_ROLE_CURRENT_MS } from './directory-role-reader.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const TEN = '22222222-2222-4222-8222-222222222222'
const MSFT = '33333333-3333-4333-8333-333333333333'
const INCARNATION = '44444444-4444-4444-8444-444444444444'
const SCOPE_INCARNATION = '55555555-5555-4555-8555-555555555555'
const COMPLETE_ID = '66666666-6666-4666-8666-666666666666'
const REVISION = '77777777-7777-4777-8777-777777777777'
const PRINCIPAL = '88888888-8888-4888-8888-888888888888'
const DEFINITION = '99999999-9999-4999-8999-999999999999'
const READ_AT = new Date(Date.UTC(2026, 9, 7, 7, 0, 0))
const CHECKED = new Date(READ_AT.getTime() - 60_000)

/** The canonical shape the collection contract produces, so the digest below is the real one. */
const ROW = {
  id: 'assignment-1', principalId: PRINCIPAL, roleDefinitionId: DEFINITION,
  directoryScopeId: '/', appScopeId: null,
  roleDefinition: { id: DEFINITION, displayName: 'Global Reader', templateId: null },
}
const digestOf = (rows: unknown[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex')

function row(overrides: Record<string, unknown> = {}) {
  const payload = (overrides.snapshotPayload as unknown[] | undefined) ?? [ROW]
  return {
    readAt: READ_AT,
    tenantStatus: 'ACTIVE', microsoftTenantId: MSFT,
    connectionStatus: 'CONNECTED', connectionMode: 'HAWKVIEW_MANAGED', connectionIncarnation: INCARNATION,
    scopeVersion: 'directory-role-assignments/v1', scopeIncarnation: SCOPE_INCARNATION,
    attemptOutcome: 'COMPLETE', attemptTerminalAt: CHECKED,
    completeId: COMPLETE_ID, completeConnection: INCARNATION, completeConfiguration: REVISION,
    completeScope: SCOPE_INCARNATION, completeScopeVersion: 'directory-role-assignments/v1',
    completeMicrosoftTenantId: MSFT, completeCheckedAt: CHECKED,
    completeDigest: digestOf(payload), completeCount: payload.length,
    snapshotPayload: payload, snapshotAttemptId: COMPLETE_ID, snapshotObservedAt: CHECKED,
    ...overrides,
  }
}

function db(rows: unknown[], authority: unknown[] = [{ configurationRevision: REVISION, clientId: 'c', homeTenantId: MSFT, credentialReference: `encrypted-secret:${REVISION}`, operationId: null, fingerprint: null }]) {
  const statements: string[] = []
  return {
    statements,
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
      $queryRawUnsafe: async (query: string) => {
        if (query.includes('directory-role-results:coherent-read')) { statements.push('coherent-read'); return rows }
        if (query.includes('pg_advisory')) { statements.push('authority-lock'); return [{ locked: 1 }] }
        statements.push('authority-row'); return authority
      },
      $executeRawUnsafe: async () => 0,
    }),
  } as never
}

const input = { organizationId: ORG, customerTenantId: TEN }

test('one coherent statement, then the authority, inside a single transaction', async () => {
  const database = db([row()])
  const result = await readDirectoryRoleResults(database, input)
  assert.equal(result.status, 'current')
  assert.deepEqual((database as any).statements, ['coherent-read', 'authority-lock', 'authority-row'])
  assert.deepEqual(result.observation?.assignments, [{
    id: 'assignment-1', principalId: PRINCIPAL, roleDefinitionId: DEFINITION,
    roleDisplayName: 'Global Reader', directoryScopeId: '/', appScopeId: null,
  }])
  assert.equal(result.latestAttempt.outcome, null, 'COMPLETE is not an outstanding attempt')
})

test('ROOT COUNTEREXAMPLE: a malformed payload can never read as a verified empty', async () => {
  // A zero-count receipt whose stored payload is garbage. v1 dropped the rows and called this
  // "verified complete empty"; the whole payload must now be refused.
  for (const payload of [[{}], [ROW, {}], [{ id: 'x' }], 'not-an-array', null, [ROW, 'junk']]) {
    const result = await readDirectoryRoleResults(db([row({ snapshotPayload: payload, completeCount: 0, completeDigest: digestOf([]) })]), input)
    assert.equal(result.status, 'superseded', JSON.stringify(payload))
    assert.equal(result.observation, null)
  }
  // A genuinely empty, correctly bound payload is still the one trustworthy empty.
  const empty = await readDirectoryRoleResults(db([row({ snapshotPayload: [], completeCount: 0, completeDigest: digestOf([]) })]), input)
  assert.equal(empty.status, 'current')
  assert.equal(empty.observation?.verifiedCompleteEmpty, true)
})

test('ROOT COUNTEREXAMPLE: a same-count payload with different content fails the digest', async () => {
  const renamed = [{ ...ROW, roleDefinition: { ...ROW.roleDefinition, displayName: 'Changed Name' } }]
  const result = await readDirectoryRoleResults(db([row({ snapshotPayload: renamed, completeDigest: digestOf([ROW]) })]), input)
  assert.equal(result.status, 'superseded')
  // ...and the digest is what rejects it: with the matching digest the same payload is current.
  const ok = await readDirectoryRoleResults(db([row({ snapshotPayload: renamed, completeDigest: digestOf(renamed) })]), input)
  assert.equal(ok.status, 'current')
})

test('ROOT COUNTEREXAMPLE: the snapshot clock must equal the receipt clock', async () => {
  for (const observedAt of [new Date(0), new Date(CHECKED.getTime() + 1), null]) {
    const result = await readDirectoryRoleResults(db([row({ snapshotObservedAt: observedAt })]), input)
    assert.equal(result.status, 'superseded', String(observedAt))
  }
})

test('ROOT COUNTEREXAMPLE: ineligible current state is never advertised as current', async () => {
  const ineligible: Array<[string, Record<string, unknown>]> = [
    ['suspended tenant', { tenantStatus: 'SUSPENDED' }],
    ['disconnected tenant', { tenantStatus: 'DISCONNECTED' }],
    ['connection error', { connectionStatus: 'ERROR' }],
    ['revoked connection', { connectionStatus: 'REVOKED' }],
    ['customer-managed mode', { connectionMode: 'CUSTOMER_MANAGED' }],
    ['no incarnation', { connectionIncarnation: null }],
  ]
  for (const [label, overrides] of ineligible) {
    const result = await readDirectoryRoleResults(db([row(overrides)]), input)
    assert.equal(result.status, 'superseded', label)
    assert.equal(result.observation, null, label)
  }
  // A mutable (non-immutable-reference) managed authority is equally ineligible.
  const mutable = await readDirectoryRoleResults(db([row()], [{ configurationRevision: REVISION, clientId: 'c', homeTenantId: MSFT, credentialReference: 'encrypted-secret:other', operationId: null, fingerprint: null }]), input)
  assert.equal(mutable.status, 'superseded')
})

test('ROOT COUNTEREXAMPLE: a persisted RUNNING attempt is reported, beside the kept observation', async () => {
  const result = await readDirectoryRoleResults(db([row({ attemptOutcome: 'RUNNING', attemptTerminalAt: null })]), input)
  assert.equal(result.latestAttempt.outcome, 'RUNNING')
  assert.equal(result.latestAttempt.terminalAt, null)
  assert.equal(result.status, 'current')
  assert.equal(result.observation?.observedCount, 1, 'the completed observation is preserved')
  for (const outcome of ['FAILED', 'PARTIAL', 'EXPIRED']) {
    const failed = await readDirectoryRoleResults(db([row({ attemptOutcome: outcome })]), input)
    assert.equal(failed.latestAttempt.outcome, outcome)
    assert.equal(failed.observation?.observedCount, 1)
  }
  // An unknown or absent outcome is reported as no outstanding attempt, never inferred as RUNNING.
  for (const outcome of [null, 'COMPLETE', 'SOMETHING_ELSE']) {
    const quiet = await readDirectoryRoleResults(db([row({ attemptOutcome: outcome })]), input)
    assert.equal(quiet.latestAttempt.outcome, null, String(outcome))
  }
})

test('activation evidence and receipt binding each fail closed on their own', async () => {
  for (const overrides of [{ scopeVersion: null, scopeIncarnation: null }, { scopeVersion: 'directory-role-assignments/v0' }, { scopeIncarnation: null }]) {
    const result = await readDirectoryRoleResults(db([row(overrides)]), input)
    assert.equal(result.status, 'not-activated')
  }
  assert.equal((await readDirectoryRoleResults(db([]), input)).status, 'not-activated')
  assert.equal((await readDirectoryRoleResults(db([row({ completeId: null, completeCheckedAt: null })]), input)).status, 'never-collected')
  for (const overrides of [
    { completeScopeVersion: 'directory-role-assignments/v0' },
    { completeMicrosoftTenantId: PRINCIPAL },
    { completeScope: PRINCIPAL },
    { completeConnection: PRINCIPAL },
    { completeConfiguration: PRINCIPAL },
    { snapshotAttemptId: null },
    { snapshotAttemptId: PRINCIPAL },
    { completeCount: 2 },
  ]) {
    const result = await readDirectoryRoleResults(db([row(overrides)]), input)
    assert.equal(result.status, 'superseded', JSON.stringify(overrides))
  }
})

test('age comes from the read clock against the receipt clock, and crosses into stale', async () => {
  const old = new Date(READ_AT.getTime() - DIRECTORY_ROLE_CURRENT_MS - 1000)
  const result = await readDirectoryRoleResults(db([row({ completeCheckedAt: old, snapshotObservedAt: old, attemptTerminalAt: old })]), input)
  assert.equal(result.status, 'stale')
  assert.equal(result.observation?.checkedAt, old.toISOString())
  assert.equal(result.observation?.ageMs, READ_AT.getTime() - old.getTime())
})
