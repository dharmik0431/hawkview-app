import assert from 'node:assert/strict'
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
  const value = {
    catalogType,
    version: `${catalogType.toLowerCase()}/1`,
    status: options.status ?? 'APPROVED' as const,
    approverIds: options.approvers ?? ['reviewer-a', 'reviewer-b'],
    effectiveAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2027-08-01T00:00:00.000Z',
    values: options.values ?? [],
    accountClasses: options.accountClasses,
    contextEntries: options.contextEntries ?? (catalogType === 'NETWORK_CONTEXT' ? [] : undefined),
  }
  return Object.freeze({ ...value, digest: computeIdentitySignalCatalogDigest(value) })
}

function context(overrides: Partial<IdentitySignalEvaluationContext> = {}): IdentitySignalEvaluationContext {
  return {
    organizationId: 'org-a',
    customerTenantId: 'tenant-a',
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
    subject: { type: 'USER' as const, opaqueId: subjectId },
    evidenceReferences: ['evidence-b', 'evidence-a', 'evidence-a'],
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
  const event = (id: string, occurredAt: string) => ({ id, occurredAt, actorId: 'actor-1', operation: 'reset-mfa', succeeded: true })
  const candidate = {
    ...common('HV-ID-CHG-003.v1'), anchorAt: NOW, actorId: 'actor-1',
    events: [
      event('excluded', '2026-09-02T11:45:00.000Z'), event('1', '2026-09-02T11:45:00.001Z'),
      event('2', '2026-09-02T11:48:00.000Z'), event('3', '2026-09-02T11:50:00.000Z'),
      event('4', '2026-09-02T11:55:00.000Z'), event('5', NOW), event('5', NOW),
    ],
  }
  assert.equal(evaluateIdentitySignal(context(), candidate).status, 'MATCHED')
  assert.equal(evaluateIdentitySignal(context(), { ...candidate, events: candidate.events.filter((entry) => entry.id !== '4') }).status, 'NOT_MATCHED')
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
    ...common('HV-ID-APP-001.v1', 'app-1'), subject: { type: 'APPLICATION', opaqueId: 'app-1' },
    declaredPermissions: ['Directory.ReadWrite.All'], authoritativeCreatedAt: '2026-09-01T12:00:00.000Z', observedAt: NOW,
  }).status, 'MATCHED')
  assert.equal(evaluateIdentitySignal(context(), {
    ...common('HV-ID-APP-002.v1', 'app-1'), subject: { type: 'APPLICATION', opaqueId: 'app-1' },
    applicationPermissionIds: ['Directory.ReadWrite.All'], credentialMetadataChanged: true, authoritativeComparable: true, succeeded: true,
  }).status, 'MATCHED')
})

test('mailbox rules normalize accepted domains and fail closed on incomplete projection', () => {
  assert.equal(evaluateIdentitySignal(context(), {
    ...common('HV-ID-MBX-001.v1', 'mailbox-1'), subject: { type: 'MAILBOX', opaqueId: 'mailbox-1' },
    enabled: true, recipientAddresses: ['safe@tenant.example', 'external@example.net'], verifiedAcceptedDomains: ['tenant.example'],
  }).status, 'MATCHED')
  const concealment = {
    ...common('HV-ID-MBX-002.v1', 'mailbox-1'), subject: { type: 'MAILBOX' as const, opaqueId: 'mailbox-1' },
    enabled: true, conditionsCompleteness: 'COMPLETE' as const, actionsCompleteness: 'COMPLETE' as const,
    populatedConditionCount: 0, populatedExceptionCount: 0,
    actions: { delete: true, permanentDelete: false, moveTarget: false, markAsRead: true, stopProcessing: false },
  }
  assert.equal(evaluateIdentitySignal(context(), concealment).status, 'MATCHED')
  assert.equal(evaluateIdentitySignal(context(), { ...concealment, actionsCompleteness: 'INCOMPLETE' }).reasonCodes[0], 'MAILBOX_RULE_PROJECTION_INCOMPLETE')
})

test('mailbox correlation requires complete projection, independent auth family, and half-open two-hour window', () => {
  const candidate = {
    ...common('HV-ID-MBX-003.v1', 'mailbox-1'), subject: { type: 'MAILBOX' as const, opaqueId: 'mailbox-1' },
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
      propertyFrequency: { 'device:device-1': { events: 5, days: 3 }, 'client:browser': { events: 5, days: 3 }, 'app:app-1': { events: 5, days: 3 } },
    },
    properties: { country: 'CA', asn: 64500, device: 'device-1', client: 'browser', app: 'app-1' }, sourceFingerprint: 'source-1',
  }
  assert.equal(evaluateIdentitySignal(ctx, candidate).status, 'SUPPRESSED')
})

test('travel uses strict distance and speed and exact expiring exceptions', () => {
  const candidate = {
    ...common('HV-ID-AUTH-004.v1'),
    baseline: matureHumanBaseline,
    previous: { occurredAt: '2026-09-02T10:00:00.000Z', latitude: 43.6532, longitude: -79.3832, sourceFingerprint: 'toronto' },
    current: { occurredAt: '2026-09-02T11:00:00.000Z', latitude: 51.5074, longitude: -0.1278, sourceFingerprint: 'london' },
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
    properties: { country: 'CA', asn: 64500, device: 'device-1', client: 'browser', app: 'app-1' }, sourceFingerprint: 'source-1',
  }).reasonCodes[0], 'RULE_CONFIG_UNAPPROVED')
})

function burstEvents(kind: 'FAILURE' | 'MFA_DENIED', count: number) {
  return [
    ...Array.from({ length: count }, (_, index) => ({
      id: `failure-${index}`, occurredAt: `2026-09-02T11:0${Math.min(index, 9)}:00.000Z`, outcome: kind,
      interactive: true, subjectId: 'user-1', appId: 'app-1', client: 'browser', deviceFingerprint: 'device-1', sourceFingerprint: 'source-1',
    } as const)),
    { id: 'success', occurredAt: '2026-09-02T11:12:00.000Z', outcome: 'SUCCESS' as const, interactive: true, subjectId: 'user-1', appId: 'app-1', client: 'browser', deviceFingerprint: 'device-1', sourceFingerprint: 'source-1' },
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
  const mixedSubjects = burstEvents('FAILURE', 10).map((event, index) => event.outcome === 'FAILURE' ? { ...event, subjectId: index % 2 ? 'user-1' : 'user-2' } : event)
  assert.equal(evaluateIdentitySignal(context(), { ...common('HV-ID-AUTH-005.v1'), events: mixedSubjects }).status, 'NOT_MATCHED')
})

test('privileged legacy authentication requires exact approved client', () => {
  assert.equal(evaluateIdentitySignal(context(), {
    ...common('HV-ID-AUTH-007.v1', 'admin-1'), privileged: true, succeeded: true, client: 'IMAP',
  }).status, 'MATCHED')
})

test('password spray excludes unsupported classes, requires completeness, and suppresses shared egress', () => {
  const failures = Array.from({ length: 10 }, (_, index) => ({
    id: `spray-${index}`, occurredAt: `2026-09-02T11:0${index}:00.000Z`, outcome: 'FAILURE' as const,
    interactive: true, subjectId: `user-${(index % 5) + 1}`, sourceFingerprint: 'spray-source', deviceFingerprint: 'device-x',
  }))
  const candidate = {
    ...common('HV-ID-AUTH-008.v1', 'source-1'), subject: { type: 'SOURCE' as const, opaqueId: 'source-1' }, tenantWideComplete: true,
    events: [...failures, { id: 'spray-success', occurredAt: '2026-09-02T11:12:00.000Z', outcome: 'SUCCESS' as const, interactive: true, subjectId: 'user-1', sourceFingerprint: 'spray-source', deviceFingerprint: 'device-x' }],
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
  assert.deepEqual(first.evidenceReferences, ['evidence-a', 'evidence-b'])
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

  const invalidCatalogs = [
    approvedCatalog('PRIVILEGED_ROLE_GROUP', { approvers: ['reviewer-a', 'owner@example.com'] }),
    approvedCatalog('PRIVILEGED_ROLE_GROUP', { values: ['access-token-secret'] }),
    approvedCatalog('ACCOUNT_CLASS', { accountClasses: { 'owner@example.com': 'HUMAN' } }),
    approvedCatalog('NETWORK_CONTEXT', { contextEntries: [{
      id: 'https://provider.example/context', type: 'SHARED_EGRESS', startsAt: '2026-09-02T11:00:00.000Z',
      expiresAt: '2026-09-02T13:00:00.000Z', sourceFingerprint: 'source-1',
    }] }),
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

  const largeReferences = Array.from({ length: 32 }, (_, index) => `r${index}-${'x'.repeat(250)}`)
  const largeValidCandidate = { ...candidate, evidenceReferences: largeReferences }
  const byteRejected = evaluateIdentitySignals(context(), new Array(150).fill(largeValidCandidate))
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
  assert.deepEqual(output.map((entry) => entry.subject.opaqueId), ['admin-A', 'admin-Z', 'admin-a'])
})
