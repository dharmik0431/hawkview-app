import assert from 'node:assert/strict'
import test from 'node:test'
import { orderAuditReadyTenantTurns, type AuditReadyTenantTurn } from './m365-audit-fair-turn.js'

const at = (minute: number) => new Date(Date.UTC(2026, 10, 9, 0, minute))
const tenant = (
  customerTenantId: string,
  lastCompletedTurn: bigint | null,
  originalReadyAt = at(0),
  ready = true,
): AuditReadyTenantTurn => ({ customerTenantId, lastCompletedTurn, originalReadyAt, ready })

test('an unserved quiet tenant precedes two busy tenants that completed a turn', () => {
  const input = [tenant('busy-b', 2n), tenant('quiet', null, at(1)), tenant('busy-a', 1n)]
  assert.deepEqual(orderAuditReadyTenantTurns(input), ['quiet', 'busy-a', 'busy-b'])
  assert.deepEqual(input.map((item) => item.customerTenantId), ['busy-b', 'quiet', 'busy-a'])
})

test('three ready tenants rotate by durable completed turn, not input order', () => {
  const input = [tenant('c', null, at(2)), tenant('a', null), tenant('b', null, at(1))]
  assert.deepEqual(orderAuditReadyTenantTurns(input), ['a', 'b', 'c'])
  input[0] = tenant('c', null, at(2))
  input[1] = tenant('a', 1n)
  assert.deepEqual(orderAuditReadyTenantTurns(input), ['b', 'c', 'a'])
  input[2] = tenant('b', 2n, at(1))
  assert.deepEqual(orderAuditReadyTenantTurns(input), ['c', 'a', 'b'])
})

test('an ineligible tenant cannot reserve a turn and a late join gets the next opportunity', () => {
  const input = [tenant('busy-a', 5n), tenant('backoff', null, at(0), false), tenant('busy-b', 6n)]
  assert.deepEqual(orderAuditReadyTenantTurns(input), ['busy-a', 'busy-b'])
  assert.deepEqual(orderAuditReadyTenantTurns([...input, tenant('late', null, at(3))]),
    ['late', 'busy-a', 'busy-b'])
})

test('oldest completed turn wins before original ready time, with tenant ID as a stable tie-breaker', () => {
  assert.deepEqual(orderAuditReadyTenantTurns([
    tenant('z', 9n, at(0)), tenant('b', 8n, at(2)), tenant('a', 8n, at(2)),
  ]), ['a', 'b', 'z'])
})

test('ambiguous or invalid ready state fails closed', () => {
  assert.throws(() => orderAuditReadyTenantTurns([tenant('same', null), tenant('same', 1n)]),
    /M365_AUDIT_FAIR_TURN_IDENTITY_INVALID/)
  assert.throws(() => orderAuditReadyTenantTurns([tenant('', null)]),
    /M365_AUDIT_FAIR_TURN_IDENTITY_INVALID/)
  assert.throws(() => orderAuditReadyTenantTurns([tenant('bad-clock', null, new Date(Number.NaN))]),
    /M365_AUDIT_FAIR_TURN_STATE_INVALID/)
  assert.throws(() => orderAuditReadyTenantTurns([tenant('negative', -1n)]),
    /M365_AUDIT_FAIR_TURN_STATE_INVALID/)
})
