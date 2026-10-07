import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDirectoryRoleResults, DIRECTORY_ROLE_RESPONSE_VERSION } from './directory-role-results-view.ts'

const ROW = {
  id: 'assignment-1', principalId: 'principal-1', roleDefinitionId: 'definition-1',
  roleDisplayName: 'Global Reader', directoryScopeId: '/', appScopeId: null,
}
const OBSERVATION = {
  checkedAt: '2026-10-07T05:59:00.000Z', ageMs: 60_000, observedCount: 1,
  assignments: [ROW], verifiedCompleteEmpty: false,
}
const body = (o: Record<string, unknown> = {}) => ({
  responseVersion: DIRECTORY_ROLE_RESPONSE_VERSION,
  source: 'Microsoft Graph v1.0 /roleManagement/directory/roleAssignments',
  status: 'current', observation: OBSERVATION,
  latestAttempt: { outcome: null, terminalAt: null },
  ...o,
})

test('the baseline parses, so every refusal below is a change from a passing case', () => {
  const parsed = parseDirectoryRoleResults(body())
  assert.ok(parsed)
  assert.equal(parsed.status, 'current')
  assert.equal(parsed.observation?.observedCount, 1)
  assert.ok(parsed.observation?.checkedAt instanceof Date)
  assert.deepEqual(parsed.observation?.assignments, [ROW])
  assert.equal(parsed.latestAttempt.outcome, null)
})

test('an unsupported version or missing source is refused', () => {
  for (const version of ['directory-role-results/v2', '', undefined, null, 1]) {
    assert.equal(parseDirectoryRoleResults(body({ responseVersion: version })), null)
  }
  for (const source of ['', undefined, null, 5]) {
    assert.equal(parseDirectoryRoleResults(body({ source })), null)
  }
})

test('only current and stale may carry an observation, and they must', () => {
  for (const status of ['not-activated', 'never-collected', 'superseded']) {
    assert.equal(parseDirectoryRoleResults(body({ status })), null, `${status} with an observation`)
    const ok = parseDirectoryRoleResults(body({ status, observation: null }))
    assert.equal(ok?.status, status)
    assert.equal(ok?.observation, null)
  }
  for (const status of ['current', 'stale']) {
    assert.equal(parseDirectoryRoleResults(body({ status, observation: null })), null, `${status} without one`)
    assert.ok(parseDirectoryRoleResults(body({ status })))
  }
  assert.equal(parseDirectoryRoleResults(body({ status: 'collected' })), null)
})

test('an omitted observation property is malformed, not an absent observation', () => {
  const missing: Record<string, unknown> = body({ status: 'never-collected' })
  delete missing.observation
  assert.equal(Object.prototype.hasOwnProperty.call(missing, 'observation'), false)
  assert.equal(parseDirectoryRoleResults(missing), null)
})

test('the server count and the rows it sent must agree', () => {
  assert.equal(parseDirectoryRoleResults(body({ observation: { ...OBSERVATION, observedCount: 2 } })), null)
  assert.equal(parseDirectoryRoleResults(body({ observation: { ...OBSERVATION, assignments: [] } })), null)
  for (const value of [Number.POSITIVE_INFINITY, Number.NaN, -1, '1', null]) {
    assert.equal(parseDirectoryRoleResults(body({ observation: { ...OBSERVATION, observedCount: value } })), null)
    assert.equal(parseDirectoryRoleResults(body({ observation: { ...OBSERVATION, ageMs: value } })), null)
  }
})

test('verifiedCompleteEmpty is taken verbatim and must match the rows', () => {
  // The client never promotes an unvouched empty back to verified...
  assert.equal(parseDirectoryRoleResults(body({
    observation: { ...OBSERVATION, observedCount: 0, assignments: [], verifiedCompleteEmpty: false },
  })), null)
  // ...nor accepts a "verified empty" that arrives with rows.
  assert.equal(parseDirectoryRoleResults(body({
    observation: { ...OBSERVATION, verifiedCompleteEmpty: true },
  })), null)
  for (const flag of ['true', 1, null, undefined]) {
    assert.equal(parseDirectoryRoleResults(body({ observation: { ...OBSERVATION, verifiedCompleteEmpty: flag } })), null)
  }
  const empty = parseDirectoryRoleResults(body({
    observation: { ...OBSERVATION, observedCount: 0, assignments: [], verifiedCompleteEmpty: true },
  }))
  assert.equal(empty?.observation?.verifiedCompleteEmpty, true)
  assert.equal(empty?.observation?.observedCount, 0)
})

test('a row without an id, or a malformed row, refuses the whole answer', () => {
  for (const rows of [[{ principalId: 'p' }], [ROW, 'not-an-object'], [null]]) {
    assert.equal(parseDirectoryRoleResults(body({ observation: { ...OBSERVATION, assignments: rows, observedCount: rows.length } })), null)
  }
  assert.equal(parseDirectoryRoleResults(body({ observation: { ...OBSERVATION, assignments: 'rows' } })), null)
  // Null identifier fields are a valid display fallback, not a malformed row.
  const sparse = parseDirectoryRoleResults(body({
    observation: { ...OBSERVATION, assignments: [{ id: 'a', principalId: null, roleDefinitionId: null, roleDisplayName: null, directoryScopeId: null, appScopeId: null }] },
  }))
  assert.equal(sparse?.observation?.assignments[0].id, 'a')
  assert.equal(sparse?.observation?.assignments[0].roleDisplayName, null)
})

test('the latest attempt is validated and kept separate from the observation', () => {
  for (const outcome of ['FAILED', 'PARTIAL', 'EXPIRED', 'RUNNING']) {
    const parsed = parseDirectoryRoleResults(body({ latestAttempt: { outcome, terminalAt: '2026-10-07T05:58:00.000Z' } }))
    assert.equal(parsed?.latestAttempt.outcome, outcome)
    assert.ok(parsed?.latestAttempt.terminalAt instanceof Date)
    // The failed attempt does not disturb the stored observation.
    assert.equal(parsed?.observation?.observedCount, 1)
  }
  for (const bad of [{ outcome: 'DONE', terminalAt: null }, { outcome: null, terminalAt: 'nonsense' }, { outcome: null, terminalAt: 5 }]) {
    assert.equal(parseDirectoryRoleResults(body({ latestAttempt: bad })), null)
  }
  assert.equal(parseDirectoryRoleResults(body({ latestAttempt: null })), null)
})

test('non-record envelopes are refused', () => {
  for (const value of [null, undefined, 'ok', 7, [], [body()]]) {
    assert.equal(parseDirectoryRoleResults(value), null)
  }
})
