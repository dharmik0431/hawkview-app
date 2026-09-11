import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import { IdentityRiskService } from '../identity-risk/identity-risk.service.js'

/** The gates themselves, against the REAL implementation.
 *
 * WHY THIS FILE EXISTS, and it is the sharpest instance of the day's pattern.
 * `risky-users-authorization.test.ts` stubs `authorizeRiskyUsersRead` and asserts
 * the controller returns whatever gate it is handed. That tests the controller's
 * plumbing. It does NOT test that any gate is ever consulted — and a mutation
 * deleting the operator kill switch from the service left all five of those tests
 * passing.
 *
 * So the test written specifically because PM warned that an authorization test
 * can pass without reaching the guard did exactly that. The controller tests stay
 * — they cover the plumbing, which is real — and these cover the decision.
 */

const settings: Record<string, string | undefined> = {
  HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global',
  HAWKVIEW_IDENTITY_RISK_MODE: 'shadow',
  HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-v1',
  HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: 'synthetic',
  HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: undefined,
  SECRET_ENCRYPTION_KEY: '52'.repeat(32),
  DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
}

async function configured(work: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  try { await work() } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
}

const ORG = '00000000-0000-0000-0000-000000000001'
const TENANT = '00000000-0000-0000-0000-000000000002'

const identity = { subject: 'auth0|caller' } as never

/** A Prisma double carrying only what the three gates read. */
function service(options: {
  role?: string
  tenantFound?: boolean
  userDisabled?: boolean
  hardDisabled?: boolean
}) {
  const prisma = {
    user: {
      findUnique: async () => ({
        disabledAt: options.userDisabled ? new Date() : null,
        memberships: [{ organizationId: ORG, role: options.role ?? 'MSP_OWNER' }],
      }),
    },
    customerTenant: {
      findFirst: async () => (options.tenantFound === false ? null : { id: TENANT, organizationId: ORG }),
    },
    identityRiskOperationalControl: {
      findMany: async () => (options.hardDisabled
        ? [{ controlType: 'EVALUATION_HARD_DISABLED' }]
        : []),
    },
  }
  return new IdentityRiskService(prisma as never) as unknown as {
    authorizeRiskyUsersRead: (identity: unknown, tenantId: string) => Promise<{ gate: string | null; tenant?: { evidenceDetailAllowed: boolean } }>
  }
}

test('the operator kill switch is actually consulted', async () => {
  await configured(async () => {
    // THE ASSERTION THE CONTROLLER TESTS COULD NOT MAKE. Deleting the kill-switch
    // check from the service leaves every controller test green, because they stub
    // the method that contains it. This one calls the real thing.
    const halted = await service({ hardDisabled: true }).authorizeRiskyUsersRead(identity, TENANT)
    assert.equal(halted.gate, 'EVALUATION_DISABLED')

    // POSITIVE CONTROL: the same double with no active control returns no gate, so
    // the assertion above is about the switch rather than a path that always
    // refuses.
    const open = await service({}).authorizeRiskyUsersRead(identity, TENANT)
    assert.equal(open.gate, null)
  })
})

test('a tenant outside the caller organizations throws rather than returning a gate', async () => {
  await configured(async () => {
    // Cross-tenant must stay an exception. Returning it as an "unavailable" would
    // make a permission failure indistinguishable from an absent assessment —
    // this feature's own defect pointed at access control.
    await assert.rejects(
      () => service({ tenantFound: false }).authorizeRiskyUsersRead(identity, 'someone-elses-tenant'),
      (error: unknown) => error instanceof ForbiddenException)

    // And a disabled user is refused the same way.
    await assert.rejects(
      () => service({ userDisabled: true }).authorizeRiskyUsersRead(identity, TENANT),
      (error: unknown) => error instanceof ForbiddenException)
  })
})

test('the role tier is decided by the service, not by the endpoint', async () => {
  await configured(async () => {
    // `evidenceDetailAllowed` is what gates naming, and it is computed from the
    // membership role in the same place every other identity-risk read computes
    // it — so the endpoint cannot widen it by accident.
    for (const role of ['MSP_OWNER', 'MSP_ADMIN']) {
      const permitted = await service({ role }).authorizeRiskyUsersRead(identity, TENANT)
      assert.equal(permitted.tenant?.evidenceDetailAllowed, true, `${role} should see names`)
    }
    for (const role of ['MSP_TECHNICIAN', 'MSP_VIEWER']) {
      const restricted = await service({ role }).authorizeRiskyUsersRead(identity, TENANT)
      assert.equal(restricted.gate, null, `${role} should still reach the page`)
      assert.equal(restricted.tenant?.evidenceDetailAllowed, false, `${role} should not see names`)
    }
  })
})
