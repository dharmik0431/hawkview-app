import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { authenticatedIdentityFromSupabasePayload } from './identity-token-verifier.service.js'

/**
 * THE ASSUMPTION OPERATOR EMAIL VERIFICATION WOULD REST ON, AND WHAT THIS CAN AND CANNOT CHECK.
 *
 * HawkView already knows an operator's address is confirmed — `protected-route.tsx` refuses to
 * render without `email_confirmed_at`. But the evidence is NOT a claim in the token.
 * `identity-token-verifier.service.ts` records why: Supabase has no authoritative
 * `email_confirmed` claim, Confirm Email prevents a session being ISSUED before confirmation,
 * and WITH THE SETTING DISABLED Supabase treats the address as implicitly confirmed.
 *
 * So the evidence is the EXISTENCE of a session, and it holds only while that project setting
 * does. Turn it off and every session silently becomes evidence of nothing: no code change,
 * nothing failing, nothing visible in a review.
 *
 * WHAT THIS FILE CANNOT DO, said plainly so nobody mistakes its green for coverage: it cannot
 * detect the setting changing. That is remote configuration, and reading it means a live call to
 * `/auth/v1/settings` at runtime — a dependency on auth configuration, which is an owner
 * decision and a different piece of work. NOT BUILT HERE, deliberately.
 *
 * WHAT IT DOES DO is cover the half that is local: it fires the moment code starts TREATING a
 * session as proof of a verified address, which is the moment the assumption acquires teeth.
 * A signpost at the point of use, not a prohibition — building this is wanted, building it
 * without confronting where the authority comes from is not.
 */

const AUTH = new URL('.', import.meta.url)
const backendSources = () => {
  const walk = (dir: URL): { name: string; text: string }[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
      if (entry.isDirectory()) return walk(child)
      if (!entry.name.endsWith('.ts')) return []
      return [{ name: entry.name, text: readFileSync(child, 'utf8') }]
    })
  return walk(new URL('../', AUTH)).filter((f) => !f.name.includes('.test.'))
}

const VALID = {
  sub: '11111111-1111-4111-8111-111111111111',
  email: 'ops@example.invalid',
  role: 'authenticated',
  is_anonymous: false,
  aal: 'aal1',
  session_id: '22222222-2222-4222-8222-222222222222',
}

test('POSITIVE CONTROL: the scan can see the backend sources at all', () => {
  // Without this the assertions below pass by finding nothing, which is what a negative check
  // does when its traversal has quietly stopped working.
  const files = backendSources()
  assert.ok(files.length > 100, 'the source scan found ' + files.length + ' files; it is broken')
  assert.ok(files.some((f) => f.name === 'identity-token-verifier.service.ts'),
    'the scan cannot see the file this assumption is written in')
})

test('the backend does NOT read a confirmation claim, and must not start', () => {
  // The frontend reads `email_confirmed_at` from the client session in several places -- that is
  // the render gate and it is fine. The BACKEND deliberately does not, because the claim is not
  // authoritative. If this fails, somebody has started trusting it server-side, and the question
  // they need to answer first is where the authority comes from.
  const offenders = backendSources()
    .filter((f) => f.text.includes('email_confirmed_at') || f.text.includes("'email_confirmed'"))
    .map((f) => f.name)

  assert.deepEqual(offenders, [],
    'Backend code is now reading a Supabase confirmation claim. That claim is NOT authoritative ' +
    '-- identity-token-verifier.service.ts explains why. Confirm Email prevents a session being ' +
    'ISSUED; with the setting DISABLED Supabase marks the address confirmed anyway. So this ' +
    'value is only as good as a project setting nothing in this repository can see. Before ' +
    'relying on it: read /auth/v1/settings and check mailer_autoconfirm is false, and decide ' +
    'whether that is asserted at runtime -- which is an owner decision, not a code one.')
})

test('the verified identity carries NO confirmation flag, so nothing can read one by accident', () => {
  // The shape of the returned identity is the guard here. A `verified: true` appearing on it
  // would be read as evidence by the next person, and it would not be.
  const identity = authenticatedIdentityFromSupabasePayload(VALID as never) as unknown as Record<string, unknown>
  for (const field of ['verified', 'emailVerified', 'email_confirmed_at', 'verifiedAt', 'confirmedAt']) {
    assert.equal(field in identity, false,
      'the authenticated identity now carries `' + field + '`. Whatever fills it, the token ' +
      'cannot: Supabase does not put an authoritative confirmation claim in it.')
  }
  assert.equal(identity.email, 'ops@example.invalid', 'the fixture stopped producing an identity')
})

test('NOT BUILT: the setting itself is unchecked, and that is the open half', () => {
  // Recorded as a test so it is not lost in a commit message. The failure mode this file is
  // named for -- Confirm Email being turned off -- is NOT detected by anything here or
  // anywhere else in the repository. Detecting it needs a live /auth/v1/settings read at
  // runtime, which is a dependency on auth configuration and an owner decision.
  //
  // This assertion is deliberately trivial. Its job is to carry the sentence, and to be
  // deleted by whoever closes the gap.
  const settingIsCheckedSomewhere = backendSources().some((f) =>
    f.text.includes('/auth/v1/settings') || f.text.includes('mailer_autoconfirm'))
  assert.equal(settingIsCheckedSomewhere, false,
    'Something now reads the Supabase auth settings. If that is a runtime check for ' +
    'mailer_autoconfirm, the gap this file documents is closed -- delete this test and update ' +
    'the header. If it is something else, the header is now misleading and needs correcting.')
})
