import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { TenantVisitLeaseLostError } from '../tenants/tenant-visit-lease-error.js'
import { MicrosoftConsentService } from './microsoft-consent.service.js'

for (const mode of ['CUSTOMER_MANAGED', 'HAWKVIEW_MANAGED'] as const) {
  for (const token of ['graph', 'exchange', 'management-context', 'management-token'] as const) {
    test(`${mode} ${token} token preparation carries exact visit authority and preserves loss`, async () => {
      const owner = { organizationId: randomUUID(), customerTenantId: randomUUID(), token: randomUUID(),
        generation: 2n, expiresAt: new Date(Date.now() + 60_000) }
      const connector = { clientId: randomUUID(), homeTenantId: randomUUID(), credentialReference: `encrypted-secret:${randomUUID()}` }
      const input = { ...connector, connectionMode: mode, microsoftTenantId: randomUUID() }
      let reads = 0
      const lost = new TenantVisitLeaseLostError()
      const service = new MicrosoftConsentService({ platformMicrosoftConnector: { findUnique: async () => connector } } as never,
        { access: async (reference: string, actual: unknown) => {
          reads++
          assert.equal(reference, connector.credentialReference)
          assert.equal(actual, owner)
          throw lost
        } } as never)
      ;(service as any).requestAccessToken = async () => assert.fail('owner loss must stop before provider token work')
      const pending = token === 'graph' ? service.getTenantAccessToken(input, owner)
        : token === 'exchange' ? service.getTenantExchangeAccessToken(input, owner)
        : token === 'management-context' ? service.getTenantManagementActivityContext(input, owner)
        : service.getTenantManagementActivityAccessToken(input, owner)
      await assert.rejects(pending, (error: unknown) => error === lost)
      assert.equal(reads, 1)
    })
  }
}

for (const token of ['captured-graph', 'captured-exchange', 'directory-role'] as const) {
  test(`${token} preserves an owned reseal refusal instead of classifying it as missing credentials`, async () => {
    const owner = { organizationId: randomUUID(), customerTenantId: randomUUID(), token: randomUUID(),
      generation: 3n, expiresAt: new Date(Date.now() + 60_000) }
    const revision = randomUUID()
    const authority = { configurationRevision: revision, clientId: randomUUID(), homeTenantId: randomUUID(),
      credentialReference: `encrypted-secret:${revision}` }
    const lost = new TenantVisitLeaseLostError()
    const service = new MicrosoftConsentService({} as never, { access: async (reference: string, actual: unknown) => {
      assert.equal(reference, authority.credentialReference)
      assert.equal(actual, owner)
      throw lost
    } } as never)
    ;(service as any).requestAccessToken = async () => assert.fail('no provider request after displaced reseal')
    const pending = token === 'directory-role'
      ? service.getCapturedDirectoryRoleToken(authority, randomUUID(), Date.now() + 30_000, owner)
      : service.getCapturedManagedAccessToken(authority, randomUUID(), token === 'captured-exchange', owner)
    await assert.rejects(pending, (error: unknown) => error === lost)
  })
}
