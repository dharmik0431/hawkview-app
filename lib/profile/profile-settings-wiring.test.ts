import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const source = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8')

test('profile menu routes personal account settings away from the platform connector', () => {
  const menu = source('components/layout/user-menu.tsx')

  assert.match(menu, /id="user-menu-button"/)
  assert.match(menu, /href="\/profile"[\s\S]*Profile Settings/)
  assert.match(menu, /href="\/profile\/security"[\s\S]*Account &amp; Security/)
  assert.doesNotMatch(menu, /href="\/settings"/)
  assert.match(menu, /href="\/admin\/overview"/)
  assert.match(menu, /setTheme\('light'\)/)
  assert.match(menu, /setTheme\('dark'\)/)
  assert.match(menu, /await signOut\(\)/)
})

test('every profile navigation destination exists and has an explicit topbar title', () => {
  for (const path of [
    'app/(protected)/profile/page.tsx',
    'app/(protected)/profile/security/page.tsx',
    'app/(protected)/profile/notifications/page.tsx',
    'app/(protected)/profile/appearance/page.tsx',
  ]) {
    assert.equal(existsSync(join(process.cwd(), path)), true, `${path} must exist`)
  }

  const topbar = source('components/layout/topbar.tsx')
  assert.match(topbar, /'\/profile': 'Profile Settings'/)
  assert.match(topbar, /'\/profile\/security': 'Account & Security'/)
  assert.match(topbar, /'\/profile\/notifications': 'Notification Settings'/)
  assert.match(topbar, /'\/profile\/appearance': 'Appearance'/)
  assert.match(topbar, /'\/settings': 'Microsoft Connector'/)
})

test('security and notification pages fail honestly instead of fabricating state or hanging', () => {
  const security = source('app/(protected)/profile/security/page.tsx')
  assert.match(security, /Not reported/)
  assert.match(security, /Other active sessions are not listed/)
  assert.doesNotMatch(security, />Enrolled</)
  assert.doesNotMatch(security, /Reset 2FA/)
  assert.doesNotMatch(security, /Verification tokens are synchronized/)

  const notifications = source('app/(protected)/profile/notifications/page.tsx')
  assert.match(notifications, /Notification preferences could not be loaded/)
  assert.match(notifications, /loadPreferences/)
  assert.match(notifications, />\s*Retry\s*</)
})

test('appearance is an immediate browser preference and connector form is platform-admin gated', () => {
  const appearance = source('app/(protected)/profile/appearance/page.tsx')
  assert.match(appearance, /setTheme\(value\)/)
  assert.match(appearance, /role="radiogroup"/)
  assert.match(appearance, /saved immediately/)

  const profile = source('app/(protected)/profile/page.tsx')
  assert.match(profile, /field === 'theme'[\s\S]*setTheme\(value\)/)

  const connector = source('app/(protected)/settings/page.tsx')
  assert.match(connector, /platformRole === 'PLATFORM_ADMIN'/)
  assert.match(connector, /if \(!isPlatformAdmin\) return/)
  assert.match(connector, /Platform administration only/)
})
