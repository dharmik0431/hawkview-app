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

  assert.match(csv, /Display Name/)
  assert.doesNotMatch(csv, new RegExp(event.rowKey))
  assert.doesNotMatch(csv, /do-not-export|old-password|new-password|debug-token/)
})

test('the six reproduced secret payloads never survive normalization or CSV serialization', () => {
  const payloads = [
    'password=top secret phrase',
    'client_secret: alpha beta gamma',
    'token=GENERICTOKENSECRET',
    'code=OAUTHCODESECRET',
    'sig=SIGNATURESECRET',
    '{"access_token":["ARRAYSECRET1","ARRAYSECRET2"]}',
  ]
  const secretFragments = [
    'top secret phrase',
    'secret phrase',
    'alpha beta gamma',
    'beta gamma',
    'GENERICTOKENSECRET',
    'OAUTHCODESECRET',
    'SIGNATURESECRET',
    'ARRAYSECRET1',
    'ARRAYSECRET2',
  ]

  payloads.forEach((payload, index) => {
    const signIn = normalizeSignInEvent(
      { failureReason: payload },
      { tenantId: 'tenant-1', index },
    )
    const audit = normalizeAuditEvent(
      {
        resultReason: payload,
        targetResources: [
          {
            displayName: 'Target',
            modifiedProperties: [
              { name: 'Display Name', oldValue: payload, newValue: payload },
            ],
          },
        ],
      },
      { tenantId: 'tenant-1', index },
    )
    const csv = `${buildSignInsCsvContent([signIn])}\n${buildAuditLogsCsvContent([audit])}\n${sanitizeCsvValue(payload)}`

    secretFragments.forEach((fragment) => {
      assert.equal(csv.includes(fragment), false)
    })
  })
})

test('percent-encoded credentials and structured secrets never reach CSV', () => {
  const payloads = [
    'password%3DENCODEDSECRET',
    'password%253DDOUBLESECRET',
    'client%5Fsecret%3DENCODEDCLIENTSECRET',
    'password%3GMALFORMEDSECRET',
    'client_secret%E0%A4%AMALFORMEDUTF8SECRET',
    '%7B%22access_token%22%3A%5B%22JSONARRAYSECRET1%22%5D%7D',
    '%257B%2522access_token%2522%253A%255B%2522JSONARRAYSECRET2%2522%255D%257D',
  ]
  const secretFragments = [
    'ENCODEDSECRET',
    'DOUBLESECRET',
    'ENCODEDCLIENTSECRET',
    'MALFORMEDSECRET',
    'MALFORMEDUTF8SECRET',
    'JSONARRAYSECRET1',
    'JSONARRAYSECRET2',
  ]

  payloads.forEach((payload, index) => {
    const signIn = normalizeSignInEvent(
      { failureReason: payload },
      { tenantId: 'tenant-1', index },
    )
    const audit = normalizeAuditEvent(
      { resultReason: payload },
      { tenantId: 'tenant-1', index },
    )
    const csv = `${buildSignInsCsvContent([signIn])}\n${buildAuditLogsCsvContent([audit])}\n${sanitizeCsvValue(payload)}`

    assert.equal(csv.includes(payload), false)
    secretFragments.forEach((fragment) => {
      assert.equal(csv.includes(fragment), false)
    })
  })
})
