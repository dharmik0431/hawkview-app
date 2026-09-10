import assert from 'node:assert/strict'
import test from 'node:test'
import { evidenceFromSync } from './evidence-availability.js'
import type { CollectorSyncStatus } from '../tenants/service-sync-freshness.js'

const EVERY_STATUS: readonly CollectorSyncStatus[] = [
  'SUCCESS', 'EMPTY', 'RUNNING', 'PENDING', 'FAILED', 'STALE',
  'UNSUPPORTED', 'NOT_LICENSED', 'PERMISSION_REQUIRED', 'NOT_CONFIGURED', 'UNKNOWN',
]

test('a collector that ran and found nothing is evidence, so a quiet tenant can be told so', () => {
  // The control case, and it is a requirement rather than a nicety. A dev
  // tenant with two users and no failures must report a confident zero — if we
  // have overcorrected into withholding everywhere, that is where it shows, and
  // "cannot determine" there means we built something that tells nobody
  // anything.
  assert.deepEqual(evidenceFromSync('SUCCESS'), { read: true })
  assert.deepEqual(evidenceFromSync('EMPTY'), { read: true })
})

test('a stale collection is not a quiet tenant, and the two are indistinguishable in the events', () => {
  // Eleven days stale while every other tenant is current: either dormant with
  // genuinely no activity, or collection stopped and nothing said so. The
  // events look identical, because in both cases there are none. Only the
  // collector's own state separates them.
  const stale = evidenceFromSync('STALE')
  assert.equal(stale.read, false)
  assert.equal(stale.read === false && stale.availability, 'UNREADABLE_NOW')
})

test('an unknown collection state does not claim we know it was never collected', () => {
  // NEVER_COLLECTED asserts we know it was not collected. We do not know that —
  // we know we cannot establish it — so the honest answer is the weaker one.
  const unknown = evidenceFromSync('UNKNOWN')
  assert.equal(unknown.read === false && unknown.availability, 'UNREADABLE_NOW')
})

test('every status is classified, and only collection success reads as evidence', () => {
  // Exhaustive rather than sampled: the unsafe direction is silent, because an
  // unclassified status defaulting to readable produces a confident zero over a
  // window nobody collected.
  const readable = EVERY_STATUS.filter(status => evidenceFromSync(status).read)
  assert.deepEqual(readable, ['SUCCESS', 'EMPTY'])

  for (const status of EVERY_STATUS) {
    const disposition = evidenceFromSync(status)
    if (disposition.read) continue
    // Every unreadable case says why in its own words. A blank reason would be
    // the silent opt-out this project keeps removing.
    assert.ok(disposition.because.trim().length > 0, `${status} must say why`)
  }
})

test('capability and failure are not the same sentence', () => {
  // "Your licence does not include this" and "the last attempt failed" send a
  // technician to different places, and rendering either as an unexplained
  // blank is how a capability limit reads as a fault.
  const notLicensed = evidenceFromSync('NOT_LICENSED')
  const failed = evidenceFromSync('FAILED')
  assert.equal(notLicensed.read === false && notLicensed.availability, 'NEVER_COLLECTED')
  assert.equal(failed.read === false && failed.availability, 'UNREADABLE_NOW')
  assert.notEqual(
    notLicensed.read === false ? notLicensed.because : '',
    failed.read === false ? failed.because : '')
})
