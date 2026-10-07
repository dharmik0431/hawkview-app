import assert from 'node:assert/strict'
import test from 'node:test'

import {
  directoryRoleControlAffordance,
  isDirectoryControlOffered,
  parseDirectoryRoleControl,
} from './directory-role-control-view.ts'

const FULL = {
  configurationRevision: '2f2d9a3c-0000-4000-8000-000000000001',
  connectionIncarnation: '2f2d9a3c-0000-4000-8000-000000000002',
  scopeIncarnation: '2f2d9a3c-0000-4000-8000-000000000003',
  scopeVersion: 'directory-role-assignments/v1',
}
const answer = (o: Record<string, unknown> = {}) => ({ enabled: false, expected: { ...FULL }, ...o })

test('a complete answer parses with every reported value preserved', () => {
  const parsed = parseDirectoryRoleControl(answer({ enabled: true }))
  assert.ok(parsed)
  assert.equal(parsed.enabled, true)
  assert.deepEqual(parsed.expected, FULL)
})

test('an all-null expectation is valid: the server reports an unconfigured tenant that way', () => {
  const parsed = parseDirectoryRoleControl(answer({
    expected: { configurationRevision: null, connectionIncarnation: null, scopeIncarnation: null, scopeVersion: null },
  }))
  assert.ok(parsed)
  assert.equal(parsed.expected.configurationRevision, null)
})

test('a half-present scope pair is refused, matching the server’s own invariant', () => {
  assert.equal(parseDirectoryRoleControl(answer({ expected: { ...FULL, scopeVersion: null } })), null)
  assert.equal(parseDirectoryRoleControl(answer({ expected: { ...FULL, scopeIncarnation: null } })), null)
})

test('a scopeVersion longer than the server accepts is refused rather than offered', () => {
  const tooLong = 'v'.repeat(101)
  assert.equal(parseDirectoryRoleControl(answer({ expected: { ...FULL, scopeVersion: tooLong } })), null)
  assert.ok(parseDirectoryRoleControl(answer({ expected: { ...FULL, scopeVersion: 'v'.repeat(100) } })))
})

test('a malformed answer is unreadable, never a disabled opt-in', () => {
  for (const bad of [null, [], 'enabled', { expected: FULL }, answer({ enabled: 'false' }),
    answer({ enabled: 1 }), { enabled: false }, answer({ expected: null }),
    answer({ expected: { ...FULL, configurationRevision: '' } })]) {
    const parsed = parseDirectoryRoleControl(bad)
    assert.equal(parsed, null, `expected unreadable for ${JSON.stringify(bad)}`)
  }
})

test('only Owner and Admin are offered the control, and an absent membership list is not', () => {
  assert.equal(isDirectoryControlOffered([{ role: 'MSP_OWNER' }]), true)
  assert.equal(isDirectoryControlOffered([{ role: 'MSP_ADMIN' }]), true)
  assert.equal(isDirectoryControlOffered([{ role: 'MSP_TECHNICIAN' }]), false)
  assert.equal(isDirectoryControlOffered([{ role: 'MSP_VIEWER' }]), false)
  assert.equal(isDirectoryControlOffered([]), false)
  assert.equal(isDirectoryControlOffered(null), false)
  assert.equal(isDirectoryControlOffered(undefined), false)
})

test('disable stays available when opt-in is on but configuration and connection are gone', () => {
  const control = {
    enabled: true,
    expected: { configurationRevision: null, connectionIncarnation: null, scopeIncarnation: null, scopeVersion: null },
  }
  const a = directoryRoleControlAffordance(control, true)
  assert.equal(a.canDisable, true, 'withdrawing consent must not depend on the connection being usable')
  assert.equal(a.canEnable, false)
  assert.equal(a.eligibilityUnavailable, false, 'this is not an eligibility problem: it is already on')
})

test('enable is withheld — not merely refused later — when the server reports no current context', () => {
  const offBut = (expected: Record<string, unknown>) =>
    directoryRoleControlAffordance({ enabled: false, expected } as never, true)
  assert.deepEqual(offBut({ ...FULL, configurationRevision: null }),
    { canEnable: false, canDisable: false, eligibilityUnavailable: true })
  assert.deepEqual(offBut({ ...FULL, connectionIncarnation: null }),
    { canEnable: false, canDisable: false, eligibilityUnavailable: true })
  assert.deepEqual(offBut({ ...FULL }),
    { canEnable: true, canDisable: false, eligibilityUnavailable: false })
})

test('nothing is offered without a read or without permission', () => {
  assert.deepEqual(directoryRoleControlAffordance(null, true),
    { canEnable: false, canDisable: false, eligibilityUnavailable: false })
  assert.deepEqual(directoryRoleControlAffordance({ enabled: true, expected: { ...FULL } }, false),
    { canEnable: false, canDisable: false, eligibilityUnavailable: false })
})
