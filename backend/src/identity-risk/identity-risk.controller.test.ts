import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuthenticatedRequest } from '../auth/auth.types.js'
import { IdentityRiskController } from './identity-risk.controller.js'
import type { IdentityRiskService } from './identity-risk.service.js'

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
