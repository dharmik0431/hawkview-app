import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeBusinessDomain,
  normalizeTimeZone,
  organizationProfileFromWorkspace,
  organizationSettingsPayload,
  workspaceOnboardingState,
} from './workspace-onboarding.ts'

const organizationId = '123e4567-e89b-42d3-a456-426614174000'

function session(workspaceOnboarding?: unknown) {
  const onboarding =
    workspaceOnboarding && typeof workspaceOnboarding === 'object'
      ? (workspaceOnboarding as Record<string, unknown>)
      : null
  const onboardingOrganizationId =
    typeof onboarding?.organizationId === 'string'
      ? onboarding.organizationId.toLowerCase()
      : null
  const value: Record<string, unknown> = {
    user: {
      id: 'user-1',
      email: 'owner@example.test',
      displayName: 'Owner',
      timeZone: null,
      dateFormat: 'yyyy-MM-dd',
      timeFormat: '12h',
      platformRole: 'STANDARD_USER',
      memberships: onboardingOrganizationId
        ? [
            {
              id: 'membership-1',
              role: 'MSP_OWNER',
              status: 'ACTIVE',
              organization: {
                id: onboardingOrganizationId,
                name: 'Northwind IT',
                slug: 'internal',
                status: 'ACTIVE',
              },
            },
          ]
        : [],
    },
  }
  if (arguments.length) value.workspaceOnboarding = workspaceOnboarding
  return value as never
}

test('direct founder onboarding is normalized from the explicit backend contract', () => {
  assert.deepEqual(
    workspaceOnboardingState(
      session({
        required: true,
        organizationId: organizationId.toUpperCase(),
        organizationName: '  Northwind   IT  ',
        businessDomain: 'Northwind.EXAMPLE',
        businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
        timeZone: 'America/Toronto',
      })
    ),
    {
      state: 'ready',
      onboarding: {
        required: true,
        organizationId,
        organizationName: 'Northwind IT',
        businessDomain: 'northwind.example',
        businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
        timeZone: 'America/Toronto',
      },
    }
  )
})

test('selected organization profile accepts only the closed completed response', () => {
  const completedAt = new Date(Date.now() - 60_000).toISOString()
  assert.deepEqual(
    organizationProfileFromWorkspace({
      id: organizationId,
      name: 'Northwind IT',
      businessDomain: 'northwind.example',
      businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
      timeZone: 'America/Toronto',
      onboardingCompletedAt: completedAt,
      ignored: { secret: 'drop-me' },
    }),
    {
      required: false,
      organizationId,
      organizationName: 'Northwind IT',
      businessDomain: 'northwind.example',
      businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
      timeZone: 'America/Toronto',
    }
  )
  assert.equal(
    organizationProfileFromWorkspace({
      id: organizationId,
      name: 'Northwind IT',
      businessDomain: '127.0.0.1',
      businessDomainVerification: 'VERIFIED',
      timeZone: 'UTC',
      onboardingCompletedAt: completedAt,
    }),
    null
  )
})

test('completed founders and invited members skip setup only when backend says required false', () => {
  const completed = workspaceOnboardingState(
    session({
      required: false,
      organizationId,
      organizationName: 'Northwind IT',
      businessDomain: null,
      businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
      timeZone: 'UTC',
    })
  )
  assert.equal(completed.state, 'ready')
  assert.equal(completed.state === 'ready' && completed.onboarding.required, false)

  assert.deepEqual(
    workspaceOnboardingState(
      session({
        required: false,
        organizationId: null,
        organizationName: null,
        businessDomain: null,
        businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
        timeZone: null,
      })
    ),
    {
      state: 'ready',
      onboarding: {
        required: false,
        organizationId: null,
        organizationName: null,
        businessDomain: null,
        businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
        timeZone: null,
      },
    }
  )
})

test('rolling-deploy absence is legacy while present malformed state fails closed', () => {
  assert.deepEqual(workspaceOnboardingState(session()), {
    state: 'legacy',
    onboarding: null,
  })

  const hostile = Object.create({ required: false })
  assert.equal(workspaceOnboardingState(session(hostile)).state, 'unavailable')
  assert.equal(workspaceOnboardingState(session(null)).state, 'unavailable')
  assert.equal(
    workspaceOnboardingState(
      session({
        required: true,
        organizationId: null,
        organizationName: 'Northwind',
        businessDomain: null,
        businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
        timeZone: 'UTC',
      })
    ).state,
    'unavailable'
  )
  assert.equal(
    workspaceOnboardingState(
      session({
        required: false,
        organizationId,
        organizationName: 'Northwind',
        businessDomain: 'https://attacker.example/steal',
        businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
        timeZone: 'UTC',
      })
    ).state,
    'unavailable'
  )
})

test('organization payload accepts only bounded names, exact domains, and IANA time zones', () => {
  assert.deepEqual(normalizeBusinessDomain(' Example.COM '), 'example.com')
  assert.equal(normalizeBusinessDomain('https://example.com/path'), undefined)
  assert.equal(normalizeBusinessDomain('user@example.com'), undefined)
  assert.equal(normalizeBusinessDomain('127.0.0.1'), undefined)
  assert.equal(normalizeBusinessDomain('0x7f.0.0.1'), undefined)
  assert.equal(normalizeBusinessDomain('0177.0.0.1'), undefined)
  assert.equal(normalizeBusinessDomain('[2001:db8::1]'), undefined)
  assert.equal(normalizeBusinessDomain('exam\\ple.com'), undefined)
  assert.equal(normalizeBusinessDomain('%65xample.com'), undefined)
  assert.equal(normalizeBusinessDomain(`exam\u200bple.com`), undefined)
  assert.equal(normalizeBusinessDomain(`exam\u202eple.com`), undefined)
  assert.equal(normalizeBusinessDomain(`exam\ufeffple.com`), undefined)
  assert.equal(normalizeTimeZone('America/Toronto'), 'America/Toronto')
  assert.equal(normalizeTimeZone('not/a-real-zone'), null)

  assert.deepEqual(
    organizationSettingsPayload({
      organizationId,
      organizationName: ' Northwind IT ',
      businessDomain: '',
      timeZone: 'America/Toronto',
    }),
    {
      payload: {
        organizationId,
        organizationName: 'Northwind IT',
        businessDomain: null,
        timeZone: 'America/Toronto',
      },
    }
  )
  assert.equal(
    'error' in
      organizationSettingsPayload({
        organizationId,
        organizationName: '<script>',
        businessDomain: '',
        timeZone: 'UTC',
      }),
    true
  )
  assert.equal(
    'error' in
      organizationSettingsPayload({
        organizationId,
        organizationName: `North\u202ewind IT`,
        businessDomain: '',
        timeZone: 'UTC',
      }),
    true
  )
})

test('inactive organization state cannot drive or bypass onboarding', () => {
  const value = session({
    required: true,
    organizationId,
    organizationName: 'Northwind IT',
    businessDomain: null,
    businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
    timeZone: 'UTC',
  }) as any
  value.user.memberships[0].organization.status = 'SUSPENDED'
  assert.equal(workspaceOnboardingState(value).state, 'unavailable')
})
