import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { IdentityRiskController } from './identity-risk.controller.js'
import type { IdentityRiskService } from './identity-risk.service.js'
import type { RiskAssessmentDto } from './identity-risk-assessment.contract.js'

const auth = { subject: 'auth-user', email: 'owner@example.com' }
const request = { auth } as AuthenticatedRequest

test('read routes forward only authenticated scope, tenant, and bounded pagination inputs', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const service = {
    summary: async (...args: unknown[]) => {
      calls.push({ method: 'summary', args })
      return { ok: true }
    },
    findings: async (...args: unknown[]) => {
      calls.push({ method: 'findings', args })
      return { ok: true }
    },
    findingDetail: async (...args: unknown[]) => {
      calls.push({ method: 'findingDetail', args })
      return { ok: true }
    },
    microsoftRiskyUsers: async (...args: unknown[]) => {
      calls.push({ method: 'microsoftRiskyUsers', args })
      return { ok: true }
    },
    investigationAccess: async (...args: unknown[]) => { calls.push({ method: 'investigationAccess', args }); return { version: 1, allowed: true } },
    mailboxInvestigation: async (...args: unknown[]) => { calls.push({ method: 'mailboxInvestigation', args }); return { version: 1, status: 'UNAVAILABLE', mailbox: null } },
  } as unknown as IdentityRiskService
  const controller = new IdentityRiskController(service)

  await controller.summary(request, 'tenant-1')
  await controller.findings(request, 'tenant-1', '50', 'cursor-1')
  await controller.findingDetail(request, 'tenant-1', 'finding-1')
  await controller.riskyUsers(request, 'tenant-1', '25', 'cursor-2')
  await controller.investigationAccess(request, 'tenant-1')
  await controller.mailboxInvestigation(request, 'tenant-1', 'finding-1')

  assert.deepEqual(calls, [
    { method: 'summary', args: [auth, 'tenant-1'] },
    {
      method: 'findings',
      args: [auth, 'tenant-1', { limit: '50', cursor: 'cursor-1' }],
    },
    { method: 'findingDetail', args: [auth, 'tenant-1', 'finding-1'] },
    {
      method: 'microsoftRiskyUsers',
      args: [auth, 'tenant-1', { limit: '25', cursor: 'cursor-2' }],
    },
    { method: 'investigationAccess', args: [auth, 'tenant-1'] },
    { method: 'mailboxInvestigation', args: [auth, 'tenant-1', 'finding-1'] },
  ])
})

test('assessment summary is explicit opt-in; old v1 root shape and authenticated arguments remain unchanged', async () => {
  const dto = { version: 1, schemaVersion: 'hawkview-risk-assessment/v1', meta: { evaluatedAt: null, status: 'NOT_EVALUATED' }, sources: [], rules: [], users: [], page: { hasMore: false, nextCursor: null } } as unknown as RiskAssessmentDto
  const calls: unknown[][] = []
  const service = { assessment: async (...args: unknown[]) => { calls.push(args); return dto } } as unknown as IdentityRiskService
  const controller = new IdentityRiskController(service)
  assert.equal(await controller.assessment(request, 'tenant-1'), dto)
  assert.equal(await controller.assessment(request, 'tenant-1', 'false'), dto)
  const result = await controller.assessment(request, 'tenant-1', 'true')
  assert.deepEqual(result, { ...dto, summary: { scope: 'TENANT', asOf: null, currentUsers: { value: null, accuracy: 'UNKNOWN' } } })
  assert.equal('summary' in dto, false)
  assert.deepEqual(calls, Array.from({ length: 3 }, () => [auth, 'tenant-1']))
  for (const value of ['', 'TRUE', '1', true, null, ['true', 'false'], { value: 'true' }])
    await assert.rejects(() => controller.assessment(request, 'tenant-1', value), /includeSummary must be true or false/)
  assert.equal(calls.length, 3, 'invalid options must not initiate an assessment read')
})

test('opt-in summary cannot bypass failed authorization or share a previous tenant response', async () => {
  const service = { assessment: async (_identity: unknown, tenant: string) => {
    if (tenant !== 'authorized-tenant') throw new Error('Tenant access denied')
    return { version: 1, meta: { evaluatedAt: null } } as RiskAssessmentDto
  } } as unknown as IdentityRiskService
  const controller = new IdentityRiskController(service)
  assert.ok('summary' in await controller.assessment(request, 'authorized-tenant', 'true'))
  await assert.rejects(() => controller.assessment(request, 'foreign-tenant', 'true'), /Tenant access denied/)
})
