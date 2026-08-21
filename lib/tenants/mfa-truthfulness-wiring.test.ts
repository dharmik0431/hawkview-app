import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(path: string) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

test('tenant users render registration and legacy per-user MFA as separate Microsoft facts', () => {
  const page = source('app/(protected)/tenants/[id]/page.tsx')
  assert.match(page, /MFA registration/)
  assert.match(page, /Per-user MFA/)
  assert.match(page, /Microsoft Graph beta when available/)
  assert.match(page, /Conditional Access and security defaults are evaluated separately/)
  assert.match(page, /mfaRegistrationPresentation\(u\)/)
  assert.match(page, /perUserMfaPresentation\(u\)/)
  assert.match(page, /<MfaFactBadge \{\.\.\.mfaRegistrationBadge\} \/>/)
  assert.match(page, /<MfaFactBadge \{\.\.\.perUserMfaBadge\} \/>/)
})

test('user security facts precede role and type in the table', () => {
  const page = source('app/(protected)/tenants/[id]/page.tsx')
  const banner = page.indexOf('MFA registration shows whether')
  const start = page.indexOf('<thead', banner)
  const end = page.indexOf('{USERS.length === 0', start)
  const table = page.slice(start, end)
  const order = [
    'label="Status"',
    'label="MFA registration"',
    'Per-user MFA',
    'label="Role"',
    'label="Type"',
  ].map((label) => table.indexOf(label))
  assert.equal(order.every((position) => position >= 0), true)
  assert.deepEqual(order, [...order].sort((left, right) => left - right))
  assert.match(page, /positive:[\s\S]*emerald/)
  assert.match(page, /caution:[\s\S]*amber/)
  assert.match(page, /info:[\s\S]*blue/)
  assert.match(page, /neutral:[\s\S]*slate/)
})

test('dashboard and health language never claim registration proves enforcement', () => {
  const combined = [
    source('app/(protected)/dashboard/page.tsx'),
    source('components/dashboard/alert-details-modal.tsx'),
    source('components/dashboard/tenant-risk-matrix-drawer.tsx'),
    source('components/dashboard/tenant-risk-matrix-helpers.ts'),
    source('backend/src/tenants/tenant-health.ts'),
  ].join('\n')
  assert.match(combined, /MFA registration/)
  assert.doesNotMatch(combined, /users without enforced MFA|MFA Disabled|MFA Gaps/)
  assert.doesNotMatch(
    source('app/(protected)/dashboard/page.tsx'),
    /mfaCoverage == null \? 100/,
  )
})

test('backend uses the bounded beta requirements lookup and closed projection', () => {
  const backend = source('backend/src/tenants/tenant-sync.service.ts')
  assert.match(backend, /graph\.microsoft\.com\/beta\/\$batch/)
  assert.match(backend, /\/authentication\/requirements/)
  assert.match(backend, /projectMfaTruth\(registration\)/)
  assert.match(backend, /microsoft-graph-beta-authentication-requirements/)
})
