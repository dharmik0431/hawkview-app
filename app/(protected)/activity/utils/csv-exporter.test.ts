import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeAuditEvent, normalizeSignInEvent } from '../data/normalize.ts'
import {
  buildAuditLogsCsvContent,
  buildSignInsCsvContent,
  sanitizeCsvValue,
} from './csv-exporter.ts'

test('CSV cells resist formula injection after whitespace and control characters', () => {
  assert.equal(sanitizeCsvValue('=1+1'), "'=1+1")
  assert.equal(sanitizeCsvValue('  +SUM(A1:A2)'), "'+SUM(A1:A2)")
  assert.equal(sanitizeCsvValue('\t@cmd'), "'@cmd")
  assert.equal(sanitizeCsvValue('-2+3'), "'-2+3")
})

test('sign-in CSV never exports internal row keys or unredacted diagnostics', () => {
  const event = normalizeSignInEvent(
    {
      appDisplayName: '=DANGEROUS()',
      failureReason:
        'password=visible-secret https://user:pass@example.com/path?access_token=query-secret',
    },
    { tenantId: 'tenant-1', index: 9 },
  )
  const csv = buildSignInsCsvContent([event], '=tenant')

  assert.match(csv, /Microsoft Event ID/)
  assert.match(csv, /Not reported/)
  assert.match(csv, /'=DANGEROUS\(\)/)
  assert.match(csv, /'=tenant/)
  assert.match(csv, /password=\[Redacted\]/)
  assert.doesNotMatch(csv, new RegExp(event.rowKey))
  assert.doesNotMatch(csv, /visible-secret|user:pass|query-secret/)
})

test('audit CSV exports only sanitized allowlisted property values', () => {
  const event = normalizeAuditEvent(
    {
      resultReason: 'client_secret=do-not-export',
      targetResources: [
        {
          displayName: 'Target',
          modifiedProperties: [
            { name: 'password', oldValue: 'old-password', newValue: 'new-password' },
            { name: 'Display Name', oldValue: '@old', newValue: '=new' },
          ],
        },
      ],
      debug: { access_token: 'debug-token' },
    },
    { tenantId: 'tenant-1', index: 7 },
  )
  const csv = buildAuditLogsCsvContent([event])

  assert.match(csv, /client_secret=\[Redacted\]/)
  assert.match(csv, /password=\[Redacted\] -> \[Redacted\]/)
  assert.doesNotMatch(csv, new RegExp(event.rowKey))
  assert.doesNotMatch(csv, /do-not-export|old-password|new-password|debug-token/)
})
