import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const rootPage = readFileSync('app/page.tsx', 'utf8')
const loginPage = readFileSync('app/(public)/login/page.tsx', 'utf8')
const loginContent = readFileSync(
  'components/auth/login-page-content.tsx',
  'utf8'
)
const authForm = readFileSync('components/auth/auth-form.tsx', 'utf8')

test('root renders the shared login surface without a transport redirect', () => {
  assert.match(rootPage, /<LoginPageContent\s*\/>/)
  assert.doesNotMatch(rootPage, /next\/navigation/)
  assert.doesNotMatch(rootPage, /redirect\s*\(/)
})

test('root and login share the same sign-in surface and authenticated destination', () => {
  assert.match(loginPage, /<LoginPageContent\s*\/>/)
  assert.match(loginContent, /<AuthForm initialMode="sign-in"\s*\/>/)
  assert.match(authForm, /router\.replace\('\/dashboard'\)/)
})
