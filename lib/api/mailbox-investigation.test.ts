import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseInvestigationAccess, parseMailboxInvestigation } from './mailbox-investigation.ts'

const tenantId = '22222222-2222-4222-8222-222222222222'
const now = new Date('2026-09-04T04:00:00.000Z')
const good = () => ({ version: 1, status: 'AVAILABLE', mailbox: { id: 'mailbox-123', label: 'Pilot mailbox', observedAt: '2026-09-04T03:00:00.000Z', inventoryPath: `/tenants/${tenantId}/exchange` } })

test('strict privileged mailbox response preserves only explicit current inventory projection', () => {
  assert.deepEqual(parseMailboxInvestigation(good(), tenantId, now), good())
  assert.equal(parseInvestigationAccess({ version: 1, allowed: true }), true)
  for (const value of [{ version: 1, allowed: false }, { version: 2, allowed: true }, { version: 1, allowed: 'true' }, { version: 1, allowed: true, mailbox: 'private' }, Object.create({ version: 1, allowed: true })]) assert.equal(parseInvestigationAccess(value), false)
})

test('cross-tenant and external routes, unsafe labels, stale/future/missing evidence fail closed', () => {
  const variants = [
    { inventoryPath: '/tenants/other/ exchange' }, { inventoryPath: '/tenants/other/exchange' },
    { inventoryPath: 'https://attacker.invalid' }, { inventoryPath: '//attacker.invalid' },
    { inventoryPath: `${good().mailbox.inventoryPath}?redirect=https://attacker.invalid` },
    { label: '<script>private</script>' }, { label: 'secret\u202etext' }, { label: 'x'.repeat(161) },
    { id: '../other' }, { observedAt: '2026-09-01T00:00:00Z' }, { observedAt: '2027-09-01T00:00:00Z' }, { observedAt: null },
  ]
  for (const variant of variants) {
    assert.deepEqual(parseMailboxInvestigation({ ...good(), mailbox: { ...good().mailbox, ...variant } }, tenantId, now), { version: 1, status: 'UNAVAILABLE', mailbox: null })
  }
  for (const bad of [{ ...good(), raw: { secret: 'private' } }, { ...good(), mailbox: { ...good().mailbox, token: 'private' } }, { version: 1, status: 'UNAVAILABLE', mailbox: good().mailbox }]) assert.equal(parseMailboxInvestigation(bad, tenantId, now).mailbox, null)
})

test('UI offers explicit owner/admin-authorized current mailbox investigation and no raw-list identity inference', () => {
  const section = readFileSync(new URL('../../components/identity-risk/identity-risk-section.tsx', import.meta.url), 'utf8')
  const action = readFileSync(new URL('../../components/identity-risk/mailbox-investigation.tsx', import.meta.url), 'utf8')
  const hook = readFileSync(new URL('./identity-risk-hooks.ts', import.meta.url), 'utf8')
  assert.match(section, /investigationAllowed && finding\.affectedIdentity\.type === 'MAILBOX'/)
  assert.match(section, /finding\.ruleIds\.includes\('HV-ID-MBX-001\.v1'\)/)
  assert.match(section, /view\.meta\.freshness === 'CURRENT'/)
  assert.match(section, /key=\{`\$\{investigation\.cacheScope\}:\$\{tenantId\}`\}/)
  assert.match(hook, /parseInvestigationAccess\(access\.data\)/)
  assert.match(action, /onClick=\{\(\) => void investigate\(\)\}/)
  assert.match(action, /aria-live="polite"/)
  assert.match(action, /request\.current\?\.abort\(\)/)
  assert.doesNotMatch(action, /console\.|localStorage|sessionStorage|useQuery|dangerouslySetInnerHTML/)
})
