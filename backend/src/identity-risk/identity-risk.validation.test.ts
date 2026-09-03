import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import {
  decodeIdentityRiskCursor,
  encodeIdentityRiskCursor,
  boundedSafeString,
  parsePageLimit,
  parseTimestamp,
} from './identity-risk.validation.js'

const organizationId = '11111111-1111-4111-8111-111111111111'
const tenantId = '22222222-2222-4222-8222-222222222222'
const otherTenantId = '33333333-3333-4333-8333-333333333333'
const now = new Date('2026-09-02T12:00:00.000Z')

test('page limits default to 50 and reject requests above 100', () => {
  assert.equal(parsePageLimit(undefined), 50)
  assert.equal(parsePageLimit('100'), 100)
  assert.throws(() => parsePageLimit('101'), BadRequestException)
  assert.throws(() => parsePageLimit('1.5'), BadRequestException)
  assert.throws(() => parsePageLimit('-1'), BadRequestException)
})

test('cursor is opaque, signed, channel-, tenant-, and evaluation-run-bound', () => {
  const previous = process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET
  process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET = 'unit-test-only-cursor-secret-at-least-32-bytes'
  try {
    const cursor = encodeIdentityRiskCursor({
      channel: 'h',
      organizationId,
      customerTenantId: tenantId,
      datasetIdentity: 'evaluation-run-1',
      position: { observedAt: now, id: 'finding_01' },
    })
    assert.ok(cursor.length <= 256)
    assert.doesNotMatch(cursor, new RegExp(tenantId, 'i'))
    assert.deepEqual(
      decodeIdentityRiskCursor({
        cursor,
        channel: 'h',
        organizationId,
        customerTenantId: tenantId,
        datasetIdentity: 'evaluation-run-1',
        now,
      }),
      { observedAt: now, id: 'finding_01' },
    )
    assert.throws(
      () => decodeIdentityRiskCursor({
        cursor,
        channel: 'h',
        organizationId,
        customerTenantId: otherTenantId,
        datasetIdentity: 'evaluation-run-1',
        now,
      }),
      /Pagination cursor is invalid/,
    )
    assert.throws(
      () => decodeIdentityRiskCursor({
        cursor,
        channel: 'm',
        organizationId,
        customerTenantId: tenantId,
        datasetIdentity: 'evaluation-run-1',
        now,
      }),
      /Pagination cursor is invalid/,
    )
    assert.throws(
      () => decodeIdentityRiskCursor({
        cursor: `${cursor.slice(0, -1)}x`,
        channel: 'h',
        organizationId,
        customerTenantId: tenantId,
        datasetIdentity: 'evaluation-run-1',
        now,
      }),
      /Pagination cursor is invalid/,
    )
    assert.throws(
      () => decodeIdentityRiskCursor({
        cursor,
        channel: 'h',
        organizationId,
        customerTenantId: tenantId,
        datasetIdentity: 'evaluation-run-2',
        now,
      }),
      /Pagination cursor is invalid/,
    )
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET
    else process.env.HAWKVIEW_IDENTITY_RISK_CURSOR_SECRET = previous
  }
})

test('clock skew accepts exactly five minutes and rejects anything later', () => {
  assert.equal(
    parseTimestamp(new Date(now.getTime() + 5 * 60 * 1_000), now)?.toISOString(),
    '2026-09-02T12:05:00.000Z',
  )
  assert.equal(
    parseTimestamp(new Date(now.getTime() + 5 * 60 * 1_000 + 1), now),
    null,
  )
  assert.equal(parseTimestamp('not-a-date', now), null)
})

test('safe text rejects ASCII and Unicode formatting controls', () => {
  assert.equal(boundedSafeString('normal label', 20), 'normal label')
  assert.equal(boundedSafeString('line\nbreak', 20), null)
  assert.equal(boundedSafeString('spoof\u202eexe', 20), null)
})
