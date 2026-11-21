import assert from 'node:assert/strict'
import test from 'node:test'
import { directoryAuditSecurityIncident } from './directory-audit-security-incident.js'

const tenant = { id: 'tenant 1', organizationId: 'organization 1' }
const eventDateTime = new Date('2026-11-11T10:00:00.000Z')
const source = {
  microsoftAuditId: 'audit-1', eventDateTime,
  activityDisplayName: 'Update authentication method',
  result: 'success', category: 'UserManagement',
}

test('directory audit incident payload keeps the prior security mapping and exact tenant scope', () => {
  assert.deepEqual(directoryAuditSecurityIncident(tenant, source), {
    organizationId: tenant.organizationId,
    customerTenantId: tenant.id,
    eventType: 'security.directory_change',
    category: 'error',
    severity: 'critical',
    title: 'Authentication methods changed',
    description: source.activityDisplayName,
    dedupeKey: 'security:directory-audit:audit-1',
    source: 'microsoft.directoryAudit',
    actionUrl: '/what-changed?tenantId=tenant%201&from=2026-11-11T10%3A00%3A00.000Z',
    actionLabel: 'Investigate change',
    metadata: {
      microsoftAuditId: source.microsoftAuditId,
      eventDateTime: eventDateTime.toISOString(),
      result: source.result,
      category: source.category,
    },
  })
})

test('directory audit security classes preserve precedence and omit unrelated activity', () => {
  const cases = [
    ['Reset password', 'high', 'Password-related change detected'],
    ['Update application registration', 'high', 'Application registration changed'],
    ['Add service principal', 'high', 'Application registration changed'],
    ['Assign administrator role', 'critical', 'Administrative role changed'],
    ['Change MFA and role', 'critical', 'Authentication methods changed'],
  ] as const
  for (const [activityDisplayName, severity, title] of cases) {
    const incident = directoryAuditSecurityIncident(tenant, { ...source, activityDisplayName })
    assert.equal(incident?.severity, severity)
    assert.equal(incident?.title, title)
  }
  assert.equal(directoryAuditSecurityIncident(tenant, {
    ...source, activityDisplayName: 'Update display name',
  }), null)
})


test('failed and unknown audit outcomes never claim that a directory change succeeded', () => {
  for (const activityDisplayName of ['Reset password', 'Assign administrator role', 'Update application registration', 'Change MFA']) {
    const failed = directoryAuditSecurityIncident(tenant, { ...source, activityDisplayName, result: 'failure' })
    assert.equal(failed?.title, 'Directory security operation failed')
    assert.equal(failed?.dedupeKey, 'security:directory-audit:audit-1')
    for (const result of [null, 'timeout', 'unknownFutureValue']) {
      const unknown = directoryAuditSecurityIncident(tenant, { ...source, activityDisplayName, result })
      assert.equal(unknown?.title, 'Directory security activity detected')
      assert.equal(unknown?.metadata?.result, result)
    }
  }
})
