import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { PrismaService } from '../prisma/prisma.service.js'
import { TenantsService } from './tenants.service.js'

const identity = { subject: 'auth-user', email: 'owner@example.com' }
const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'

const activeUser = {
  id: '33333333-3333-4333-8333-333333333333',
  disabledAt: null,
  memberships: [{
    organizationId,
    organization: { onboardingCompletedAt: new Date('2026-08-23T12:00:00.000Z') },
  }],
}

const tenant = (overrides: Record<string, unknown> = {}) => ({
  id: tenantId,
  displayName: 'Contoso',
  primaryDomain: 'contoso.com',
  microsoftTenantId: '44444444-4444-4444-8444-444444444444',
  connection: {
    connectionMode: 'HAWKVIEW_MANAGED',
    status: 'CONNECTED',
    clientId: null,
    credentialReference: null,
    consentedPermissions: ['Organization.Read.All', 'ReportSettings.Read.All'],
    exchangeReadOnlyEnabledAt: null,
    exchangeReadOnlySkippedAt: null,
    reportSettingsLastCheckedAt: null,
    reportIdentifiersVisible: null,
    reportVisibilityDeferredAt: null,
    onboardingCompletedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    ...overrides,
  },
})

test('derives resumable steps from durable tenant truth', async () => {
  let current = tenant()
  const prisma = {
    user: { findUnique: async () => activeUser },
    customerTenant: { findFirst: async () => current },
  } as unknown as PrismaService
  const service = new TenantsService(prisma, {} as never, {} as never)

  const initial = await service.getTenantOnboardingForIdentity(identity, tenantId)
  assert.equal(initial.steps.microsoftAccess.status, 'VERIFIED')
  assert.equal(initial.steps.exchangeReadOnly.status, 'CONSENT_REQUIRED')
  assert.equal(initial.steps.reportVisibility.status, 'CHECK_REQUIRED')
  assert.equal(initial.canFinish, false)

  current = tenant({
    exchangeReadOnlySkippedAt: new Date('2026-08-23T13:00:00.000Z'),
    reportIdentifiersVisible: true,
    reportSettingsLastCheckedAt: new Date('2026-08-23T13:01:00.000Z'),
  })
  const resolved = await service.getTenantOnboardingForIdentity(identity, tenantId)
  assert.equal(resolved.steps.exchangeReadOnly.status, 'DEFERRED')
  assert.equal(resolved.steps.reportVisibility.status, 'VERIFIED')
  assert.equal(resolved.canFinish, true)
})

test('report verification persists only the read result and never mutates Microsoft', async () => {
  let updateData: unknown
  const prisma = {
    user: { findUnique: async () => activeUser },
    customerTenant: { findFirst: async () => tenant() },
    tenantConnection: {
      update: async ({ data }: { data: unknown }) => { updateData = data },
    },
  } as unknown as PrismaService
  const service = new TenantsService(prisma, {
    readTenantReportPrivacySetting: async () => ({
      status: 'READY', identifiersVisible: true, retryable: false,
    }),
  } as never, {} as never)
  const result = await service.verifyReportVisibilityForIdentity(identity, tenantId)
  assert.equal(result.verification.status, 'READY')
  assert.equal((updateData as { reportIdentifiersVisible?: unknown }).reportIdentifiersVisible, true)
  assert.equal((updateData as { reportVisibilityDeferredAt?: unknown }).reportVisibilityDeferredAt, null)
  assert.ok((updateData as { reportSettingsLastCheckedAt?: unknown }).reportSettingsLastCheckedAt instanceof Date)
})

test('a consent callback nonce is accepted at most once', async () => {
  const nonce = 'nonce-value'
  let consumed = false
  const prisma = {
    microsoftConsentAttempt: {
      findUnique: async () => ({
        id: 'attempt-1',
        organizationId,
        customerTenantId: tenantId,
        flow: 'EXCHANGE_READ_ONLY',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: consumed ? new Date() : null,
      }),
      updateMany: async () => {
        if (consumed) return { count: 0 }
        consumed = true
        return { count: 1 }
      },
    },
  } as unknown as PrismaService
  const service = new TenantsService(prisma, {
    hashConsentNonce: (value: string) => createHash('sha256').update(value).digest('hex'),
  } as never, {} as never)
  const state = {
    organizationId,
    customerTenantId: tenantId,
    nonce,
    flow: 'exchange-readonly' as const,
  }
  assert.equal(await (service as any).consumeConsentAttempt(state), 'attempt-1')
  assert.equal(await (service as any).consumeConsentAttempt(state), null)
})

test('foreign tenant onboarding actions fail before any write', async () => {
  let writes = 0
  const prisma = {
    user: { findUnique: async () => activeUser },
    customerTenant: { findFirst: async () => null },
    tenantConnection: { update: async () => { writes += 1 } },
  } as unknown as PrismaService
  const service = new TenantsService(prisma, {} as never, {} as never)

  await assert.rejects(
    () => service.deferReportVisibilityForIdentity(identity, tenantId),
    /Customer tenant was not found/,
  )
  assert.equal(writes, 0)
})

test('finishing an already completed onboarding is idempotent', async () => {
  let writes = 0
  const prisma = {
    user: { findUnique: async () => activeUser },
    customerTenant: {
      findFirst: async () => tenant({
        onboardingCompletedAt: new Date('2026-08-23T13:05:00.000Z'),
        exchangeReadOnlySkippedAt: new Date('2026-08-23T13:00:00.000Z'),
        reportVisibilityDeferredAt: new Date('2026-08-23T13:01:00.000Z'),
      }),
    },
    tenantConnection: { updateMany: async () => { writes += 1 } },
  } as unknown as PrismaService
  const service = new TenantsService(prisma, {} as never, {} as never)

  const result = await service.completeTenantOnboardingForIdentity(identity, tenantId)
  assert.equal(result.completedAt, '2026-08-23T13:05:00.000Z')
  assert.equal(writes, 0)
})

test('migration backfills legacy tenants complete while new rows remain resumable', () => {
  const sql = readFileSync(new URL(
    '../../prisma/migrations/20260823213000_add_resumable_tenant_onboarding/migration.sql',
    import.meta.url,
  ), 'utf8')
  assert.match(sql, /UPDATE "tenant_connections"/)
  assert.match(sql, /"onboarding_completed_at" = COALESCE\("consented_at", "created_at"\)/)
  assert.doesNotMatch(sql, /ALTER COLUMN "onboarding_completed_at" SET DEFAULT/)
  assert.match(sql, /microsoft_consent_attempts_state_hash_key/)
  assert.match(sql, /microsoft_consent_attempts_customer_tenant_id_organization_id_fkey/)
})
