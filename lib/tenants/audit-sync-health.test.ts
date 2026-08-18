import assert from 'node:assert/strict'
import test from 'node:test'
import { auditSyncFocusTarget, isM365AuditSyncDeepLink, m365AuditSyncHealth, sanitizeSyncFailure } from './audit-sync-health.ts'

test('recognizes only the M365 audit synchronization deep link', () => {
  assert.equal(isM365AuditSyncDeepLink('sync', 'M365_AUDIT'), true)
  assert.equal(isM365AuditSyncDeepLink('sync', 'USERS'), false)
  assert.equal(isM365AuditSyncDeepLink(null, 'M365_AUDIT'), false)
})

test('provides a focus target only for the valid M365 audit synchronization deep link', () => {
  assert.equal(auditSyncFocusTarget('sync', 'M365_AUDIT'), 'sync-health')
  assert.equal(auditSyncFocusTarget('sync', 'USERS'), null)
})

test('redacts credential-shaped values and URL queries while retaining useful error context', () => {
  const result = sanitizeSyncFailure({
    status: 403,
    message: 'Forbidden Bearer eyJheader.payload.signature refresh_token=hidden API_KEY: top-secret https://graph.microsoft.com/v1.0/auditLogs?sig=signed&code=oauth-code',
    arbitrarySecret: 'must never be rendered',
  })
  assert.match(result, /HTTP 403: Forbidden/)
  // A bearer value consumes the remaining unstructured text rather than risk exposing a suffix.
  assert.doesNotMatch(result, /hidden|top-secret|eyJheader|signed|oauth-code|must never be rendered/i)
})

test('redacts quoted, JSON-shaped, encoded, nested, and mixed-case credential values', () => {
  const result = sanitizeSyncFailure('HTTP 429 Correlation ID abc-123 {"client_secret":"JSONSECRET","nested":[{"refresh_token":"REFRESH VALUE"}],"API_KEY":"two word secret\\\" escaped"} Refresh_Token%253DENCODEDSECRET Bearer%2520ENCODEDTOKEN')
  assert.match(result, /HTTP 429 Correlation ID abc-123/)
  assert.doesNotMatch(result, /JSONSECRET|REFRESH VALUE|two word secret|ENCODEDSECRET|ENCODEDTOKEN|escaped/i)
  assert.match(result, /\[REDACTED\]/)
})

test('fails closed on malformed encoding without losing a safe status', () => {
  const result = sanitizeSyncFailure('HTTP 400 malformed percent %ZZ refresh_token=must-not-render')
  assert.equal(result, 'HTTP 400: [REDACTED ENCODED ERROR]')
  assert.doesNotMatch(result, /must-not-render/)
})

test('redacts every value under structured credential keys without losing safe Microsoft diagnostics', () => {
  const result = sanitizeSyncFailure(JSON.stringify({
    error: { code: 'RequestDenied', message: 'Microsoft rejected the request.' },
    client_secret: 'alpha beta gamma',
    access_token: ['ARRAYSECRET1', 'ARRAYSECRET2'],
    password: { primary: 'NESTEDSECRET', values: ['ANOTHERSECRET'] },
    nested: [{ Refresh_Token: 'REFRESH VALUE' }],
  }))
  assert.match(result, /RequestDenied/)
  assert.match(result, /Microsoft rejected the request/)
  assert.doesNotMatch(result, /alpha beta gamma|ARRAYSECRET1|ARRAYSECRET2|NESTEDSECRET|ANOTHERSECRET|REFRESH VALUE/i)
  assert.doesNotMatch(result, /access_token|password|nested/i)
})

test('projects only safe diagnostic fields from whole or embedded JSON', () => {
  const probe = {
    error: { code: 'RequestDenied', message: 'Microsoft rejected the request.' }, correlationId: 'corr-1', tenantId: 'tenant-1',
    arbitrary: 'ARBITRARYSECRET', nested: { debug: 'DEBUGSECRET' }, access_token: ['ARRAYSECRET1', 'ARRAYSECRET2'],
    password: { primary: 'NESTEDSECRET' }, __proto__: { debug: 'PROTOTYPESECRET' }, constructor: 'CONSTRUCTORSECRET',
  }
  for (const value of [JSON.stringify(probe), `prefix ${JSON.stringify(probe)}`]) {
    const result = sanitizeSyncFailure(value)
    assert.match(result, /RequestDenied|REDACTED STRUCTURED ERROR/)
    assert.match(result, /corr-1|REDACTED STRUCTURED ERROR/)
    assert.doesNotMatch(result, /ARBITRARYSECRET|DEBUGSECRET|ARRAYSECRET1|ARRAYSECRET2|NESTEDSECRET|PROTOTYPESECRET|CONSTRUCTORSECRET/i)
    assert.doesNotMatch(result, /"arbitrary"|"nested"|"access_token"|"password"/i)
  }
  assert.equal(sanitizeSyncFailure('{"untrusted":["NOPE"],"other":{"debug":"NOPE2"}}'), '{"diagnostic":"[REDACTED STRUCTURED ERROR]"}')
})

test('uses the same case-insensitive projection for direct object diagnostics', () => {
  const result = sanitizeSyncFailure({
    STATUS: 403, Error: { CODE: 'RequestDenied', MESSAGE: 'Safe Microsoft message' }, CLIENTREQUESTID: 'req-1', Organization_ID: 'org-1',
    URL: 'https://user:pass@graph.microsoft.com/v1.0/auditLogs?sig=SECRET#fragment', PASSWORD: 'NESTEDSECRET',
    arbitrary: ['ARBITRARYSECRET'], nested: { debug: 'DEBUGSECRET' }, constructor: 'CONSTRUCTORSECRET',
  })
  assert.match(result, /HTTP 403.*RequestDenied.*Safe Microsoft message.*req-1.*org-1.*https:\/\/graph\.microsoft\.com\/v1\.0\/auditLogs/i)
  assert.doesNotMatch(result, /user:pass|sig=|fragment|NESTEDSECRET|ARBITRARYSECRET|DEBUGSECRET|CONSTRUCTORSECRET/i)
  assert.equal(sanitizeSyncFailure({ status: ['not primitive'], message: { no: 'object' }, __proto__: { secret: 'NOPE' } }), 'No current failure reason was provided.')
})

test('normalizes approved direct-object aliases without preserving collisions or unknown values', () => {
  const result = sanitizeSyncFailure({
    STATUS_CODE: 401,
    'REQUEST-ID': 'request-first',
    request_id: 'request-second',
    'ORGANIZATION-ID': 'org-hyphen',
    URI: 'https://graph.microsoft.com/v1.0/users?api_key=SECRET',
    MESSAGE: { unsafe: 'OBJECTSECRET' },
    unknown: { nested: 'UNKNOWNSECRET' },
    __proto__: { poison: 'PROTOTYPESECRET' },
  })
  assert.match(result, /HTTP 401.*request-first.*org-hyphen.*https:\/\/graph\.microsoft\.com\/v1\.0\/users/i)
  assert.doesNotMatch(result, /request-second|SECRET|OBJECTSECRET|UNKNOWNSECRET|PROTOTYPESECRET/i)
})

test('fails closed for compound free-text credentials and encoded credential forms', () => {
  for (const value of [
    'password=top secret phrase',
    'client_secret: alpha beta gamma',
    'password={"primary":"NESTEDSECRET"}',
    'Refresh_Token%3DENCODEDSECRET',
    'Bearer%20ENCODEDTOKEN',
    'Bearer%2520DOUBLEENCODEDTOKEN',
    'CLIENT_SECRET: "escaped \\"secret\\" value"',
  ]) {
    const result = sanitizeSyncFailure(value)
    assert.match(result, /\[REDACTED\]/)
    assert.doesNotMatch(result, /top secret phrase|alpha beta gamma|NESTEDSECRET|ENCODEDSECRET|ENCODEDTOKEN|DOUBLEENCODEDTOKEN|escaped|secret value/i)
  }
})

test('selects and sanitizes M365 audit resource health for settings display', () => {
  const result = m365AuditSyncHealth([{ resourceType: 'USERS' }, {
    resourceType: 'M365_AUDIT', classification: 'FAILED', reasonCode: '403',
    message: 'Microsoft rejected client_secret=hidden',
    lastAttemptAt: '2026-08-18T10:00:00.000Z', lastSuccessfulAt: '2026-08-18T09:00:00.000Z',
  }])
  assert.deepEqual(result, {
    classification: 'FAILED', reasonCode: '403',
    message: 'Microsoft rejected client_secret=[REDACTED]',
    lastAttemptAt: '2026-08-18T10:00:00.000Z', lastSuccessfulAt: '2026-08-18T09:00:00.000Z',
  })
})
