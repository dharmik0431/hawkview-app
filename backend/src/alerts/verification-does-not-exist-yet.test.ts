import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

/**
 * A TRIPWIRE FOR THE DAY OPERATOR EMAIL VERIFICATION IS BUILT.
 *
 * `currentStateFrom` takes `recipients` as an argument because the schema records no
 * verification: `VerifiedRecipient` needs `verifiedAt`, `notification_preferences` holds only a
 * preference, `users.email` has no verification column, and every construction of a
 * `VerifiedRecipient` in this repository is in a test.
 *
 * That has a consequence nobody should rely on. **Today this system cannot email anyone**, which
 * looks reassuring while the suppression repair is being graded — and it is a safety property
 * held up by a MISSING FEATURE. The moment somebody builds verification it evaporates, and they
 * will not be reading this repair when they do. A guard satisfied by the absence of its subject
 * is the same shape as an empty array that types as `never[]`, a regex that returns null, and a
 * criterion that cannot fail: it looks like protection and discriminates nothing.
 *
 * So this fails when that changes, and says what to do. It is a signpost, not a prohibition —
 * building verification is wanted. What must not happen is building it without anyone
 * re-examining what becomes reachable.
 */

const ALERTS = new URL('.', import.meta.url)
const sources = readdirSync(ALERTS)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({
    name,
    isTest: name.includes('.test.') || name.startsWith('qa-'),
    text: readFileSync(new URL(name, ALERTS), 'utf8'),
  }))

/** A CONSTRUCTION, not a mention -- and the difference is not expressible by string match.
 *
 * The union arm that DECLARES the type reads `kind: 'MSP_SECURITY_INBOX'` exactly as a
 * construction does, so the declaring file is excluded by name. That exclusion is itself
 * checked below rather than trusted: if routing-policy.ts stops being where the type is
 * declared, the exclusion is wrong and the guard says so instead of quietly widening. */
const DECLARES_THE_TYPE = 'routing-policy.ts'
const constructs = (text: string): boolean =>
  text.includes("kind: 'MSP_SECURITY_INBOX'") || text.includes("kind: 'DESIGNATED_OWNER'")

test('POSITIVE CONTROL: the scan can actually see a construction', () => {
  // Without this the assertion below passes by finding nothing, which is what a negative check
  // does when its pattern has quietly stopped matching. The tests DO build these, so a scan
  // that reports zero everywhere is broken rather than reassuring.
  const inTests = sources.filter((file) => file.isTest && constructs(file.text))
  assert.ok(inTests.length >= 2,
    'the scan found almost no constructions anywhere, including in tests that certainly ' +
    'contain them — the pattern has drifted and this whole file is now vacuous')
})

test('no production code constructs a VerifiedRecipient — and when that changes, read this', () => {
    const declaring = sources.find((file) => file.name === DECLARES_THE_TYPE)
  assert.ok(declaring && declaring.text.includes('export type VerifiedRecipient ='),
    DECLARES_THE_TYPE + ' no longer declares VerifiedRecipient, so excluding it is wrong')

  const inProduction = sources.filter(
    (file) => !file.isTest && file.name !== DECLARES_THE_TYPE && constructs(file.text))

  assert.deepEqual(
    inProduction.map((file) => file.name), [],
    'Operator email verification now exists in production code, which is good — and three ' +
    'things need re-examining before it ships:\n' +
    '  1. current-state.ts takes `recipients` as an argument precisely because there was no ' +
    'source of truth. It should now become a query, and the declared boundary in the R021 ' +
    'grading should be withdrawn.\n' +
    '  2. C2b and C4e were graded with a supplied recipient. They can now be graded for real, ' +
    'and should be, because a green obtained under a substitution is not the same result.\n' +
    '  3. Until now this system could not email anyone. That was never a safety property, but ' +
    'it has been doing the work of one — every send path is reachable from the moment this ' +
    'lands. The suppression repair must be re-run against it.\n' +
    'Delete this test once those three are done; it has served its purpose.')
})
