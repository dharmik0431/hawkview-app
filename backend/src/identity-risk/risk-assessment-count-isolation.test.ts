import assert from 'node:assert/strict'
import test from 'node:test'
import { IdentityRiskController } from './identity-risk.controller.js'
import { IdentityRiskService } from './identity-risk.service.js'
import type { AuthenticatedRequest } from '../auth/auth.types.js'

test('real service authorization rejects foreign organization before count/source reads', async () => {
  let tenantReads = 0
  let riskReads = 0
  const service = new IdentityRiskService({
    user: { findUnique: async () => ({ disabledAt: null, memberships: [{ organizationId: 'org-a', role: 'MSP_OWNER' }] }) },
    customerTenant: { findFirst: async ({ where }: any) => {
      tenantReads++
      assert.equal(where.id, 'tenant-b')
      assert.deepEqual(where.organizationId.in, ['org-a'])
      return null
    } },
    identityRiskOperationalControl: { findMany: async () => { riskReads++; throw new Error('Must not read risk data') } },
  } as any, undefined, { read: async () => { riskReads++; throw new Error('Must not hydrate tenant data') } } as any)
  const controller = new IdentityRiskController(service)
  const request = { auth: { subject: 'org-a-user', email: 'synthetic@example.invalid' } } as AuthenticatedRequest
  await assert.rejects(() => controller.assessment(request, 'tenant-b', 'true'), /Tenant access denied/)
  assert.equal(tenantReads, 1)
  assert.equal(riskReads, 0)
})

test('disabled identity cannot trigger tenant count lookup', async () => {
  const service = new IdentityRiskService({
    user: { findUnique: async () => ({ disabledAt: new Date(), memberships: [] }) },
    customerTenant: { findFirst: async () => { throw new Error('Must not look up tenant') } },
  } as any)
  const controller = new IdentityRiskController(service)
  await assert.rejects(() => controller.assessment({ auth: { subject: 'disabled' } } as AuthenticatedRequest, 'tenant-b', 'true'), /Tenant access denied/)
})
