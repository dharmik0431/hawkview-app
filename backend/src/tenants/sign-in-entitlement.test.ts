import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveSignInEntitlement } from './sign-in-entitlement.js'

const now = new Date('2026-08-21T18:00:00.000Z')
const current = {
  status: 'SUCCEEDED',
  lastSuccessfulAt: new Date('2026-08-21T17:00:00.000Z'),
}

test('recognizes Business Premium Entra P1 by canonical service-plan name or id', () => {
  for (const servicePlan of [
    {
      servicePlanName: 'AAD_PREMIUM',
      servicePlanId: 'unrelated',
      provisioningStatus: 'Success',
    },
    {
      servicePlanName: 'renamed-by-microsoft',
      servicePlanId: '41781FB2-BC02-4B7C-BD55-B576C07BB09D',
      provisioningStatus: 'SUCCESS',
    },
  ]) {
    assert.equal(
      deriveSignInEntitlement({
        licenses: [{ servicePlans: [servicePlan] }],
        licenseSync: current,
        now,
      }),
      'PREMIUM',
    )
  }
})

test('recognizes Entra P2 and does not require a product sku-name guess', () => {
  assert.equal(
    deriveSignInEntitlement({
      licenses: [
        {
          servicePlans: [
            {
              servicePlanName: 'AAD_PREMIUM_P2',
              servicePlanId: 'eec0eb4f-6444-4f95-aba0-50c24d67f998',
              provisioningStatus: 'Success',
            },
          ],
        },
      ],
      licenseSync: current,
      now,
    }),
    'PREMIUM',
  )
})

test('classifies a complete current inventory without an enabled premium plan as non-premium', () => {
  assert.equal(
    deriveSignInEntitlement({
      licenses: [
        {
          servicePlans: [
            {
              servicePlanName: 'EXCHANGE_S_STANDARD',
              servicePlanId: 'plan-1',
              provisioningStatus: 'Success',
            },
          ],
        },
      ],
      licenseSync: current,
      now,
    }),
    'NON_PREMIUM',
  )
})

test('fails closed for stale, future, incomplete, malformed, or provisioning evidence', () => {
  const probes = [
    {
      licenses: [{ servicePlans: [] }],
      licenseSync: {
        status: 'SUCCEEDED',
        lastSuccessfulAt: new Date('2026-08-20T10:00:00.000Z'),
      },
    },
    {
      licenses: [{ servicePlans: [] }],
      licenseSync: {
        status: 'SUCCEEDED',
        lastSuccessfulAt: new Date('2026-08-21T19:00:00.000Z'),
      },
    },
    { licenses: [{ servicePlans: null }], licenseSync: current },
    {
      licenses: [
        {
          servicePlans: [
            {
              servicePlanName: 'AAD_PREMIUM',
              servicePlanId: '41781fb2-bc02-4b7c-bd55-b576c07bb09d',
              provisioningStatus: 'PendingInput',
            },
          ],
        },
      ],
      licenseSync: current,
    },
    {
      licenses: [{ servicePlans: [Object.create({ servicePlanName: 'AAD_PREMIUM' })] }],
      licenseSync: current,
    },
  ]

  for (const probe of probes) {
    assert.equal(deriveSignInEntitlement({ ...probe, now }), 'UNVERIFIED')
  }
})
