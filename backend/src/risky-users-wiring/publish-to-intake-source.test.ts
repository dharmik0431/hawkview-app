import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { composeTenantAssessment, type TenantAssessment } from '../evaluation-core/compose.js'
import type { Finding } from '../evaluation-core/contract.js'
import { nativePublicationRows } from './native-alert-publisher.js'

const input = {
  organizationId: 'org', customerTenantId: 'tenant', rowsFetched: 5, sources: [],
  windowStart: new Date('2026-08-11T00:00:00Z'), windowEnd: new Date('2026-09-10T00:00:00Z'),
  completedAt: new Date('2026-09-10T00:00:00Z'), expiresAt: new Date('2026-12-09T00:00:00Z'),
}
const finding: Finding = {
  detectorId: 'repeated-credential-failure',
  subject: { kind: 'DIRECTORY_USER', userRef: 'opaque-subject',
    correlation: { available: true, matchedBy: 'DIRECTORY_OBJECT_ID', ref: 'opaque-subject' } },
  signals: [
    { signal: 'PASSWORD_REJECTED', count: 5, capped: false,
      latest: { at: '2026-09-09T00:00:00Z', kind: 'EVENT_OCCURRED' } },
    { signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES', count: 0, capped: false, latest: null },
  ],
}
const assessment = (items: readonly Finding[] = [finding]): TenantAssessment => ({
  ...composeTenantAssessment([]), findings: { complete: true, items },
})

test('intake bridge source contains no literal NUL bytes', () => {
  const source = readFileSync(new URL('./publish-to-intake.ts', import.meta.url))
  assert.equal(source.includes(0), false)
  assert.ok(source.includes(Buffer.from([92, 117, 48, 48, 48, 48])))
})

test('intake hashes retain the original single-zero-byte separator', () => {
  const hash = (...parts: string[]) => createHash('sha256').update(Buffer.concat(
    parts.flatMap((part, index) => index === 0
      ? [Buffer.from(part)] : [Buffer.from([0]), Buffer.from(part)]),
  )).digest('hex')
  const [row] = nativePublicationRows(assessment(), input, 'run-one')
  assert.ok(row)
  const dedupe = hash('org', 'tenant', 'HV-ID-AUTH-011.v1', 'USER', 'opaque-subject')
  assert.equal(row.pair.finding.dedupeKey, dedupe)
  assert.equal(row.pair.matched.resultKey, hash(dedupe, 'run-one'))
})
