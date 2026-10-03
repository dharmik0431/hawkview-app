import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  cancelTotpEnrollment,
  clearPendingTotpFactors,
  collectFactorRecords,
  factorFriendlyName,
  HAWKVIEW_AUTHENTICATOR_NAME,
  isFactorLimitExceeded,
  isFactorNameConflict,
  mfaEnrollmentFailureMessage,
  pendingTotpFactorIds,
  startTotpEnrollment,
  uniqueAuthenticatorName,
  type MfaEnrollmentClient,
} from './mfa-enrollment.ts'

const QR = 'data:image/svg+xml;utf-8,<svg/>'
const SECRET = 'JBSWY3DPEHPK3PXP'

/**
 * A provider stub that enforces the rule which causes the real lockout: at most
 * one factor per friendly name, and an unverified factor still occupies its name.
 *
 * NOTE ON FIDELITY: `@supabase/supabase-js` is not installed in this checkout, so
 * this stub is written to the documented provider contract and cannot be pinned
 * against the library's own types. `visibleToList` exists precisely because the
 * payload `listFactors()` returns has not been confirmed to include unverified
 * factors on the deployed version — the tests therefore cover both answers.
 */
function provider(options: {
  existing?: Array<{
    id: string
    friendly_name: string
    status: string
    factor_type?: string
  }>
  visibleToList?: boolean
  enrollFailure?: unknown
} = {}) {
  const factors = [...(options.existing ?? [])]
  const visible = options.visibleToList ?? true
  const calls: { enroll: string[]; unenroll: string[]; listed: number } = {
    enroll: [],
    unenroll: [],
    listed: 0,
  }
  const client: MfaEnrollmentClient = {
    listFactors: async () => {
      calls.listed += 1
      const exposed = visible ? factors : factors.filter((f) => f.status === 'verified')
      return {
        data: {
          all: exposed,
          totp: exposed.filter((f) => f.status === 'verified'),
        },
        error: null,
      }
    },
    unenroll: async ({ factorId }) => {
      calls.unenroll.push(factorId)
      const index = factors.findIndex((f) => f.id === factorId)
      if (index === -1) return { error: { message: 'factor not found' } }
      factors.splice(index, 1)
      return { error: null }
    },
    enroll: async ({ friendlyName }) => {
      calls.enroll.push(friendlyName)
      if (options.enrollFailure) return { data: null, error: options.enrollFailure }
      if (factors.some((f) => f.friendly_name === friendlyName)) {
        return {
          data: null,
          error: {
            code: 'mfa_factor_name_conflict',
            message:
              'A factor with the friendly name ' + friendlyName + ' for this user likely already exists',
          },
        }
      }
      const id = 'factor-' + (factors.length + 1)
      factors.push({ id, friendly_name: friendlyName, status: 'unverified', factor_type: 'totp' })
      return { data: { id, totp: { qr_code: QR, secret: SECRET } }, error: null }
    },
  }
  return { client, calls, factors }
}

const abandoned = {
  id: 'stale-1',
  friendly_name: HAWKVIEW_AUTHENTICATOR_NAME,
  status: 'unverified',
  factor_type: 'totp',
}
const working = {
  id: 'verified-1',
  friendly_name: HAWKVIEW_AUTHENTICATOR_NAME,
  status: 'verified',
  factor_type: 'totp',
}

test('NEGATIVE CONTROL: the stub really does reproduce the permanent lockout', async () => {
  // Without this, every assertion below could pass against a stub that simply
  // never conflicts, and the regression would be untested.
  const { client } = provider({ existing: [abandoned] })
  const naive = await client.enroll({
    factorType: 'totp',
    friendlyName: HAWKVIEW_AUTHENTICATOR_NAME,
  })
  assert.ok(naive.error, 'the stub accepted a duplicate name; it cannot prove the fix')
  assert.equal(isFactorNameConflict(naive.error), true)
  // And the old component's advice was unfollowable: it had no factor id to cancel.
  assert.equal(naive.data, null)
})

test('an abandoned enrollment is cleared and setup proceeds', async () => {
  const { client, calls, factors } = provider({ existing: [abandoned] })
  const outcome = await startTotpEnrollment(client, { uniqueToken: 'abc123xy' })

  assert.deepEqual(outcome, { ok: true, factorId: 'factor-1', qrCode: QR, secret: SECRET })
  assert.deepEqual(calls.unenroll, ['stale-1'], 'the stale factor must be removed')
  assert.deepEqual(calls.enroll, [HAWKVIEW_AUTHENTICATOR_NAME],
    'after cleanup the base name is free, so no fallback name should be needed')
  assert.equal(factors.some((f) => f.id === 'stale-1'), false)
})

test('a blocking factor invisible to listFactors still cannot strand the user', async () => {
  // This is the case the previous implementation could not recover from at all.
  const { client, calls } = provider({ existing: [abandoned], visibleToList: false })
  const outcome = await startTotpEnrollment(client, { uniqueToken: 'Zz-99!!aa' })

  assert.equal(outcome.ok, true)
  assert.deepEqual(calls.unenroll, [], 'nothing was visible to remove')
  assert.deepEqual(calls.enroll, [
    HAWKVIEW_AUTHENTICATOR_NAME,
    'HawkView Authenticator (zz99aa)',
  ], 'the conflict must be retried under a distinct name')
})

test('a verified authenticator is never removed by enrollment or cancellation', async () => {
  const { client, calls, factors } = provider({ existing: [working] })
  await startTotpEnrollment(client, { uniqueToken: 'deadbeef' })
  await cancelTotpEnrollment(client, null)

  assert.equal(calls.unenroll.includes('verified-1'), false,
    'removing a working authenticator would lock the user out of the product')
  assert.equal(factors.some((f) => f.id === 'verified-1'), true)
})

test('enrollment alongside a verified factor uses a distinct name rather than failing', async () => {
  const { client, calls } = provider({ existing: [working] })
  const outcome = await startTotpEnrollment(client, { uniqueToken: 'f00dcafe' })

  assert.equal(outcome.ok, true)
  assert.deepEqual(calls.enroll, [
    HAWKVIEW_AUTHENTICATOR_NAME,
    'HawkView Authenticator (f00dcafe)',
  ])
})

test('cancellation clears server state even when the factor id was never returned', async () => {
  // The lockout path: enroll() failed, so the component holds no factor id.
  const { client, calls, factors } = provider({ existing: [abandoned] })
  const result = await cancelTotpEnrollment(client, null)

  assert.equal(result.removed, 1)
  assert.deepEqual(calls.unenroll, ['stale-1'])
  assert.equal(factors.length, 0)
})

test('a provider success with no usable secret is reported as failure, not success', async () => {
  const client: MfaEnrollmentClient = {
    listFactors: async () => ({ data: { all: [], totp: [] }, error: null }),
    unenroll: async () => ({ error: null }),
    enroll: async () => ({ data: { id: 'factor-x', totp: { qr_code: '', secret: '' } }, error: null }),
  }
  const outcome = await startTotpEnrollment(client, { uniqueToken: 'aaaaaaaa' })
  assert.deepEqual(outcome, { ok: false, reason: 'unavailable' },
    'an empty QR code must not render as a working setup screen')
})

test('cleanup failures do not block enrollment', async () => {
  const client: MfaEnrollmentClient = {
    listFactors: async () => {
      throw new Error('network down')
    },
    unenroll: async () => ({ error: null }),
    enroll: async () => ({ data: { id: 'f1', totp: { qr_code: QR, secret: SECRET } }, error: null }),
  }
  const outcome = await startTotpEnrollment(client, { uniqueToken: 'bbbbbbbb' })
  assert.equal(outcome.ok, true, 'best-effort cleanup must not reinstate the lockout')
})

test('a listFactors error is not mistaken for an empty factor list', async () => {
  const unenrolled: string[] = []
  const result = await clearPendingTotpFactors({
    listFactors: async () => ({ data: { all: [abandoned] }, error: { message: 'unauthorized' } }),
    unenroll: async ({ factorId }) => {
      unenrolled.push(factorId)
      return { error: null }
    },
  })
  assert.deepEqual(result, { removed: 0, inspected: 0 })
  assert.deepEqual(unenrolled, [],
    'factors returned alongside an error must not be acted on')
})

test('pending factor selection keeps verified factors and tolerates both field shapes', () => {
  assert.deepEqual(pendingTotpFactorIds([abandoned, working]), ['stale-1'])
  assert.deepEqual(
    pendingTotpFactorIds([{ id: 'camel', status: 'unverified', factorType: 'totp' }]),
    ['camel']
  )
  // An unrecognised status is treated as not verified: a leftover factor is the
  // bug being fixed, while deleting a working one would be far worse.
  assert.deepEqual(pendingTotpFactorIds([{ id: 'odd', status: 'PENDING' }]), ['odd'])
  assert.deepEqual(pendingTotpFactorIds([{ id: 'up', status: 'VERIFIED' }]), [],
    'status comparison must be case-insensitive or verified factors get deleted')
  assert.deepEqual(pendingTotpFactorIds([{ id: 'untyped', status: 'unverified' }]), ['untyped'])
  assert.deepEqual(pendingTotpFactorIds([{ id: 'sms', status: 'unverified', factor_type: 'phone' }]), [])
  assert.deepEqual(pendingTotpFactorIds([abandoned, { ...abandoned }]), ['stale-1'],
    'duplicates across all/totp must not be unenrolled twice')
  assert.deepEqual(pendingTotpFactorIds(null), [])
  assert.deepEqual(pendingTotpFactorIds([null, 'x', 42, {}]), [])
})

test('factor records are read from whichever collection the provider populates', () => {
  assert.deepEqual(collectFactorRecords({ all: [abandoned] }), [abandoned])
  assert.deepEqual(collectFactorRecords({ totp: [working] }), [working])
  assert.deepEqual(collectFactorRecords(null), [])
  assert.deepEqual(collectFactorRecords({ all: 'nope' } as never), [])
  assert.equal(factorFriendlyName({ friendlyName: 'Camel' }), 'Camel')
  assert.equal(factorFriendlyName({ friendly_name: 'Snake' }), 'Snake')
  assert.equal(factorFriendlyName({}), null)
})

test('provider errors are classified across code, error_code and message shapes', () => {
  for (const error of [
    { code: 'mfa_factor_name_conflict' },
    { error_code: 'mfa_factor_name_conflict' },
    { message: 'A factor with the friendly name X for this user likely already exists' },
    { message: 'factor with this friendly_name already exists' },
    new Error('MFA factor conflict'),
  ]) {
    assert.equal(isFactorNameConflict(error), true, JSON.stringify(error))
  }
  for (const error of [
    { code: 'mfa_factor_limit_exceeded' },
    { message: 'too many factors enrolled' },
    { message: 'maximum number of enrolled factors reached' },
  ]) {
    assert.equal(isFactorLimitExceeded(error), true, JSON.stringify(error))
  }
  // An invalid code is a different failure and must not be read as a conflict,
  // or a mistyped digit would send the user to an administrator.
  for (const error of [null, undefined, {}, { message: 'Invalid TOTP code entered' }]) {
    assert.equal(isFactorNameConflict(error), false, JSON.stringify(error ?? null))
    assert.equal(isFactorLimitExceeded(error), false, JSON.stringify(error ?? null))
  }
})

test('the fallback name is distinct, bounded, and never collapses to the base name', () => {
  assert.equal(uniqueAuthenticatorName('A', 'Zz-99!!aabbccdd'), 'A (zz99aabb)')
  assert.equal(uniqueAuthenticatorName('A', '!!!!'), 'A',
    'with no usable entropy the base name is returned rather than "A ()"')
  assert.notEqual(
    uniqueAuthenticatorName(HAWKVIEW_AUTHENTICATOR_NAME, 'abcd1234'),
    HAWKVIEW_AUTHENTICATOR_NAME
  )
})

test('failure messages tell the user what to do and leak no provider text', () => {
  const messages = (['factor-limit', 'name-conflict', 'unavailable', 'failed'] as const).map(
    mfaEnrollmentFailureMessage
  )
  for (const message of messages) {
    assert.ok(message.length > 0)
    assert.doesNotMatch(message, /mfa_factor|friendly_name|undefined/)
  }
  // The old copy told users to "cancel it or refresh this page", neither of which
  // could clear server-side state. Recovery must name a route that exists.
  for (const reason of ['factor-limit', 'name-conflict'] as const) {
    assert.match(mfaEnrollmentFailureMessage(reason), /administrator/i)
  }
  assert.doesNotMatch(messages.join(' '), /refresh this page/i)
})

test('the enrollment screen is wired to recovery, not to a bare enroll call', () => {
  const component = readFileSync(
    new URL('../../components/auth/mfa-enrollment.tsx', import.meta.url),
    'utf8'
  )

  assert.match(component, /startTotpEnrollment\(/)
  assert.match(component, /cancelTotpEnrollment\(/)
  // The defect signature is the screen choosing the friendly name itself and
  // enrolling straight away: it cannot clear the leftover factor holding that
  // name, so the conflict becomes permanent. Forwarding the argument through
  // the narrow adapter is fine; hardcoding the name here is not.
  assert.doesNotMatch(component, /friendlyName:\s*['"]/,
    'the screen must not pin a literal authenticator name; recovery owns naming')
  assert.doesNotMatch(component, /An authenticator setup is already in progress/,
    'the unfollowable "cancel it or refresh this page" copy must stay removed')
  // Cancellation must not be gated on holding a factor id, which is exactly the
  // state a failed enroll() leaves behind.
  assert.doesNotMatch(component, /if \(supabase && enrollment\?\.factorId\)/)
  assert.doesNotMatch(component, /console\.|localStorage|sessionStorage/)
})
