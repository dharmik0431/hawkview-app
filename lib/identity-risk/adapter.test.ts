import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptIdentityRiskResponses } from './adapter.ts'

const now = '2026-09-02T12:00:00.000Z'

function boundedCount(value: number, exact = true, capped = false) {
  return { value, exact, capped }
}

function summaryCounts(overrides: Record<string, unknown> = {}) {
  return {
    identitiesNeedingReview: boundedCount(1),
    openFindings: boundedCount(1),
    evaluatedRules: boundedCount(22),
    matchedResults: boundedCount(1),
    suppressedResults: boundedCount(0),
    notMatchedResults: boundedCount(20),
    notEvaluatedResults: boundedCount(1),
    ...overrides,
  }
}

function unavailableSummaryCounts() {
  const unavailable = boundedCount(0, false, false)
  return summaryCounts({
    identitiesNeedingReview: unavailable,
    openFindings: unavailable,
    evaluatedRules: unavailable,
    matchedResults: unavailable,
    suppressedResults: unavailable,
    notMatchedResults: unavailable,
    notEvaluatedResults: unavailable,
  })
}

function channelMeta(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    capability: 'FULL',
    status: 'AVAILABLE',
    sourceLabel: 'HawkView Identity Signals',
    engineVersion: 'hawkview-identity-engine/1',
    catalogVersion: 'hawkview-identity-signals/v1',
    evaluatedAt: now,
    observedAt: now,
    freshness: 'CURRENT',
    limitation: null,
    ...overrides,
  }
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'opaque-finding-1',
    state: 'OPEN',
    severity: 'HIGH',
    confidence: 'HIGH',
    coverage: 'FULL',
    title: 'New identity received a privileged role',
    explanation: 'A new identity received privilege within the evaluated window.',
    affectedIdentity: {
      id: 'opaque-identity-1',
      label: 'Reported administrator',
      type: 'USER',
    },
    observedAt: now,
    ruleIds: ['HV-ID-CHG-001.v1'],
    sourceLabels: ['Microsoft Entra directory audit'],
    missingEvidenceLabels: [],
    benignAlternativeCodes: ['APPROVED_ACCOUNT_PROVISIONING'],
    investigationGuidanceCode: 'REVIEW_ACCESS',
    investigationGuidance:
      'Review the identity, role assignment, and related authorized change evidence.',
    ...overrides,
  }
}

function microsoftUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'microsoft-risk-1',
    identityLabel: 'Microsoft-reported user',
    riskLevel: 'high',
    riskState: 'atRisk',
    riskDetail: 'adminConfirmedUserCompromised',
    observedAt: now,
    ...overrides,
  }
}

function validResponses(): {
  hawkViewSummary: Record<string, unknown>
  hawkViewFindings: Record<string, unknown>
  microsoftRiskyUsers: Record<string, unknown>
} {
  return {
    hawkViewSummary: {
      ...channelMeta(),
      channel: 'HAWKVIEW_IDENTITY_SIGNALS',
      counts: summaryCounts(),
    },
    hawkViewFindings: {
      ...channelMeta(),
      channel: 'HAWKVIEW_IDENTITY_SIGNALS',
      findings: [finding()],
      pageInfo: { hasMore: false, nextCursor: null },
    },
    microsoftRiskyUsers: {
      ...channelMeta({
        sourceLabel: 'Microsoft Entra Risky Users',
        engineVersion: null,
        catalogVersion: 'microsoft-entra-risky-users/v1',
      }),
      channel: 'MICROSOFT_ENTRA_RISKY_USERS',
      users: [microsoftUser()],
      pageInfo: { hasMore: false, nextCursor: null },
    },
  }
}

test('adapts the two channels without merging their records', () => {
  const view = adaptIdentityRiskResponses(validResponses())

  assert.equal(view.hawkView.channel, 'HAWKVIEW_IDENTITY_SIGNALS')
  assert.equal(view.hawkView.findings?.[0]?.ruleIds[0], 'HV-ID-CHG-001.v1')
  assert.equal(
    view.hawkView.findings?.[0]?.investigationGuidanceCode,
    'REVIEW_ACCESS'
  )
  assert.equal(view.microsoft.channel, 'MICROSOFT_ENTRA_RISKY_USERS')
  assert.equal(view.microsoft.users?.[0]?.riskState, 'atRisk')
})

test('preserves stale, learning, and not-evaluated capability states', () => {
  for (const status of ['STALE', 'LEARNING', 'NOT_EVALUATED'] as const) {
    const responses = validResponses()
    const capability = status === 'NOT_EVALUATED' ? 'UNAVAILABLE' : 'PARTIAL'
    const observedAt = status === 'NOT_EVALUATED' ? null : now
    const evaluatedAt = status === 'NOT_EVALUATED' ? null : now
    responses.hawkViewSummary = {
      ...responses.hawkViewSummary,
      status,
      capability,
      freshness: status === 'STALE' ? 'STALE' : 'UNKNOWN',
      observedAt,
      evaluatedAt,
      limitation: `${status} evidence state`,
      ...(status === 'NOT_EVALUATED'
        ? { counts: unavailableSummaryCounts() }
        : {}),
    }
    responses.hawkViewFindings = {
      ...responses.hawkViewFindings,
      status,
      capability,
      freshness: status === 'STALE' ? 'STALE' : 'UNKNOWN',
      observedAt,
      evaluatedAt,
      limitation: `${status} evidence state`,
      ...(status === 'NOT_EVALUATED' ? { findings: [] } : {}),
    }

    const view = adaptIdentityRiskResponses(responses)
    assert.equal(view.hawkView.meta.status, status)
    assert.equal(view.hawkView.meta.capability, capability)
  }
})

test('keeps license and permission limitations server-authored', () => {
  for (const limitation of [
    'Microsoft Entra ID P2 is required for this evidence.',
    'IdentityRiskyUser.Read.All permission is required for this evidence.',
  ]) {
    const responses = validResponses()
    responses.microsoftRiskyUsers = {
      ...responses.microsoftRiskyUsers,
      capability: 'UNAVAILABLE',
      status: 'UNAVAILABLE',
      freshness: 'UNKNOWN',
      evaluatedAt: null,
      observedAt: null,
      limitation,
      users: [],
    }
    const view = adaptIdentityRiskResponses(responses)
    assert.equal(view.microsoft.meta.status, 'UNAVAILABLE')
    assert.equal(view.microsoft.meta.limitation, limitation)
    assert.deepEqual(view.microsoft.users, [])
  }
})

test('rejects mixed channels and unknown contract versions', () => {
  const mixed = validResponses()
  mixed.hawkViewFindings = {
    ...mixed.hawkViewFindings,
    channel: 'MICROSOFT_ENTRA_RISKY_USERS',
  }
  assert.equal(
    adaptIdentityRiskResponses(mixed).hawkView.meta.status,
    'NOT_EVALUATED'
  )

  const unknown = validResponses()
  unknown.microsoftRiskyUsers = {
    ...unknown.microsoftRiskyUsers,
    version: 2,
  }
  assert.equal(
    adaptIdentityRiskResponses(unknown).microsoft.meta.status,
    'NOT_EVALUATED'
  )
})

test('fails closed when required finding fields or enums are malformed', () => {
  for (const malformedFinding of [
    finding({ title: undefined }),
    finding({ affectedIdentity: { id: 'opaque', label: 'User', type: 'DEVICE' } }),
    finding({ severity: 'PROBABLE' }),
    finding({ ruleIds: [] }),
    finding({ investigationGuidance: '' }),
  ]) {
    const responses = validResponses()
    responses.hawkViewFindings = {
      ...responses.hawkViewFindings,
      findings: [malformedFinding],
    }
    const view = adaptIdentityRiskResponses(responses)
    assert.equal(view.hawkView.meta.status, 'ERROR')
    assert.equal(view.hawkView.findings, null)
  }
})

test('does not convert missing channel payloads into empty success', () => {
  const view = adaptIdentityRiskResponses({
    hawkViewSummary: null,
    hawkViewFindings: null,
    microsoftRiskyUsers: null,
  })

  assert.equal(view.hawkView.meta.status, 'NOT_EVALUATED')
  assert.equal(view.hawkView.findings, null)
  assert.equal(view.microsoft.meta.status, 'NOT_EVALUATED')
  assert.equal(view.microsoft.users, null)
})

test('rejects inherited properties and unknown fields instead of projecting them', () => {
  const inherited = validResponses()
  const ownSummary = { ...inherited.hawkViewSummary }
  delete ownSummary.version
  inherited.hawkViewSummary = Object.assign(
    Object.create({ version: 1 }),
    ownSummary
  )
  assert.equal(
    adaptIdentityRiskResponses(inherited).hawkView.meta.status,
    'NOT_EVALUATED'
  )

  const unknownEnvelope = validResponses()
  unknownEnvelope.microsoftRiskyUsers = {
    ...unknownEnvelope.microsoftRiskyUsers,
    debugPayload: 'not contracted',
  }
  assert.equal(
    adaptIdentityRiskResponses(unknownEnvelope).microsoft.meta.status,
    'NOT_EVALUATED'
  )

  const crossChannelField = validResponses()
  crossChannelField.microsoftRiskyUsers = {
    ...crossChannelField.microsoftRiskyUsers,
    users: [microsoftUser({ investigationGuidance: 'Review activity.' })],
  }
  assert.equal(
    adaptIdentityRiskResponses(crossChannelField).microsoft.meta.status,
    'ERROR'
  )
})

test('rejects secret-shaped strings and autonomous instructions', () => {
  for (const unsafeFinding of [
    finding({ title: 'password=TOPSECRET' }),
    finding({
      investigationGuidance:
        'Review eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    }),
    finding({
      investigationGuidance:
        'Review https://admin:credential@example.invalid/evidence',
    }),
    finding({ investigationGuidance: 'Disable the account immediately.' }),
    finding({ title: 'Bearer TOPSECRET-CREDENTIAL' }),
    finding({ explanation: '{"access_token":["ARRAYSECRET1"]}' }),
    finding({ title: 'code=OAUTHCODESECRET' }),
    finding({ title: 'authorization_code=OAUTHCODESECRET' }),
    finding({ title: 'sig=SIGNATURESECRET' }),
    finding({ title: 'password%3DENCODEDSECRET' }),
    finding({ investigationGuidance: 'Review and wipe this mailbox immediately.' }),
  ]) {
    const responses = validResponses()
    responses.hawkViewFindings = {
      ...responses.hawkViewFindings,
      findings: [unsafeFinding],
    }
    assert.equal(adaptIdentityRiskResponses(responses).hawkView.meta.status, 'ERROR')
  }

  const unsafeLimitation = validResponses()
  unsafeLimitation.microsoftRiskyUsers = {
    ...unsafeLimitation.microsoftRiskyUsers,
    limitation: 'access_token=TOPSECRET',
  }
  assert.equal(
    adaptIdentityRiskResponses(unsafeLimitation).microsoft.meta.status,
    'ERROR'
  )

  const unsafeRiskDetail = validResponses()
  unsafeRiskDetail.microsoftRiskyUsers = {
    ...unsafeRiskDetail.microsoftRiskyUsers,
    users: [microsoftUser({ riskDetail: 'attackerControlledDetail' })],
  }
  assert.equal(
    adaptIdentityRiskResponses(unsafeRiskDetail).microsoft.meta.status,
    'ERROR'
  )
})

test('rejects oversized pages and invalid cursor state', () => {
  const oversized = validResponses()
  oversized.hawkViewFindings = {
    ...oversized.hawkViewFindings,
    findings: new Array(50_000).fill(finding()),
    pageInfo: { hasMore: false, nextCursor: null },
  }
  assert.equal(adaptIdentityRiskResponses(oversized).hawkView.meta.status, 'ERROR')

  const unsafeCursor = validResponses()
  unsafeCursor.microsoftRiskyUsers = {
    ...unsafeCursor.microsoftRiskyUsers,
    pageInfo: { hasMore: true, nextCursor: 'token=TOPSECRET' },
  }
  assert.equal(
    adaptIdentityRiskResponses(unsafeCursor).microsoft.meta.status,
    'ERROR'
  )
})

test('accepts an exact bounded page and preserves explicit continuation state', () => {
  const responses = validResponses()
  const findings = Array.from({ length: 100 }, (_, index) =>
    finding({
      id: `opaque-finding-${index}`,
      affectedIdentity: {
        id: `opaque-identity-${index}`,
        label: `Reported identity ${index}`,
        type: 'USER',
      },
    })
  )
  responses.hawkViewSummary = {
    ...responses.hawkViewSummary,
    counts: summaryCounts({
      identitiesNeedingReview: boundedCount(101),
      openFindings: boundedCount(101),
    }),
  }
  responses.hawkViewFindings = {
    ...responses.hawkViewFindings,
    findings,
    pageInfo: { hasMore: true, nextCursor: 'safe_cursor.signature' },
  }

  const view = adaptIdentityRiskResponses(responses).hawkView
  assert.equal(view.meta.status, 'AVAILABLE')
  assert.equal(view.findings?.length, 100)
  assert.deepEqual(view.pageInfo, {
    hasMore: true,
    nextCursor: 'safe_cursor.signature',
  })
})

test('rejects duplicate row identifiers', () => {
  const responses = validResponses()
  responses.hawkViewFindings = {
    ...responses.hawkViewFindings,
    findings: [finding(), finding()],
  }
  assert.equal(adaptIdentityRiskResponses(responses).hawkView.meta.status, 'ERROR')
})

test('rejects contradictory metadata and future evidence timestamps', () => {
  for (const findingsMeta of [
    { capability: 'UNAVAILABLE' },
    { freshness: 'STALE' },
    { observedAt: '2026-09-01T12:00:00.000Z' },
    { limitation: 'Different limitation' },
  ]) {
    const responses = validResponses()
    responses.hawkViewFindings = {
      ...responses.hawkViewFindings,
      ...findingsMeta,
    }
    assert.equal(adaptIdentityRiskResponses(responses).hawkView.meta.status, 'ERROR')
  }

  const futureEvidence = validResponses()
  for (const key of ['hawkViewSummary', 'hawkViewFindings'] as const) {
    futureEvidence[key] = {
      ...futureEvidence[key],
      observedAt: '2026-09-02T12:06:00.000Z',
    }
  }
  assert.equal(
    adaptIdentityRiskResponses(futureEvidence).hawkView.meta.status,
    'ERROR'
  )

  const toleratedSkew = validResponses()
  for (const key of ['hawkViewSummary', 'hawkViewFindings'] as const) {
    toleratedSkew[key] = {
      ...toleratedSkew[key],
      observedAt: '2026-09-02T12:05:00.000Z',
    }
  }
  assert.equal(
    adaptIdentityRiskResponses(toleratedSkew).hawkView.meta.status,
    'AVAILABLE'
  )

  const unsafeErrorState = validResponses()
  unsafeErrorState.microsoftRiskyUsers = {
    ...unsafeErrorState.microsoftRiskyUsers,
    capability: 'UNAVAILABLE',
    status: 'ERROR',
    freshness: 'UNKNOWN',
    limitation: null,
  }
  const errorView = adaptIdentityRiskResponses(unsafeErrorState).microsoft
  assert.equal(errorView.meta.status, 'ERROR')
  assert.equal(errorView.users, null)
})

test('requires the final actionable contract rather than weakening for the backend foundation', () => {
  const foundation = validResponses()
  const foundationFinding: Record<string, unknown> = finding()
  delete foundationFinding.explanation
  foundation.hawkViewFindings = {
    ...foundation.hawkViewFindings,
    mode: 'SHADOW',
    findings: [foundationFinding],
  }
  assert.equal(
    adaptIdentityRiskResponses(foundation).hawkView.meta.status,
    'NOT_EVALUATED'
  )
})

test('accepts the final engine and catalog versions and rejects version drift', () => {
  const valid = adaptIdentityRiskResponses(validResponses())
  assert.equal(valid.hawkView.meta.engineVersion, 'hawkview-identity-engine/1')
  assert.equal(valid.hawkView.meta.catalogVersion, 'hawkview-identity-signals/v1')
  assert.equal(
    valid.microsoft.meta.catalogVersion,
    'microsoft-entra-risky-users/v1'
  )

  for (const [target, field, value] of [
    ['hawkViewSummary', 'engineVersion', 'hawkview-identity-engine/2'],
    ['hawkViewFindings', 'catalogVersion', 'hawkview-identity-signals/v2'],
    ['microsoftRiskyUsers', 'engineVersion', 'hawkview-identity-engine/1'],
    ['microsoftRiskyUsers', 'catalogVersion', 'microsoft-risk/v2'],
  ] as const) {
    const responses = validResponses()
    responses[target] = { ...responses[target], [field]: value }
    const view = adaptIdentityRiskResponses(responses)
    assert.notEqual(
      target === 'microsoftRiskyUsers'
        ? view.microsoft.meta.status
        : view.hawkView.meta.status,
      'AVAILABLE'
    )
  }
})

test('validates exact, capped, and unavailable summary count semantics', () => {
  const capped = validResponses()
  capped.hawkViewSummary = {
    ...capped.hawkViewSummary,
    counts: summaryCounts({
      matchedResults: boundedCount(24, false, true),
    }),
  }
  assert.deepEqual(
    adaptIdentityRiskResponses(capped).hawkView.counts?.matchedResults,
    boundedCount(24, false, true)
  )

  for (const invalidCount of [
    boundedCount(1, true, true),
    boundedCount(1, false, false),
    boundedCount(10_001),
  ]) {
    const responses = validResponses()
    responses.hawkViewSummary = {
      ...responses.hawkViewSummary,
      counts: summaryCounts({ openFindings: invalidCount }),
    }
    assert.equal(adaptIdentityRiskResponses(responses).hawkView.counts, null)
  }
})

test('preserves unavailable evidence and authoritative Microsoft empty as different states', () => {
  const responses = validResponses()
  const unavailableMeta = {
    capability: 'UNAVAILABLE',
    status: 'UNAVAILABLE',
    evaluatedAt: null,
    observedAt: null,
    freshness: 'UNKNOWN',
    limitation: 'HawkView identity signal evaluation is not enabled.',
  }
  responses.hawkViewSummary = {
    ...responses.hawkViewSummary,
    ...unavailableMeta,
    counts: unavailableSummaryCounts(),
  }
  responses.hawkViewFindings = {
    ...responses.hawkViewFindings,
    ...unavailableMeta,
    findings: [],
    pageInfo: { hasMore: false, nextCursor: null },
  }
  responses.microsoftRiskyUsers = {
    ...responses.microsoftRiskyUsers,
    users: [],
    pageInfo: { hasMore: false, nextCursor: null },
  }

  const view = adaptIdentityRiskResponses(responses)
  assert.equal(view.hawkView.meta.status, 'UNAVAILABLE')
  assert.deepEqual(view.hawkView.findings, [])
  assert.equal(view.microsoft.meta.status, 'AVAILABLE')
  assert.deepEqual(view.microsoft.users, [])
})

test('rejects non-canonical evaluation time and cursor shapes', () => {
  const whitespace = validResponses()
  whitespace.microsoftRiskyUsers = {
    ...whitespace.microsoftRiskyUsers,
    evaluatedAt: ` ${now}`,
  }
  assert.equal(
    adaptIdentityRiskResponses(whitespace).microsoft.meta.status,
    'ERROR'
  )

  for (const nextCursor of ['one-segment', 'body.signature.extra', 'body.=']) {
    const responses = validResponses()
    responses.microsoftRiskyUsers = {
      ...responses.microsoftRiskyUsers,
      pageInfo: { hasMore: true, nextCursor },
    }
    assert.equal(
      adaptIdentityRiskResponses(responses).microsoft.meta.status,
      'ERROR'
    )
  }
})
