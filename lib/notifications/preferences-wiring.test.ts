import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

test('workspace policy is explicitly scoped and uses server authorization', () => {
  const page = source('app/(protected)/settings/alerts/page.tsx')
  const row = source('components/alerts/disposition-row.tsx')
  assert.match(page, /params: \{ organizationId: scope\.organizationId \}/)
  assert.match(page, /loaded\.canManagePolicy/)
  assert.match(page, /canEditDisposition\(row, loaded\.canManagePolicy\)/)
  assert.match(row, /disabled=\{!editable \|\| save\.kind === 'SAVING'\}/)
  assert.doesNotMatch(row, /row\.mapped\)/)
})

test('personal preferences always send explicit organization scope', () => {
  const profile = source('app/(protected)/profile/notifications/page.tsx')
  const admin = source('app/(protected)/settings/team/page.tsx')
  for (const page of [profile, admin]) {
    assert.match(page, /readNotificationPreferences/)
    assert.match(page, /notificationPreferencesPatch/)
    assert.match(page, /organizationId/)
  }
  assert.match(profile, /params: \{ organizationId: scope\.organizationId \}/)
  assert.match(admin, /params: \{ organizationId: selectedOrganizationId \}/)
})

test('personal severity remains editable while unsupported digest choices remain closed', () => {
  const profile = source('app/(protected)/profile/notifications/page.tsx')
  const admin = source('app/(protected)/settings/team/page.tsx')
  for (const page of [profile, admin]) {
    assert.match(page, /Minimum personal severity/)
    assert.match(page, /NOTIFICATION_SEVERITIES/)
    assert.match(page, /minimumSeverity:/)
    assert.match(page, /Daily and weekly digests are not available/)
    assert.match(page, /No digest.*supported/)
  }
  assert.doesNotMatch(profile, /<option value="daily">/)
  assert.doesNotMatch(admin, /<option value="weekly">/)
})

test('all notification preference surfaces use the identity and workspace request guard', () => {
  const profile = source('app/(protected)/profile/notifications/page.tsx')
  const policy = source('app/(protected)/settings/alerts/page.tsx')
  const admin = source('app/(protected)/settings/team/page.tsx')
  for (const page of [profile, policy, admin]) {
    assert.match(page, /NotificationScopedRequestGuard/)
    assert.match(page, /notificationRequestScope/)
    assert.match(page, /isCurrent/)
  }
})

test('email opt-in and critical in-app exceptions are explained truthfully', () => {
  const profile = source('app/(protected)/profile/notifications/page.tsx')
  const admin = source('app/(protected)/settings/team/page.tsx')
  assert.match(profile, /does not turn the sender on/)
  assert.match(profile, /does not activate unavailable delivery channels/)
  assert.match(profile, /Critical in-app notifications remain visible/)
  assert.match(admin, /Critical in-app notifications remain visible/)
  assert.match(admin, /emailAvailabilityCopy/)
})
