import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CURRENT_KEY_VARIABLE,
  FIRST_KEY_VERSION,
  KEY_VERSION_VARIABLE,
  PREVIOUS_KEY_VARIABLE,
  encryptionKeyRing,
} from './secret-encryption-keys.js'

/** The key ring, which decides which key opens which row. */

const KEY_ONE = '11'.repeat(32)
const KEY_TWO = '22'.repeat(32)

const ring = (environment: Record<string, string | undefined>) =>
  encryptionKeyRing(environment as NodeJS.ProcessEnv)

test('an unconfigured key is refused with the message the service always used', () => {
  // Unchanged on purpose: an existing deployment's failure should read the same
  // as it did before this file existed.
  assert.throws(
    () => ring({}),
    /Secure credential encryption is not configured/)
  assert.throws(
    () => ring({ [CURRENT_KEY_VARIABLE]: 'too-short' }),
    /Secure credential encryption is not configured/)
})

test('both encodings the original accepted still work', () => {
  // A deployment's existing value must keep working, whichever way it was
  // written. 64 hex characters, or base64 of 32 bytes.
  assert.equal(ring({ [CURRENT_KEY_VARIABLE]: KEY_ONE }).current.length, 32)
  const base64 = Buffer.from(KEY_ONE, 'hex').toString('base64')
  assert.equal(ring({ [CURRENT_KEY_VARIABLE]: base64 }).current.length, 32)
  // And the two spellings are the same key, so re-encoding a value does not
  // silently strand every row sealed with it.
  assert.deepEqual(
    ring({ [CURRENT_KEY_VARIABLE]: base64 }).current,
    ring({ [CURRENT_KEY_VARIABLE]: KEY_ONE }).current)
})

test('an unstated version means the first one', () => {
  // Every row that existed before the column did is version 1, so an unset
  // variable has to mean 1 or those rows become unreadable on the first restart.
  assert.equal(ring({ [CURRENT_KEY_VARIABLE]: KEY_ONE }).currentVersion, FIRST_KEY_VERSION)
  assert.equal(
    ring({ [CURRENT_KEY_VARIABLE]: KEY_ONE, [KEY_VERSION_VARIABLE]: '  ' }).currentVersion,
    FIRST_KEY_VERSION)
})

test('an unparseable version is REFUSED rather than quietly treated as the first', () => {
  // THE DANGEROUS DEFAULT NOT TAKEN. Reading "2x" as 1 would seal new rows
  // labelled version 1 using the version 2 key: rows that look readable and are
  // not, discovered only when something tries to open them.
  for (const bad of ['two', '2x', '-1', '0', '1.5', '9'.repeat(30)]) {
    assert.throws(
      () => ring({ [CURRENT_KEY_VARIABLE]: KEY_ONE, [KEY_VERSION_VARIABLE]: bad }),
      new RegExp(KEY_VERSION_VARIABLE),
      `${bad} must be refused`)
  }

  // POSITIVE CONTROL: a well-formed version is accepted, so the refusals above
  // are about the value and not a function that rejects everything.
  assert.equal(
    ring({ [CURRENT_KEY_VARIABLE]: KEY_ONE, [KEY_VERSION_VARIABLE]: '7' }).currentVersion, 7)
})

test('the previous key opens exactly one version, the one before current', () => {
  const keys = ring({
    [CURRENT_KEY_VARIABLE]: KEY_TWO,
    [KEY_VERSION_VARIABLE]: '2',
    [PREVIOUS_KEY_VARIABLE]: KEY_ONE,
  })
  assert.deepEqual(keys.key(2), keys.current)
  assert.deepEqual(keys.key(1), Buffer.from(KEY_ONE, 'hex'))
  // Not a general-purpose archive. A row two versions behind has been stranded,
  // and inventing a slot for it would hide that rather than report it.
  assert.equal(keys.key(3), null)
  assert.equal(keys.key(0), null)
})

test('with no previous key configured, only the current version opens', () => {
  // The end state of a finished rotation: the old key is gone, and any row still
  // claiming the old version is reported rather than guessed at.
  const keys = ring({ [CURRENT_KEY_VARIABLE]: KEY_TWO, [KEY_VERSION_VARIABLE]: '2' })
  assert.deepEqual(keys.key(2), keys.current)
  assert.equal(keys.key(1), null)

  // POSITIVE CONTROL: adding the previous key makes version 1 open again, so the
  // null above is the missing configuration rather than a broken lookup.
  const withPrevious = ring({
    [CURRENT_KEY_VARIABLE]: KEY_TWO,
    [KEY_VERSION_VARIABLE]: '2',
    [PREVIOUS_KEY_VARIABLE]: KEY_ONE,
  })
  assert.notEqual(withPrevious.key(1), null)
})

test('a malformed previous key is ignored rather than treated as usable', () => {
  // It cannot open anything, so offering it would turn "I do not hold that key"
  // into "that row is corrupt" — the confusion this whole change removes.
  const keys = ring({
    [CURRENT_KEY_VARIABLE]: KEY_TWO,
    [KEY_VERSION_VARIABLE]: '2',
    [PREVIOUS_KEY_VARIABLE]: 'not-a-key',
  })
  assert.equal(keys.key(1), null)
})
