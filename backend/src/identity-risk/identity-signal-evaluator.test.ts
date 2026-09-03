import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  IDENTITY_RISK_ENGINE_VERSION,
  IDENTITY_SIGNAL_CATALOG_VERSION,
  IDENTITY_SIGNAL_MAX_BATCH_CANDIDATES,
  IDENTITY_SIGNAL_MAX_BATCH_INPUT_BYTES,
  IDENTITY_SIGNAL_MAX_BATCH_OUTPUT_BYTES,
  IDENTITY_SIGNAL_RULE_IDS,
  type AccountClass,
  type ApprovedCatalog,
  type CatalogType,
  type CandidateBase,
  type IdentitySignalCandidate,
  type IdentitySignalEvaluationContext,
  type IdentitySignalRuleId,
  type NetworkContextEntry,
} from './identity-signal-contract.js'
import { IDENTITY_SIGNAL_RULE_CATALOG } from './identity-signal-catalog.js'
import { computeIdentitySignalCatalogDigest, evaluateIdentitySignal, evaluateIdentitySignals } from './identity-signal-evaluator.js'

const NOW = '2026-09-02T12:00:00.000Z'

function opaque(kind: string, label: string): string {
  if (label.startsWith('hvr1_')) return label
  return `hvr1_${kind}_${createHash('sha256').update(`${kind}:${label}`).digest('hex')}`
}

function approvedCatalog(
  catalogType: CatalogType,
  options: {
    values?: string[]
    accountClasses?: Record<string, AccountClass>
    contextEntries?: NetworkContextEntry[]
    status?: 'DRAFT' | 'APPROVED'
    approvers?: string[]
  } = {},
): ApprovedCatalog {
  const accountClasses = options.accountClasses
    ? Object.fromEntries(Object.entries(options.accountClasses).map(([key, accountClass]) => [opaque('subject', key), accountClass]))
    : undefined
  const contextEntries = (options.contextEntries ?? (catalogType === 'NETWORK_CONTEXT' ? [] : undefined))?.map((entry) => ({
    ...entry,
    id: opaque('context', entry.id),
    subjectId: entry.subjectId ? opaque('subject', entry.subjectId) : undefined,
    appId: entry.appId ? opaque('application', entry.appId) : undefined,
    deviceFingerprint: entry.deviceFingerprint ? opaque('device', entry.deviceFingerprint) : undefined,
    sourceFingerprint: entry.sourceFingerprint ? opaque('source', entry.sourceFingerprint) : undefined,
  }))
  const value = {
    catalogType,
    version: `${catalogType.toLowerCase()}/1`,
    status: options.status ?? 'APPROVED' as const,
    approverIds: (options.approvers ?? ['reviewer-a', 'reviewer-b']).map((value) => opaque('reviewer', value)),
    effectiveAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2027-08-01T00:00:00.000Z',
    values: options.values ?? [],
    accountClasses,
    contextEntries,
  }
  return Object.freeze({ ...value, digest: computeIdentitySignalCatalogDigest(value) })
}

function context(overrides: Partial<IdentitySignalEvaluationContext> = {}): IdentitySignalEvaluationContext {
  return {
    organizationId: opaque('org', 'org-a'),
    customerTenantId: opaque('tenant', 'tenant-a'),
    evaluatedAt: NOW,
    engineVersion: IDENTITY_RISK_ENGINE_VERSION,
    catalogVersion: IDENTITY_SIGNAL_CATALOG_VERSION,
    readiness: 'READY',
    capability: 'FULL',
    futureClockSkewToleranceMs: 5 * 60 * 1000,
    featureFlags: Object.fromEntries(IDENTITY_SIGNAL_RULE_IDS.map((ruleId) => [ruleId, true])),
    catalogs: [
      approvedCatalog('PRIVILEGED_ROLE_GROUP', { values: ['privileged-op'] }),
      approvedCatalog('HIGH_IMPACT_OPERATION', { values: ['reset-mfa'] }),
      approvedCatalog('HIGH_IMPACT_APPLICATION_PERMISSION', { values: ['directory.readwrite.all'] }),
      approvedCatalog('LEGACY_CLIENT', { values: ['imap'] }),
      approvedCatalog('ACCOUNT_CLASS', {
        accountClasses: {
          'user-1': 'HUMAN',
          'admin-1': 'PRIVILEGED_HUMAN',
          'breakglass-1': 'BREAK_GLASS',
          'service-1': 'SERVICE',
          'user-2': 'HUMAN',
          'user-3': 'HUMAN',
          'user-4': 'HUMAN',
          'user-5': 'HUMAN',
        },
      }),
      approvedCatalog('NETWORK_CONTEXT'),
    ],
    ...overrides,
  }
}

function common<RuleId extends IdentitySignalRuleId>(ruleId: RuleId, subjectId = 'user-1'): CandidateBase & { ruleId: RuleId } {
  return {
    ruleId,
    subject: { type: 'USER' as const, opaqueId: opaque('subject', subjectId) },
    evidenceReferences: [opaque('evidence', 'evidence-b'), opaque('evidence', 'evidence-a'), opaque('evidence', 'evidence-a')],
    evidence: [{ observedAt: '2026-09-02T11:30:00.000Z', maxAgeHours: 2 }],
    evidenceState: 'COMPLETE' as const,
  }
}

const matureHumanBaseline = {
  status: 'MATURE' as const,
  activeDays: 7,
  successfulInteractiveSignIns: 20,
}

test('catalog covers every stable rule once and leaves every feature disabled by default', () => {
  assert.deepEqual(IDENTITY_SIGNAL_RULE_CATALOG.map((entry) => entry.ruleId), IDENTITY_SIGNAL_RULE_IDS)
  assert.ok(IDENTITY_SIGNAL_RULE_CATALOG.every((entry) => entry.featureFlagDefault === false))
  assert.equal(new Set(IDENTITY_SIGNAL_RULE_CATALOG.map((entry) => entry.ruleId)).size, IDENTITY_SIGNAL_RULE_IDS.length)
})

test('feature flags, readiness, partial coverage, stale evidence, and future evidence fail closed', () => {
  const candidate = {
    ...common('HV-ID-EXP-001.v1', 'admin-1'), privileged: true, enabled: true, effectiveMfa: 'NOT_ENFORCED' as const,
  }
  assert.equal(evaluateIdentitySignal(context({ featureFlags: {} }), candidate).reasonCodes[0], 'RULE_FEATURE_DISABLED')
  assert.equal(evaluateIdentitySignal(context({ readiness: 'NOT_READY' }), candidate).reasonCodes[0], 'EVIDENCE_UNAVAILABLE')
  assert.equal(evaluateIdentitySignal(context({ capability: 'PARTIAL' }), candidate).reasonCodes[0], 'EVIDENCE_PARTIAL')
  assert.equal(evaluateIdentitySignal(context(), { ...candidate, evidence: [{ observedAt: '2026-09-01T00:00:00.000Z', maxAgeHours: 2 }] }).reasonCodes[0], 'EVIDENCE_STALE')
  assert.equal(evaluateIdentitySignal(context(), { ...candidate, evidence: [{ observedAt: '2026-09-02T12:06:00.000Z', maxAgeHours: 2 }] }).reasonCodes[0], 'EVIDENCE_FUTURE_DATED')
  assert.equal(evaluateIdentitySignal(context({ futureClockSkewToleranceMs: null }), candidate).reasonCodes[0], 'RULE_CONFIG_UNAPPROVED')
  assert.equal(evaluateIdentitySignal(context({ organizationId: '' }), candidate).reasonCodes[0], 'RULE_CONFIG_UNAPPROVED')
})

test('missing, draft, single-approved, expired, or digest-tampered catalogs cannot enable dependent rules', () => {
  const candidate = {
    ...common('HV-ID-EXP-001.v1', 'admin-1'), privileged: true, enabled: true, effectiveMfa: 'NOT_ENFORCED' as const,
  }
  assert.equal(evaluateIdentitySignal(context({ catalogs: [] }), candidate).reasonCodes[0], 'RULE_CONFIG_UNAPPROVED')
  assert.equal(evaluateIdentitySignal(context({ catalogs: [approvedCatalog('PRIVILEGED_ROLE_GROUP', { status: 'DRAFT' })] }), candidate).reasonCodes[0], 'RULE_CONFIG_UNAPPROVED')
  assert.equal(evaluateIdentitySignal(context({ catalogs: [approvedCatalog('PRIVILEGED_ROLE_GROUP', { approvers: ['same', 'same'] })] }), candidate).reasonCodes[0], 'RULE_CONFIG_UNAPPROVED')
  const valid = approvedCatalog('PRIVILEGED_ROLE_GROUP', { values: ['privileged-op'] })
  assert.equal(evaluateIdentitySignal(context({ catalogs: [{ ...valid, digest: '0'.repeat(64) }] }), candidate).reasonCodes[0], 'RULE_CONFIG_UNAPPROVED')
  const unsorted = approvedCatalog('PRIVILEGED_ROLE_GROUP', { values: ['z-role', 'a-role'] })
  assert.equal(evaluateIdentitySignal(context({ catalogs: [unsorted] }), candidate).reasonCodes[0], 'RULE_CONFIG_UNAPPROVED')
})

test('privileged exposure rules preserve effective-MFA and guest truth without compromise language', () => {
  const mfa = evaluateIdentitySignal(context(), {
    ...common('HV-ID-EXP-001.v1', 'admin-1'), privileged: true, enabled: true, effectiveMfa: 'NOT_ENFORCED',
  })
  const guest = evaluateIdentitySignal(context(), {
    ...common('HV-ID-EXP-002.v1', 'admin-1'), privileged: true, enabled: true, userType: 'GUEST',
  })
  assert.deepEqual([mfa.status, mfa.severity, guest.status, guest.severity], ['MATCHED', 'MEDIUM', 'MATCHED', 'MEDIUM'])
  assert.ok(!JSON.stringify([mfa, guest]).toLowerCase().includes('compromis'))
})

test('dormant privileged identity uses exact 45-day boundary and privileged baseline maturity', () => {
  const base = {
    ...common('HV-ID-EXP-003.v1', 'admin-1'), privileged: true, enabled: true,
    baseline: { status: 'MATURE' as const, activeDays: 14, successfulInteractiveSignIns: 20 },
    lastSuccessfulInteractiveSignInAt: '2026-07-19T12:00:00.000Z',
  }
  assert.equal(evaluateIdentitySignal(context(), base).status, 'MATCHED')
  assert.equal(evaluateIdentitySignal(context(), { ...base, baseline: { ...base.baseline, activeDays: 13 } }).reasonCodes[0], 'BASELINE_LEARNING')
})

test('lifecycle privilege rules require successful cataloged operations and exact time windows', () => {
  const first = {
    ...common('HV-ID-CHG-001.v1'), lifecycle: 'CREATED' as const,
    lifecycleAt: '2026-09-01T12:00:00.000Z', privilegeAt: '2026-09-02T11:59:59.999Z',
    privilegeOperation: 'PRIVILEGED-OP', privilegeSucceeded: true,
  }
  assert.equal(evaluateIdentitySignal(context(), first).status, 'MATCHED')
  assert.equal(evaluateIdentitySignal(context(), { ...first, privilegeAt: '2026-09-02T12:00:00.000Z' }).status, 'NOT_MATCHED')
  const second = {
    ...common('HV-ID-CHG-002.v1'), userType: 'MEMBER' as const,
    authoritativeCreatedAt: '2026-08-27T12:00:00.001Z', privilegeAt: NOW,
    privilegeOperation: 'privileged-op', privilegeSucceeded: true,
  }
  assert.equal(evaluateIdentitySignal(context(), second).status, 'MATCHED')
})

test('privileged-change burst includes anchor and excludes an event exactly 15 minutes older', () => {
  const event = (id: string, occurredAt: string) => ({ id: opaque('event', id), occurredAt, actorId: opaque('actor', 'actor-1'), operation: 'reset-mfa', succeeded: true })
  const candidate = {
    ...common('HV-ID-CHG-003.v1'), anchorAt: NOW, actorId: opaque('actor', 'actor-1'),
    events: [
      event('excluded', '2026-09-02T11:45:00.000Z'), event('1', '2026-09-02T11:45:00.001Z'),
      event('2', '2026-09-02T11:48:00.000Z'), event('3', '2026-09-02T11:50:00.000Z'),
      event('4', '2026-09-02T11:55:00.000Z'), event('5', NOW), event('5', NOW),
    ],
  }
  assert.equal(evaluateIdentitySignal(context(), candidate).status, 'MATCHED')
  assert.equal(evaluateIdentitySignal(context(), { ...candidate, events: candidate.events.filter((entry) => entry.id !== opaque('event', '4')) }).status, 'NOT_MATCHED')
})

test('administrative rarity and security weakening use locked thresholds and transitions', () => {
  const rarity = {
    ...common('HV-ID-CHG-004.v1'), operation: 'reset-mfa', actorBaselineEvents: 20,
    tenantBaselineEvents: 100, actorOperationCount: 0, tenantOperationCount: 2,
    baselineActiveDays: 30, succeeded: true,
  }
  assert.equal(evaluateIdentitySignal(context(), rarity).status, 'MATCHED')
  assert.equal(evaluateIdentitySignal(context(), { ...rarity, tenantOperationCount: 3 }).status, 'NOT_MATCHED')
  assert.equal(evaluateIdentitySignal(context(), {
    ...common('HV-ID-CHG-005.v1'), change: 'SECURITY_DEFAULTS', before: true, after: false, succeeded: true,
  }).severity, 'HIGH')
})

test('application rules distinguish declared permission from credential metadata changes', () => {
  assert.equal(evaluateIdentitySignal(context(), {
    ...common('HV-ID-APP-001.v1', 'app-1'), subject: { type: 'APPLICATION', opaqueId: opaque('application', 'app-1') },
    declaredPermissions: ['Directory.ReadWrite.All'], authoritativeCreatedAt: '2026-09-01T12:00:00.000Z', observedAt: NOW,
  }).status, 'MATCHED')
  assert.equal(evaluateIdentitySignal(context(), {
    ...common('HV-ID-APP-002.v1', 'app-1'), subject: { type: 'APPLICATION', opaqueId: opaque('application', 'app-1') },
    applicationPermissionIds: ['Directory.ReadWrite.All'], credentialMetadataChanged: true, authoritativeComparable: true, succeeded: true,
  }).status, 'MATCHED')
})

test('mailbox rules normalize accepted domains and fail closed on incomplete projection', () => {
  assert.equal(evaluateIdentitySignal(context(), {
    ...common('HV-ID-MBX-001.v1', 'mailbox-1'), subject: { type: 'MAILBOX', opaqueId: opaque('mailbox', 'mailbox-1') },
    enabled: true, recipientAddresses: ['safe@tenant.example', 'external@example.net'], verifiedAcceptedDomains: ['tenant.example'],
  }).status, 'MATCHED')
  const concealment = {
    ...common('HV-ID-MBX-002.v1', 'mailbox-1'), subject: { type: 'MAILBOX' as const, opaqueId: opaque('mailbox', 'mailbox-1') },
    enabled: true, conditionsCompleteness: 'COMPLETE' as const, actionsCompleteness: 'COMPLETE' as const,
    populatedConditionCount: 0, populatedExceptionCount: 0,
    actions: { delete: true, permanentDelete: false, moveTarget: false, markAsRead: true, stopProcessing: false },
  }
  assert.equal(evaluateIdentitySignal(context(), concealment).status, 'MATCHED')
  assert.equal(evaluateIdentitySignal(context(), { ...concealment, actionsCompleteness: 'INCOMPLETE' }).reasonCodes[0], 'MAILBOX_RULE_PROJECTION_INCOMPLETE')
})

test('mailbox correlation requires complete projection, independent auth family, and half-open two-hour window', () => {
  const candidate = {
    ...common('HV-ID-MBX-003.v1', 'mailbox-1'), subject: { type: 'MAILBOX' as const, opaqueId: opaque('mailbox', 'mailbox-1') },
    projectionComplete: true, mailboxChangeAt: '2026-09-02T11:59:59.999Z', independentSignInAt: '2026-09-02T10:00:00.000Z',
    independentSignInRuleId: 'HV-ID-AUTH-006.v1' as const, baseSeverity: 'HIGH' as const,
  }
  assert.equal(evaluateIdentitySignal(context(), candidate).severity, 'CRITICAL')
  assert.equal(evaluateIdentitySignal(context(), { ...candidate, mailboxChangeAt: NOW }).status, 'NOT_MATCHED')
})

test('disabled and dormant activity rules retain outcome and learning semantics', () => {
  assert.equal(evaluateIdentitySignal(context(), {
    ...common('HV-ID-AUTH-001.v1'), disabledAt: '2026-09-02T10:00:00.000Z', activityAt: '2026-09-02T11:00:00.000Z', outcome: 'FAILURE',
  }).severity, 'MEDIUM')
  assert.equal(evaluateIdentitySignal(context(), {
    ...common('HV-ID-AUTH-002.v1'), baseline: matureHumanBaseline, eventAt: NOW,
    lastSuccessfulInteractiveSignInAt: '2026-07-19T12:00:00.000Z', successfulInteractive: true,
  }).status, 'MATCHED')
})

test('unfamiliar-properties rule masks exact shared contexts and never learns masked properties', () => {
  const entries: NetworkContextEntry[] = [{
    id: 'egress-1', type: 'SHARED_EGRESS', startsAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-09-03T00:00:00.000Z', sourceFingerprint: 'source-1',
  }]
  const ctx = context({ catalogs: context().catalogs!.map((entry) => entry.catalogType === 'NETWORK_CONTEXT' ? approvedCatalog('NETWORK_CONTEXT', { contextEntries: entries }) : entry) })
  const candidate = {
    ...common('HV-ID-AUTH-003.v1'), baseline: {
      ...matureHumanBaseline,
      propertyFrequency: {
        [`device:${opaque('device', 'device-1')}`]: { events: 5, days: 3 },
        'client:browser': { events: 5, days: 3 },
        [`app:${opaque('application', 'app-1')}`]: { events: 5, days: 3 },
      },
    },
    properties: { country: 'CA', asn: 64500, device: opaque('device', 'device-1'), client: 'browser', app: opaque('application', 'app-1') }, sourceFingerprint: opaque('source', 'source-1'),
  }
  assert.equal(evaluateIdentitySignal(ctx, candidate).status, 'SUPPRESSED')
})

test('travel uses strict distance and speed and exact expiring exceptions', () => {
  const candidate = {
    ...common('HV-ID-AUTH-004.v1'),
    baseline: matureHumanBaseline,
    previous: { occurredAt: '2026-09-02T10:00:00.000Z', latitude: 43.6532, longitude: -79.3832, sourceFingerprint: opaque('source', 'toronto') },
    current: { occurredAt: '2026-09-02T11:00:00.000Z', latitude: 51.5074, longitude: -0.1278, sourceFingerprint: opaque('source', 'london') },
  }
  assert.equal(evaluateIdentitySignal(context(), candidate).status, 'MATCHED')
  const network = approvedCatalog('NETWORK_CONTEXT', { contextEntries: [{
    id: 'travel-1', type: 'TRAVEL_EXCEPTION', startsAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-09-03T00:00:00.000Z', subjectId: 'user-1', sourceFingerprint: 'london',
  }] })
  assert.equal(evaluateIdentitySignal(context({ catalogs: context().catalogs!.map((entry) => entry.catalogType === 'NETWORK_CONTEXT' ? network : entry) }), candidate).status, 'SUPPRESSED')
})

test('broad or malformed network exceptions fail closed instead of suppressing a tenant', () => {
  const unsafe = approvedCatalog('NETWORK_CONTEXT', { contextEntries: [{
    id: 'unsafe', type: 'SHARED_EGRESS', startsAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-09-03T00:00:00.000Z',
  }] })
  const ctx = context({ catalogs: context().catalogs!.map((entry) => entry.catalogType === 'NETWORK_CONTEXT' ? unsafe : entry) })
  assert.equal(evaluateIdentitySignal(ctx, {
    ...common('HV-ID-AUTH-003.v1'), baseline: matureHumanBaseline,
    properties: { country: 'CA', asn: 64500, device: opaque('device', 'device-1'), client: 'browser', app: opaque('application', 'app-1') }, sourceFingerprint: opaque('source', 'source-1'),
  }).reasonCodes[0], 'RULE_CONFIG_UNAPPROVED')
})

function burstEvents(kind: 'FAILURE' | 'MFA_DENIED', count: number) {
  return [
    ...Array.from({ length: count }, (_, index) => ({
      id: opaque('event', `failure-${index}`), occurredAt: `2026-09-02T11:0${Math.min(index, 9)}:00.000Z`, outcome: kind,
      interactive: true, subjectId: opaque('subject', 'user-1'), appId: opaque('application', 'app-1'), client: 'browser', deviceFingerprint: opaque('device', 'device-1'), sourceFingerprint: opaque('source', 'source-1'),
    } as const)),
    { id: opaque('event', 'success'), occurredAt: '2026-09-02T11:12:00.000Z', outcome: 'SUCCESS' as const, interactive: true, subjectId: opaque('subject', 'user-1'), appId: opaque('application', 'app-1'), client: 'browser', deviceFingerprint: opaque('device', 'device-1'), sourceFingerprint: opaque('source', 'source-1') },
  ]
}

test('failure and MFA-denial bursts match exact thresholds; expected retries suppress only exact episodes', () => {
  const failureCandidate = { ...common('HV-ID-AUTH-005.v1'), events: burstEvents('FAILURE', 10) }
  assert.equal(evaluateIdentitySignal(context(), failureCandidate).status, 'MATCHED')
  const retry = approvedCatalog('NETWORK_CONTEXT', { contextEntries: [{
    id: 'retry-1', type: 'EXPECTED_AUTH_RETRY', startsAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-09-03T00:00:00.000Z',
    subjectId: 'user-1', appId: 'app-1', client: 'browser', deviceFingerprint: 'device-1', sourceFingerprint: 'source-1',
  }] })
  const retryContext = context({ catalogs: context().catalogs!.map((entry) => entry.catalogType === 'NETWORK_CONTEXT' ? retry : entry) })
  assert.equal(evaluateIdentitySignal(retryContext, failureCandidate).reasonCodes[0], 'EXPECTED_AUTH_RETRY')
  assert.equal(evaluateIdentitySignal(context(), { ...common('HV-ID-AUTH-006.v1'), events: burstEvents('MFA_DENIED', 3), normalizedMfaDetailComplete: true }).severity, 'HIGH')
  const mixedSubjects = burstEvents('FAILURE', 10).map((event, index) => event.outcome === 'FAILURE' ? { ...event, subjectId: opaque('subject', index % 2 ? 'user-1' : 'user-2') } : event)
  assert.equal(evaluateIdentitySignal(context(), { ...common('HV-ID-AUTH-005.v1'), events: mixedSubjects }).status, 'NOT_MATCHED')
})

test('privileged legacy authentication requires exact approved client', () => {
  assert.equal(evaluateIdentitySignal(context(), {
    ...common('HV-ID-AUTH-007.v1', 'admin-1'), privileged: true, succeeded: true, client: 'IMAP',
  }).status, 'MATCHED')
})

test('password spray excludes unsupported classes, requires completeness, and suppresses shared egress', () => {
  const failures = Array.from({ length: 10 }, (_, index) => ({
    id: opaque('event', `spray-${index}`), occurredAt: `2026-09-02T11:0${index}:00.000Z`, outcome: 'FAILURE' as const,
    interactive: true, subjectId: opaque('subject', `user-${(index % 5) + 1}`), sourceFingerprint: opaque('source', 'spray-source'), deviceFingerprint: opaque('device', 'device-x'),
  }))
  const candidate = {
    ...common('HV-ID-AUTH-008.v1', 'source-1'), subject: { type: 'SOURCE' as const, opaqueId: opaque('source', 'source-1') }, tenantWideComplete: true,
    events: [...failures, { id: opaque('event', 'spray-success'), occurredAt: '2026-09-02T11:12:00.000Z', outcome: 'SUCCESS' as const, interactive: true, subjectId: opaque('subject', 'user-1'), sourceFingerprint: opaque('source', 'spray-source'), deviceFingerprint: opaque('device', 'device-x') }],
  }
  assert.equal(evaluateIdentitySignal(context(), candidate).status, 'MATCHED')
  const shared = approvedCatalog('NETWORK_CONTEXT', { contextEntries: [{
    id: 'shared-1', type: 'SHARED_EGRESS', startsAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-09-03T00:00:00.000Z', sourceFingerprint: 'spray-source',
  }] })
  assert.equal(evaluateIdentitySignal(context({ catalogs: context().catalogs!.map((entry) => entry.catalogType === 'NETWORK_CONTEXT' ? shared : entry) }), candidate).status, 'SUPPRESSED')
  assert.equal(evaluateIdentitySignal(context(), { ...candidate, tenantWideComplete: false }).status, 'NOT_EVALUATED')
})

test('unexpected break-glass use is the sole direct Critical rule and approved windows suppress it', () => {
  const candidate = { ...common('HV-ID-AUTH-009.v1', 'breakglass-1'), successfulInteractive: true, occurredAt: NOW }
  assert.equal(evaluateIdentitySignal(context(), candidate).severity, 'CRITICAL')
  const maintenance = approvedCatalog('NETWORK_CONTEXT', { contextEntries: [{
    id: 'exercise-1', type: 'MAINTENANCE', startsAt: '2026-09-02T11:00:00.000Z', expiresAt: '2026-09-02T13:00:00.000Z', subjectId: 'breakglass-1',
  }] })
  assert.equal(evaluateIdentitySignal(context({ catalogs: context().catalogs!.map((entry) => entry.catalogType === 'NETWORK_CONTEXT' ? maintenance : entry) }), candidate).status, 'SUPPRESSED')
})

test('output is deterministic, sorted, evidence-bounded, and excludes Microsoft risk by construction', () => {
  const candidate = {
    ...common('HV-ID-EXP-001.v1', 'admin-1'), privileged: true, enabled: true, effectiveMfa: 'NOT_ENFORCED' as const,
  } as IdentitySignalCandidate
  const first = evaluateIdentitySignal(context(), candidate)
  const second = evaluateIdentitySignal(context(), candidate)
  assert.deepEqual(first, second)
  assert.deepEqual(first.evidenceReferences, [opaque('evidence', 'evidence-a'), opaque('evidence', 'evidence-b')].sort())
  const serialized = JSON.stringify(first)
  assert.ok(!serialized.includes('microsoft'))
  assert.equal(first.channel, 'HAWKVIEW_IDENTITY_SIGNALS')
  assert.equal('probability' in first, false)
  assert.equal('score' in first, false)
})

test('unknown detector properties fail closed and never reach output', () => {
  const candidate = {
    ...common('HV-ID-EXP-001.v1', 'admin-1'), privileged: true, enabled: true, effectiveMfa: 'NOT_ENFORCED',
    microsoftUserRisk: 'high', raw: { access_token: 'must-not-appear' },
  }
  const output = evaluateIdentitySignal(context(), candidate)
  assert.equal(output.status, 'NOT_EVALUATED')
  assert.equal(output.ruleId, null)
  assert.ok(!JSON.stringify(output).includes('must-not-appear'))
})

test('oversized or control-character output references fail closed and are never emitted', () => {
  const base = {
    ...common('HV-ID-EXP-001.v1', 'admin-1'), privileged: true, enabled: true, effectiveMfa: 'NOT_ENFORCED' as const,
  }
  const tooManyReferences = Array.from({ length: 33 }, (_, index) => `evidence-${index}`)
  const tooMany = evaluateIdentitySignal(context(), { ...base, evidenceReferences: tooManyReferences })
  assert.equal(tooMany.status, 'NOT_EVALUATED')
  assert.deepEqual(tooMany.reasonCodes, ['EVIDENCE_MALFORMED'])
  assert.deepEqual(tooMany.evidenceReferences, [])

  const unsafe = evaluateIdentitySignal(context(), { ...base, evidenceReferences: ['safe', 'unsafe\u0000reference'] })
  assert.equal(unsafe.status, 'NOT_EVALUATED')
  assert.deepEqual(unsafe.evidenceReferences, [])

  const oversizedSubject = evaluateIdentitySignal(context(), {
    ...base,
    subject: { type: 'USER', opaqueId: 'x'.repeat(161) },
  })
  assert.equal(oversizedSubject.status, 'NOT_EVALUATED')
  assert.equal(oversizedSubject.subject.opaqueId, 'EVALUATION_INPUT')
})

test('batch evaluation order is stable across reordered candidates', () => {
  const candidates: IdentitySignalCandidate[] = [
    { ...common('HV-ID-EXP-002.v1', 'admin-1'), privileged: true, enabled: true, userType: 'GUEST' },
    { ...common('HV-ID-EXP-001.v1', 'admin-1'), privileged: true, enabled: true, effectiveMfa: 'NOT_ENFORCED' },
  ]
  assert.deepEqual(evaluateIdentitySignals(context(), candidates), evaluateIdentitySignals(context(), [...candidates].reverse()))
})

test('unknown, accessor-backed, and prototype detector output never throws or echoes input', () => {
  const valid = {
    ...common('HV-ID-EXP-001.v1', 'admin-1'), privileged: true, enabled: true, effectiveMfa: 'NOT_ENFORCED' as const,
  }
  const unknownRule = { ...valid, ruleId: 'HV-ID-UNKNOWN-999.v1', raw: 'provider-secret' }
  const inherited = Object.assign(Object.create({ raw: 'inherited-secret' }), valid)
  const hostileProxy = new Proxy(valid, {
    getPrototypeOf() { throw new Error('prototype trap must not escape') },
  })
  const accessor = { ...valid } as Record<string, unknown>
  Object.defineProperty(accessor, 'ruleId', {
    enumerable: true,
    get() { throw new Error('getter must never run') },
  })
  for (const hostile of [unknownRule, inherited, accessor, hostileProxy]) {
    let output: ReturnType<typeof evaluateIdentitySignal> | undefined
    assert.doesNotThrow(() => { output = evaluateIdentitySignal(context(), hostile) })
    assert.ok(output)
    assert.equal(output.status, 'NOT_EVALUATED')
    assert.equal(output.ruleId, null)
    assert.deepEqual(output.reasonCodes, ['EVIDENCE_MALFORMED'])
    assert.ok(!JSON.stringify(output).includes('secret'))
  }
  let batch: ReturnType<typeof evaluateIdentitySignals> | undefined
  assert.doesNotThrow(() => { batch = evaluateIdentitySignals(context(), [unknownRule, valid, accessor]) })
  assert.ok(batch)
  assert.equal(batch.length, 3)
  assert.equal(batch.filter((entry) => entry.status === 'MATCHED').length, 1)
})

test('opaque privacy grammar rejects principals, URLs, credentials, JWTs, and provider snippets at every output sink', () => {
  const valid = {
    ...common('HV-ID-EXP-001.v1', 'admin-1'), privileged: true, enabled: true, effectiveMfa: 'NOT_ENFORCED' as const,
  }
  const jwt = `${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`
  const hostileCandidates = [
    { ...valid, subject: { type: 'USER', opaqueId: 'person@example.com' } },
    { ...valid, subject: { type: 'USER', opaqueId: 'Bearer-secret-value' } },
    { ...valid, evidenceReferences: ['https://provider.example/event?token=secret-value'] },
    { ...valid, evidenceReferences: [jwt] },
    { ...valid, subject: { type: 'USER', opaqueId: 'constructor' } },
  ]
  for (const hostile of hostileCandidates) {
    const serialized = JSON.stringify(evaluateIdentitySignal(context(), hostile))
    assert.ok(!serialized.includes('person@example.com'))
    assert.ok(!serialized.includes('provider.example'))
    assert.ok(!serialized.includes('secret-value'))
    assert.ok(!serialized.includes(jwt))
  }
  for (const secretShaped of [
    'sig=SIGNATURESECRET',
    'signature:SIGNATURESECRET',
    'code=OAUTHCODESECRET',
    'authorization_code=OAUTHCODESECRET',
    'api_key=APIKEYSECRET',
    'credential=CREDENTIALSECRET',
    `jwt:${jwt}`,
    `Bearer ${jwt}`,
    `hvr1_token_${'a'.repeat(64)}`,
    `hvr1_sig_${'b'.repeat(64)}`,
    `hvr1_code_${'c'.repeat(64)}`,
    `hvr1_credential_${'d'.repeat(64)}`,
  ]) {
    const output = evaluateIdentitySignal(context(), { ...valid, evidenceReferences: [secretShaped] })
    assert.equal(output.status, 'NOT_EVALUATED')
    assert.equal(output.ruleId, null)
    assert.ok(!JSON.stringify(output).includes(secretShaped))
  }

  const invalidCatalogs: ApprovedCatalog[] = [
    { ...approvedCatalog('PRIVILEGED_ROLE_GROUP'), approverIds: [opaque('reviewer', 'reviewer-a'), 'owner@example.com'] },
    approvedCatalog('PRIVILEGED_ROLE_GROUP', { values: ['access-token-secret'] }),
    { ...approvedCatalog('ACCOUNT_CLASS', { accountClasses: {} }), accountClasses: { 'owner@example.com': 'HUMAN' } },
    { ...approvedCatalog('NETWORK_CONTEXT'), contextEntries: [{
      id: 'https://provider.example/context', type: 'SHARED_EGRESS', startsAt: '2026-09-02T11:00:00.000Z',
      expiresAt: '2026-09-02T13:00:00.000Z', sourceFingerprint: 'source-1',
    }] },
  ]
  for (const catalog of invalidCatalogs) {
    const output = evaluateIdentitySignal(context({ catalogs: [catalog] }), valid)
    assert.equal(output.status, 'NOT_EVALUATED')
    assert.equal(output.ruleId, null)
    assert.ok(!JSON.stringify(output).includes('owner@example.com'))
    assert.ok(!JSON.stringify(output).includes('provider.example'))
    assert.ok(!JSON.stringify(output).includes('access-token-secret'))
  }
})

test('catalog signatures cover nested fields named digest instead of recursively omitting them', () => {
  const originalUnsigned = {
    catalogType: 'ACCOUNT_CLASS' as const,
    version: 'account_class/1',
    status: 'APPROVED' as const,
    approverIds: [opaque('reviewer', 'reviewer-a'), opaque('reviewer', 'reviewer-b')],
    effectiveAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2027-08-01T00:00:00.000Z',
    values: [] as string[],
    accountClasses: { digest: 'HUMAN' as const },
  }
  const changedUnsigned = {
    ...originalUnsigned,
    accountClasses: { digest: 'SERVICE' as const },
  }
  assert.notEqual(computeIdentitySignalCatalogDigest(originalUnsigned), computeIdentitySignalCatalogDigest(changedUnsigned))
  assert.equal(
    computeIdentitySignalCatalogDigest({ ...originalUnsigned, digest: 'top-level-signature-is-omitted' } as typeof originalUnsigned),
    computeIdentitySignalCatalogDigest(originalUnsigned),
  )
})

test('conflicting duplicate event IDs fail closed in either order while exact duplicates dedupe', () => {
  const changeEvent = (label: string, operation = 'reset-mfa') => ({
    id: opaque('event', label), occurredAt: '2026-09-02T11:59:00.000Z', actorId: opaque('actor', 'actor-1'), operation, succeeded: true,
  })
  const baseEvents = Array.from({ length: 5 }, (_, index) => changeEvent(`change-${index}`))
  const changeCandidate = {
    ...common('HV-ID-CHG-003.v1'), anchorAt: NOW, actorId: opaque('actor', 'actor-1'), events: baseEvents,
  }
  assert.equal(evaluateIdentitySignal(context(), { ...changeCandidate, events: [...baseEvents, baseEvents[0]!] }).status, 'MATCHED')
  const conflictingChange = { ...baseEvents[0]!, operation: 'other-operation' }
  for (const events of [[...baseEvents, conflictingChange], [conflictingChange, ...baseEvents]]) {
    assert.deepEqual(evaluateIdentitySignal(context(), { ...changeCandidate, events }).reasonCodes, ['EVIDENCE_MALFORMED'])
  }

  const authEvents = burstEvents('FAILURE', 10)
  const conflictingAuth = { ...authEvents[0]!, outcome: 'SUCCESS' as const }
  const authCandidate = { ...common('HV-ID-AUTH-005.v1'), events: authEvents }
  assert.equal(evaluateIdentitySignal(context(), { ...authCandidate, events: [...authEvents, authEvents[0]!] }).status, 'MATCHED')
  for (const events of [[...authEvents, conflictingAuth], [conflictingAuth, ...authEvents]]) {
    assert.deepEqual(evaluateIdentitySignal(context(), { ...authCandidate, events }).reasonCodes, ['EVIDENCE_MALFORMED'])
  }

  const sprayDuplicate = {
    id: opaque('event', 'spray-duplicate'), occurredAt: '2026-09-02T11:00:00.000Z', outcome: 'FAILURE' as const,
    interactive: true, subjectId: opaque('subject', 'user-1'), sourceFingerprint: opaque('source', 'spray-duplicate'),
  }
  const spray = {
    ...common('HV-ID-AUTH-008.v1', 'spray-source'), subject: { type: 'SOURCE' as const, opaqueId: opaque('source', 'spray-source') },
    tenantWideComplete: true, events: new Array(10).fill(sprayDuplicate),
  }
  assert.equal(evaluateIdentitySignal(context(), spray).status, 'NOT_MATCHED')
})

test('clock skew is a bounded version-owned policy from zero through five minutes', () => {
  const candidate = {
    ...common('HV-ID-EXP-001.v1', 'admin-1'),
    evidence: [{ observedAt: '2026-09-02T12:05:00.000Z', maxAgeHours: 2 }],
    privileged: true, enabled: true, effectiveMfa: 'NOT_ENFORCED' as const,
  }
  assert.equal(evaluateIdentitySignal(context({ futureClockSkewToleranceMs: 0 }), {
    ...candidate,
    evidence: [{ observedAt: NOW, maxAgeHours: 2 }],
  }).status, 'MATCHED')
  assert.equal(evaluateIdentitySignal(context({ futureClockSkewToleranceMs: 300_000 }), candidate).status, 'MATCHED')
  const rejected = evaluateIdentitySignal(context({ futureClockSkewToleranceMs: 300_001 }), candidate)
  assert.equal(rejected.status, 'NOT_EVALUATED')
  assert.deepEqual(rejected.reasonCodes, ['RULE_CONFIG_UNAPPROVED'])
})

test('rule-specific event and change timestamps accept +5m and reject +5m+1ms', () => {
  const changeAtBoundary = {
    ...common('HV-ID-CHG-001.v1'), lifecycle: 'CREATED' as const, lifecycleAt: NOW,
    privilegeAt: '2026-09-02T12:05:00.000Z', privilegeOperation: 'privileged-op', privilegeSucceeded: true,
  }
  assert.equal(evaluateIdentitySignal(context(), changeAtBoundary).status, 'MATCHED')
  assert.deepEqual(evaluateIdentitySignal(context(), {
    ...changeAtBoundary,
    privilegeAt: '2026-09-02T12:05:00.001Z',
  }).reasonCodes, ['EVIDENCE_FUTURE_DATED'])

  const event = (id: string, occurredAt: string) => ({ id: opaque('event', id), occurredAt, actorId: opaque('actor', 'actor-1'), operation: 'reset-mfa', succeeded: true })
  const burstAtBoundary = {
    ...common('HV-ID-CHG-003.v1'), anchorAt: '2026-09-02T12:05:00.000Z', actorId: opaque('actor', 'actor-1'),
    events: Array.from({ length: 5 }, (_, index) => event(`future-event-${index}`, '2026-09-02T12:05:00.000Z')),
  }
  assert.equal(evaluateIdentitySignal(context(), burstAtBoundary).status, 'MATCHED')
  assert.deepEqual(evaluateIdentitySignal(context(), {
    ...burstAtBoundary,
    events: [...burstAtBoundary.events, event('too-future', '2026-09-02T12:05:00.001Z')],
  }).reasonCodes, ['EVIDENCE_FUTURE_DATED'])
})

test('authentication, travel, break-glass, and context suppression cannot use evidence beyond +5m', () => {
  const disabledAtBoundary = {
    ...common('HV-ID-AUTH-001.v1'), disabledAt: NOW, activityAt: '2026-09-02T12:05:00.000Z', outcome: 'SUCCESS' as const,
  }
  assert.equal(evaluateIdentitySignal(context(), disabledAtBoundary).status, 'MATCHED')
  assert.deepEqual(evaluateIdentitySignal(context(), {
    ...disabledAtBoundary,
    activityAt: '2026-09-02T12:05:00.001Z',
  }).reasonCodes, ['EVIDENCE_FUTURE_DATED'])

  const futureEvents = [
    ...Array.from({ length: 10 }, (_, index) => ({
      id: opaque('event', `boundary-failure-${index}`), occurredAt: `2026-09-02T11:5${index}:00.000Z`, outcome: 'FAILURE' as const,
      interactive: true, subjectId: opaque('subject', 'user-1'), sourceFingerprint: opaque('source', 'source-1'),
    })),
    { id: opaque('event', 'boundary-success'), occurredAt: '2026-09-02T12:05:00.000Z', outcome: 'SUCCESS' as const, interactive: true, subjectId: opaque('subject', 'user-1'), sourceFingerprint: opaque('source', 'source-1') },
  ]
  const authBurst = { ...common('HV-ID-AUTH-005.v1'), events: futureEvents }
  assert.equal(evaluateIdentitySignal(context(), authBurst).status, 'MATCHED')
  assert.deepEqual(evaluateIdentitySignal(context(), {
    ...authBurst,
    events: futureEvents.map((event) => event.id === opaque('event', 'boundary-success') ? { ...event, occurredAt: '2026-09-02T12:05:00.001Z' } : event),
  }).reasonCodes, ['EVIDENCE_FUTURE_DATED'])

  const travelException = approvedCatalog('NETWORK_CONTEXT', { contextEntries: [{
    id: 'travel-boundary', type: 'TRAVEL_EXCEPTION', startsAt: '2026-09-02T11:00:00.000Z', expiresAt: '2026-09-02T13:00:00.000Z',
    subjectId: 'user-1', sourceFingerprint: 'london-boundary',
  }] })
  const contextual = context({ catalogs: context().catalogs!.map((entry) => entry.catalogType === 'NETWORK_CONTEXT' ? travelException : entry) })
  const travel = {
    ...common('HV-ID-AUTH-004.v1'), baseline: matureHumanBaseline,
    previous: { occurredAt: '2026-09-02T11:05:00.000Z', latitude: 43.6532, longitude: -79.3832, sourceFingerprint: opaque('source', 'toronto-boundary') },
    current: { occurredAt: '2026-09-02T12:05:00.000Z', latitude: 51.5074, longitude: -0.1278, sourceFingerprint: opaque('source', 'london-boundary') },
  }
  assert.equal(evaluateIdentitySignal(contextual, travel).status, 'SUPPRESSED')
  assert.deepEqual(evaluateIdentitySignal(contextual, {
    ...travel,
    current: { ...travel.current, occurredAt: '2026-09-02T12:05:00.001Z' },
  }).reasonCodes, ['EVIDENCE_FUTURE_DATED'])

  const breakGlass = { ...common('HV-ID-AUTH-009.v1', 'breakglass-1'), successfulInteractive: true, occurredAt: '2026-09-02T12:05:00.000Z' }
  assert.equal(evaluateIdentitySignal(context(), breakGlass).status, 'MATCHED')
  assert.deepEqual(evaluateIdentitySignal(context(), {
    ...breakGlass,
    occurredAt: '2026-09-02T12:05:00.001Z',
  }).reasonCodes, ['EVIDENCE_FUTURE_DATED'])
})

test('canonical timestamp parsing rejects impossible calendar rollovers', () => {
  const candidate = {
    ...common('HV-ID-CHG-001.v1'), lifecycle: 'CREATED' as const,
    lifecycleAt: '2026-02-30T12:00:00.000Z', privilegeAt: NOW,
    privilegeOperation: 'privileged-op', privilegeSucceeded: true,
  }
  const output = evaluateIdentitySignal(context(), candidate)
  assert.equal(output.status, 'NOT_EVALUATED')
  assert.deepEqual(output.reasonCodes, ['EVIDENCE_MALFORMED'])
  assert.equal(output.ruleId, null)
})

test('candidate count and byte budgets reject adversarial batches with one bounded operational result', () => {
  assert.equal(IDENTITY_SIGNAL_MAX_BATCH_CANDIDATES, 1_000)
  assert.equal(IDENTITY_SIGNAL_MAX_BATCH_INPUT_BYTES, 2_000_000)
  assert.equal(IDENTITY_SIGNAL_MAX_BATCH_OUTPUT_BYTES, 2_000_000)
  const candidate = {
    ...common('HV-ID-EXP-001.v1', 'admin-1'), privileged: true, enabled: true, effectiveMfa: 'NOT_ENFORCED' as const,
  }
  const fiftyThousand = new Array(50_000).fill(candidate)
  const countRejected = evaluateIdentitySignals(context(), fiftyThousand)
  assert.equal(countRejected.length, 1)
  assert.deepEqual(countRejected[0]!.reasonCodes, ['EVALUATION_BUDGET_EXCEEDED'])
  assert.equal(fiftyThousand.length, 50_000)

  const largeReferences = Array.from({ length: 32 }, (_, index) => opaque('evidence', `large-${index}`))
  const largeValidCandidate = { ...candidate, evidenceReferences: largeReferences }
  const byteRejected = evaluateIdentitySignals(context(), new Array(1_000).fill(largeValidCandidate))
  assert.equal(byteRejected.length, 1)
  assert.deepEqual(byteRejected[0]!.reasonCodes, ['EVALUATION_BUDGET_EXCEEDED'])
  assert.ok(Object.isFrozen(byteRejected))
})

test('catalog validation rejects duplicates, unknown fields, invalid classes, prototypes, and remains order independent', () => {
  const candidate = {
    ...common('HV-ID-EXP-001.v1', 'admin-1'), privileged: true, enabled: true, effectiveMfa: 'NOT_ENFORCED' as const,
  }
  const validCatalogs = context().catalogs!
  assert.deepEqual(
    evaluateIdentitySignal(context({ catalogs: validCatalogs }), candidate),
    evaluateIdentitySignal(context({ catalogs: [...validCatalogs].reverse() }), candidate),
  )
  const duplicate = context({ catalogs: [...validCatalogs, validCatalogs[0]!] })
  assert.deepEqual(evaluateIdentitySignal(duplicate, candidate).reasonCodes, ['RULE_CONFIG_UNAPPROVED'])

  const extra = { ...validCatalogs[0]!, providerPayload: 'do-not-echo' }
  assert.deepEqual(evaluateIdentitySignal(context({ catalogs: [extra as ApprovedCatalog] }), candidate).reasonCodes, ['RULE_CONFIG_UNAPPROVED'])
  const invalidClass = approvedCatalog('ACCOUNT_CLASS', { accountClasses: { 'admin-1': 'ADMIN' as AccountClass } })
  assert.deepEqual(evaluateIdentitySignal(context({ catalogs: [invalidClass] }), candidate).reasonCodes, ['RULE_CONFIG_UNAPPROVED'])
  const inherited = Object.assign(Object.create({ raw: 'secret' }), validCatalogs[0]!) as ApprovedCatalog
  assert.deepEqual(evaluateIdentitySignal(context({ catalogs: [inherited] }), candidate).reasonCodes, ['RULE_CONFIG_UNAPPROVED'])
})

test('batch result ordering uses canonical bytewise comparison', () => {
  const make = (opaqueId: string): IdentitySignalCandidate => ({
    ...common('HV-ID-EXP-001.v1', opaqueId), privileged: true, enabled: true, effectiveMfa: 'NOT_ENFORCED',
  })
  const output = evaluateIdentitySignals(context(), [make('admin-a'), make('admin-Z'), make('admin-A')])
  assert.deepEqual(output.map((entry) => entry.subject.opaqueId), [
    opaque('subject', 'admin-a'), opaque('subject', 'admin-Z'), opaque('subject', 'admin-A'),
  ].sort())
})
