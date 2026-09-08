import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTH_RULE_A, AUTH_RULE_B, MAX_AUTH_EVENTS, MAX_AUTH_INCIDENTS } from './contract.js';
import type { AuthNormalizedEvent, AuthNormalizationResult } from './contract.js';
import { evaluateAuthenticationRules, highestAuthenticationPriority, mergeAuthenticationIncidents, normalizeAuthenticationRecord } from './index.js';
import { at, auditRecord, evaluation, event, failures, graphRecord, normalization, success, SYNTHETIC_NOW, SYNTHETIC_SCOPE } from './fixtures.js';

const normalized = (result: AuthNormalizationResult): AuthNormalizedEvent => { if (result.status !== 'ACCEPTED') throw new Error(result.reason); return result.event; };
const status = (events: readonly AuthNormalizedEvent[], rule = AUTH_RULE_A as string): string => evaluateAuthenticationRules(evaluation(events)).rules.find(value => value.ruleId === rule)!.status;
const context = { ...SYNTHETIC_SCOPE, source: 'GRAPH_SIGN_INS' as const, asOf: SYNTHETIC_NOW };

test('A requires ten distinct invalid-credential events; duplicates do not count', () => {
  assert.equal(status(failures(9)), 'NOT_MATCHED');
  assert.equal(status(failures(10)), 'MATCHED');
  assert.equal(status([...failures(9), ...failures(9)]), 'NOT_MATCHED');
  assert.equal(evaluateAuthenticationRules(evaluation([...failures(10), ...failures(10)])).duplicateCount, 10);
});
test('A includes exactly 15-minute span and excludes one millisecond beyond', () => {
  const rows = [event('oldest', -15), ...failures(9, -8)];
  assert.equal(status(rows), 'MATCHED');
  assert.equal(status([{ ...rows[0]!, eventAt: new Date(Date.parse(at(-15)) - 1).toISOString() }, ...rows.slice(1)]), 'NOT_MATCHED');
});
test('B requires five failures strictly before success and latest within two minutes', () => {
  assert.equal(status([...failures(4, -4), success()], AUTH_RULE_B), 'NOT_MATCHED');
  assert.equal(status([...failures(5, -5), success()], AUTH_RULE_B), 'MATCHED');
  assert.equal(status([...failures(5, -6), success()], AUTH_RULE_B), 'MATCHED');
  assert.equal(status([...failures(5, -7), success()], AUTH_RULE_B), 'NOT_MATCHED');
  assert.equal(status([...failures(4, -4), event('equal-to-success', 0), success()], AUTH_RULE_B), 'NOT_MATCHED');
});
test('B lower ten-minute boundary is inclusive; one millisecond earlier is excluded', () => {
  const rows = [event('oldest', -10), ...failures(4, -4), success()];
  assert.equal(status(rows, AUTH_RULE_B), 'MATCHED');
  assert.equal(status([{ ...rows[0]!, eventAt: new Date(Date.parse(at(-10)) - 1).toISOString() }, ...rows.slice(1)], AUTH_RULE_B), 'NOT_MATCHED');
});
for (const qualification of ['MISSING', 'AMBIGUOUS', 'PROXY_ONLY'] as const) {
  test(`A independent of ${qualification} address; B insufficient fields`, () => {
    const rows = [...failures(10), success()].map(row => ({ ...row, clientSource: { qualification, address: null } }));
    assert.equal(status(rows), 'MATCHED');
    const result = evaluateAuthenticationRules(evaluation(rows));
    assert.equal(result.rules[1]!.status, 'NOT_EVALUATED');
    assert.ok(result.rules[1]!.reasonCodes.includes('INSUFFICIENT_FIELDS'));
  });
}
for (const dimension of ['subjectRef', 'applicationRef', 'clientSource'] as const) {
  test(`B does not pool ${dimension}`, () => {
    const rows = [...failures(5, -5), success()];
    rows[0] = { ...rows[0]!, [dimension]: dimension === 'clientSource' ? { qualification: 'QUALIFIED', address: '192.0.2.11' } : 'synthetic-other' };
    assert.equal(status(rows, AUTH_RULE_B), 'NOT_MATCHED');
  });
}
test('A does not pool users or applications but may span distinct qualified addresses', () => {
  for (const dimension of ['subjectRef', 'applicationRef'] as const) {
    const rows = failures(10); rows[0] = { ...rows[0]!, [dimension]: 'synthetic-other' };
    assert.equal(status(rows), 'NOT_MATCHED');
  }
  assert.equal(status(failures(10).map((row, index) => ({ ...row, clientSource: { qualification: 'QUALIFIED', address: `192.0.2.${index + 1}` } }))), 'MATCHED');
});
test('source/tenant isolation prevents threshold pooling', () => {
  for (const overrides of [{ source: 'M365_AUDIT_STS' as const }, { organizationId: 'other-org' }, { customerTenantId: 'other-tenant' }, { microsoftTenantId: 'other-directory' }]) {
    const rows = failures(10); rows[0] = { ...rows[0]!, ...overrides };
    assert.equal(status(rows), 'NOT_EVALUATED');
    assert.equal(evaluateAuthenticationRules(evaluation(rows)).findings.length, 0);
  }
});
test('conflicting duplicates quarantine every version, deterministically', () => {
  const rows = [...failures(10), { ...failures(10)[0]!, applicationRef: 'different-app' }];
  const result = evaluateAuthenticationRules(evaluation(rows));
  assert.equal(result.findings.length, 0); assert.deepEqual(result.conflictingEventIds, ['failure-0']);
  assert.deepEqual(result, evaluateAuthenticationRules(evaluation([...rows].reverse())));
});
test('authorization and ingestion clock precede duplicate fingerprinting', () => {
  const rows = failures(10);
  const unauthorized = { ...rows[0]!, eventAt: at(-1500), applicationRef: 'different-app' };
  const future = { ...rows[0]!, ingestedAt: at(1), applicationRef: 'different-app' };
  const result = evaluateAuthenticationRules(evaluation([...rows, unauthorized, future]));
  assert.equal(result.rules[0]!.status, 'MATCHED'); assert.deepEqual(result.conflictingEventIds, []);
  assert.equal(result.findings[0]!.evidenceCount, 10);
});
test('future event and impossible ingestion clock cannot supply evidence', () => {
  const rows = failures(9);
  assert.equal(evaluateAuthenticationRules(evaluation([...rows, event('future', 1)])).findings.length, 0);
  assert.equal(evaluateAuthenticationRules(evaluation([...rows, event('invalid-clock', -1, { ingestedAt: at(-2) })])).findings.length, 0);
});
for (const readinessState of ['PARTIAL', 'UNAVAILABLE', 'STALE'] as const) {
  test(`${readinessState} blocks a clean negative but preserves an intact witness`, () => {
    const readiness = { state: readinessState, paginationComplete: false, gapCount: 1, capped: false };
    assert.equal(evaluateAuthenticationRules(evaluation([], { readiness })).rules[0]!.status, 'NOT_EVALUATED');
    assert.equal(evaluateAuthenticationRules(evaluation(failures(10), { readiness })).rules[0]!.status, 'MATCHED');
  });
}
test('unknown outcomes, pagination, caps and insufficient authorized window remain visible', () => {
  assert.equal(status([event('unknown', -1, { outcome: 'UNKNOWN', errorCode: 99999 })]), 'NOT_EVALUATED');
  for (const readiness of [
    { state: 'READY' as const, paginationComplete: false, gapCount: 0, capped: false },
    { state: 'READY' as const, paginationComplete: true, gapCount: 0, capped: true },
  ]) assert.equal(evaluateAuthenticationRules(evaluation([], { readiness })).rules[0]!.status, 'NOT_EVALUATED');
  assert.equal(evaluateAuthenticationRules(evaluation([], { authorizedFrom: at(-5) })).rules[0]!.status, 'NOT_EVALUATED');
  assert.equal(evaluateAuthenticationRules(evaluation(Array.from({ length: MAX_AUTH_EVENTS + 1 }, () => event('x', -1)))).rules[0]!.reasonCodes[0], 'INPUT_CAP_EXCEEDED');
});
test('late deliveries create historical findings with original event clocks', () => {
  const rows = [...failures(10, -70), success(-60)];
  const result = evaluateAuthenticationRules(evaluation(rows));
  assert.equal(result.findings.length, 2);
  for (const finding of result.findings) assert.ok(Date.parse(finding.expiresAt) < Date.parse(SYNTHETIC_NOW));
  const incidents = mergeAuthenticationIncidents([], result.findings, context);
  assert.ok(incidents.every(incident => incident.activity === 'HISTORICAL'));
  assert.ok(incidents.every(incident => incident.lastSeen !== SYNTHETIC_NOW));
});
test('bounded 24-hour history excludes older records and announces lookback cap', () => {
  const result = evaluateAuthenticationRules(evaluation(failures(10, -1500), { authorizedFrom: at(-1600) }));
  assert.equal(result.findings.length, 0); assert.ok(result.rules[0]!.reasonCodes.includes('LOOKBACK_CAPPED'));
});
test('independent separated historical episodes are retained', () => {
  const rows = [...failures(10, -120), ...failures(10, -10).map(row => ({ ...row, eventId: `second-${row.eventId}` }))];
  assert.equal(evaluateAuthenticationRules(evaluation(rows)).findings.filter(finding => finding.ruleId === AUTH_RULE_A).length, 2);
});
test('input order and same-time ordering are deterministic', () => {
  const rows = [...failures(10), success(), event('same-time-failure', 0)];
  assert.deepEqual(evaluateAuthenticationRules(evaluation(rows)), evaluateAuthenticationRules(evaluation([...rows].reverse())));
});
test('incidents replay idempotently, expire to historical, never remediate or sum A+B', () => {
  const findings = evaluateAuthenticationRules(evaluation([...failures(10), success()])).findings;
  const first = mergeAuthenticationIncidents([], findings, context);
  assert.deepEqual(mergeAuthenticationIncidents(first, findings, context), first);
  assert.equal(highestAuthenticationPriority(first, { ...context, subjectRef: 'synthetic-human' }), 'MEDIUM');
  const later = mergeAuthenticationIncidents(first, [], { ...context, asOf: at(20) });
  assert.equal(later.length, first.length); assert.ok(later.every(row => row.activity === 'HISTORICAL'));
  assert.deepEqual(later.map(row => row.incidentId), first.map(row => row.incidentId));
  assert.deepEqual(later.map(row => row.evidenceCount), first.map(row => row.evidenceCount));
});
test('rolling detections extend one incident without double-counting repeated evidence', () => {
  const initial = evaluateAuthenticationRules(evaluation(failures(10))).findings;
  const first = mergeAuthenticationIncidents([], initial, context);
  const next = evaluateAuthenticationRules(evaluation([...failures(10), event('additional', 0)])).findings;
  const second = mergeAuthenticationIncidents(first, next, context);
  assert.equal(second.length, 1); assert.equal(second[0]!.incidentId, first[0]!.incidentId); assert.equal(second[0]!.evidenceCount, 11);
});
test('normalization admits exact Graph 50126 and explicit zero, never MFA interruptions', () => {
  assert.equal(normalized(normalizeAuthenticationRecord(graphRecord(), normalization())).outcome, 'INVALID_CREDENTIAL');
  assert.equal(normalized(normalizeAuthenticationRecord(graphRecord({ status: { errorCode: 0 } }), normalization())).outcome, 'SUCCESS');
  assert.equal(normalized(normalizeAuthenticationRecord(graphRecord({ status: { errorCode: 50076 } }), normalization())).outcome, 'NON_QUALIFYING');
  assert.equal(normalized(normalizeAuthenticationRecord(graphRecord({ status: { errorCode: 0, failureReason: 'contradiction' } }), normalization())).outcome, 'UNKNOWN');
  assert.equal(normalized(normalizeAuthenticationRecord(graphRecord({ isInteractive: false }), normalization())).outcome, 'NON_QUALIFYING');
});
for (const code of [null, false, true, '0', '50126', [], {}, 99999]) {
  test(`Graph does not coerce unsupported code ${JSON.stringify(code)}`, () => assert.equal(normalized(normalizeAuthenticationRecord(graphRecord({ status: { errorCode: code } }), normalization())).outcome, 'UNKNOWN'));
}
test('STS supported operation plus exact code, not generic ResultStatus, qualifies', () => {
  assert.equal(normalized(normalizeAuthenticationRecord(auditRecord(), normalization('M365_AUDIT_STS'))).outcome, 'INVALID_CREDENTIAL');
  assert.equal(normalized(normalizeAuthenticationRecord(auditRecord({ Operation: 'UserLoggedIn', ErrorCode: '0' }), normalization('M365_AUDIT_STS'))).outcome, 'SUCCESS');
  assert.equal(normalized(normalizeAuthenticationRecord(auditRecord({ Operation: 'UserLoggedIn', ErrorCode: undefined }), normalization('M365_AUDIT_STS'))).outcome, 'UNKNOWN');
});
for (const overrides of [
  { Operation: 'UserLoggedIn', ErrorCode: '50126' }, { Operation: 'UserLoginFailed', ErrorCode: '0' },
  { Operation: 'UserLoggedIn', ErrorCode: '0', LogonError: 'InvalidUserNameOrPassword' },
  { Operation: 'UserLoggedIn', ErrorCode: '0', LoginStatus: 'Failed' },
  { Operation: 'UserLoggedIn', ErrorCode: '0', ResultStatus: 'Failed' },
  { ErrorCode: null }, { ErrorCode: false }, { ErrorCode: 0 }, { ErrorCode: 50126 }, { ErrorCode: '00' }, { ErrorCode: '99999' },
  { ExtendedProperties: [{ Name: 'ErrorCode', Value: '0' }] },
  { ExtendedProperties: [{ Name: 'ErrorCode', Value: '50126' }, { Name: 'ErrorNumber', Value: '0' }] },
]) test(`STS contradictory/unsupported facts ${JSON.stringify(overrides)}`, () => assert.equal(normalized(normalizeAuthenticationRecord(auditRecord(overrides), normalization('M365_AUDIT_STS'))).outcome, 'UNKNOWN'));
test('STS explicit extended-only code and agreeing duplicate code are accepted', () => {
  for (const ErrorCode of [undefined, '50126']) assert.equal(normalized(normalizeAuthenticationRecord(auditRecord({ ErrorCode,
    ExtendedProperties: [{ Name: 'ErrorNumber', Value: '50126' }, { Name: 'ErrorCode', Value: '50126' }] }), normalization('M365_AUDIT_STS'))).outcome, 'INVALID_CREDENTIAL');
});
for (const overrides of [{ RecordType: 9 }, { RecordType: '15' }, { Operation: 'Logon' }, { UserType: 4 }, { UserType: '0' }, { OrganizationId: 'other-tenant' }]) {
  test(`STS rejects unqualified profile ${JSON.stringify(overrides)}`, () => assert.equal(normalizeAuthenticationRecord(auditRecord(overrides), normalization('M365_AUDIT_STS')).status, 'REJECTED'));
}
test('resolved human and qualified exact application binding are mandatory', () => {
  const ctx = normalization();
  assert.equal(normalizeAuthenticationRecord(graphRecord(), { ...ctx, subject: { ...ctx.subject, principalClass: 'NON_HUMAN' } }).status, 'REJECTED');
  assert.equal(normalizeAuthenticationRecord(graphRecord({ userId: 'unknown' }), ctx).status, 'REJECTED');
  assert.equal(normalizeAuthenticationRecord(graphRecord(), { ...ctx, application: { ...ctx.application, qualified: false } }).status, 'REJECTED');
  assert.equal(normalizeAuthenticationRecord(graphRecord({ appId: 'other' }), ctx).status, 'REJECTED');
});
test('STS UserKey/ObjectId are not admitted as directory identity substitutes', () => {
  const ctx = normalization('M365_AUDIT_STS');
  for (const field of ['UserKey', 'ObjectId']) {
    const subject = { ...ctx.subject, sourceField: field as 'UserId' };
    const record = auditRecord({ [field]: ctx.subject.sourceUserId });
    assert.equal(normalizeAuthenticationRecord(record, { ...ctx, subject }).status, 'REJECTED');
  }
});
test('strict clocks reject malformed dates, offsets, nonzero sub-ms and impossible ingestion', () => {
  for (const createdDateTime of ['2026-02-30T12:00:00Z', '2026-09-08T16:00:00+00:00', '2026-09-08T15:59:00.0001Z', '2026-09-08', false]) {
    assert.equal(normalizeAuthenticationRecord(graphRecord({ createdDateTime }), normalization()).status, 'REJECTED');
  }
  assert.equal(normalizeAuthenticationRecord(graphRecord(), { ...normalization(), ingestedAt: at(-2) }).status, 'REJECTED');
  assert.equal(normalizeAuthenticationRecord(graphRecord({ createdDateTime: '2026-09-08T15:59:00.1230000Z' }), normalization()).status, 'ACCEPTED');
});
test('IPv6 equivalent forms canonicalize, source qualification still governs', () => {
  const row = normalized(normalizeAuthenticationRecord(graphRecord({ ipAddress: '2001:0db8:0000:0000:0000:0000:0000:0001' }), normalization()));
  assert.equal(row.clientSource.address, '2001:db8::1');
  for (const ipAddress of ['192.0.2.1:443', '2001:db8::1%eth0', 'not-an-address']) {
    assert.equal(normalized(normalizeAuthenticationRecord(graphRecord({ ipAddress }), normalization())).clientSource.qualification, 'MISSING');
  }
  const ctx = normalization('M365_AUDIT_STS');
  assert.equal(normalized(normalizeAuthenticationRecord(auditRecord({ ActorIpAddress: '192.0.2.12' }), { ...ctx, clientSource: { qualification: 'QUALIFIED', field: 'ActorIpAddress' } })).clientSource.address, '192.0.2.12');
});
test('MFA fact requires exact tenant/source/event attestation; policy fields prove nothing', () => {
  const ctx = normalization();
  assert.equal(normalized(normalizeAuthenticationRecord(graphRecord({ conditionalAccessStatus: 'success', authenticationRequirement: 'multiFactorAuthentication' }), ctx)).eventMfa.fact, 'NOT_EVIDENCED');
  const eventMfa = { ...SYNTHETIC_SCOPE, source: 'GRAPH_SIGN_INS' as const, eventId: 'synthetic-event', fact: 'SATISFIED' as const, evidenceRef: 'synthetic-event-auth-detail' };
  assert.equal(normalized(normalizeAuthenticationRecord(graphRecord(), { ...ctx, eventMfa })).eventMfa.fact, 'SATISFIED');
  assert.equal(normalized(normalizeAuthenticationRecord(graphRecord(), { ...ctx, eventMfa: { ...eventMfa, customerTenantId: 'other' } })).eventMfa.fact, 'NOT_EVIDENCED');
});
test('normalizer rejects control-bearing and oversized identifiers without logging records', () => {
  for (const id of ['bad\nidentifier', 'x'.repeat(513)]) assert.equal(normalizeAuthenticationRecord(graphRecord({ id }), normalization()).status, 'REJECTED');
});
test('historical or other-scope Medium cannot raise the current subject priority', () => {
  const historical = evaluateAuthenticationRules(evaluation([...failures(5, -65), success(-60)])).findings;
  const current = evaluateAuthenticationRules(evaluation(failures(10))).findings;
  assert.equal(highestAuthenticationPriority([...historical, ...current], { ...context, subjectRef: 'synthetic-human' }), 'LOW');
  assert.equal(highestAuthenticationPriority(current, { ...context, subjectRef: 'other-subject' }), null);
});
test('expiry equality is active; one millisecond later is historical', () => {
  const findings = evaluateAuthenticationRules(evaluation([...failures(10), success()])).findings;
  for (const finding of findings) {
    const exact = mergeAuthenticationIncidents([], [finding], { ...context, asOf: finding.expiresAt });
    assert.equal(exact[0]!.activity, 'ACTIVE');
    const after = new Date(Date.parse(finding.expiresAt) + 1).toISOString();
    assert.equal(mergeAuthenticationIncidents(exact, [], { ...context, asOf: after })[0]!.activity, 'HISTORICAL');
  }
});
test('incident merge refuses out-of-scope or future ledger state rather than leaking or erasing it', () => {
  const findings = evaluateAuthenticationRules(evaluation(failures(10))).findings;
  const prior = mergeAuthenticationIncidents([], findings, context);
  assert.throws(() => mergeAuthenticationIncidents(prior, [], { ...context, customerTenantId: 'other' }), /INCIDENT_SCOPE_MISMATCH/);
  assert.throws(() => mergeAuthenticationIncidents(prior, [], { ...context, asOf: at(-2) }), /INCIDENT_REPLAY_BOUNDARY/);
  assert.throws(() => mergeAuthenticationIncidents([], [{ ...findings[0]!, evaluatedAt: at(1) }], context), /INCIDENT_REPLAY_BOUNDARY/);
});
test('incident allocation caps are enforced before unioning evidence', () => {
  const finding = evaluateAuthenticationRules(evaluation(failures(10))).findings[0]!;
  assert.throws(() => mergeAuthenticationIncidents([], Array.from({ length: MAX_AUTH_INCIDENTS + 1 }, () => finding), context), /INCIDENT_INPUT_CAP_EXCEEDED/);
  const large = { ...finding, evidenceEventIds: Array.from({ length: MAX_AUTH_EVENTS }, (_, i) => `synthetic-${i}`), evidenceCount: MAX_AUTH_EVENTS };
  assert.throws(() => mergeAuthenticationIncidents([], Array.from({ length: 11 }, () => large), context), /INCIDENT_EVIDENCE_INPUT_CAP_EXCEEDED/);
});
test('normalized unknown codes must still have a strict bounded numeric type', () => {
  for (const errorCode of ['50126', false, {}, NaN, -1]) {
    const malformed = event('bad', -1, { outcome: 'UNKNOWN', errorCode: errorCode as number });
    const result = evaluateAuthenticationRules(evaluation([malformed]));
    assert.equal(result.admittedEventCount, 0); assert.ok(result.rules[0]!.reasonCodes.includes('MALFORMED_NORMALIZED_EVENT'));
  }
});
test('untrusted readiness strings do not flow into finding caveats', () => {
  const result = evaluateAuthenticationRules(evaluation(failures(10), { readiness: { state: 'READY', paginationComplete: true, gapCount: 0, capped: false, reasonCodes: ['untrusted public prose'] } }));
  assert.ok(result.findings[0]!.caveats.includes('SOURCE_REPORTED_GAP'));
  assert.ok(!JSON.stringify(result).includes('untrusted public prose'));
});
test('new duplicate conflict quarantines a persisted witness without false resolution', () => {
  const findings = evaluateAuthenticationRules(evaluation(failures(10))).findings;
  const prior = mergeAuthenticationIncidents([], findings, context);
  const disputed = mergeAuthenticationIncidents(prior, [], { ...context, conflictingEventIds: ['failure-0'] });
  assert.equal(disputed.length, 1); assert.equal(disputed[0]!.activity, 'UNKNOWN');
  assert.equal(disputed[0]!.incidentId, prior[0]!.incidentId); assert.deepEqual(disputed[0]!.quarantinedEventIds, ['failure-0']);
  assert.equal(disputed[0]!.evidenceCount, 9);
  assert.equal(highestAuthenticationPriority(disputed, { ...context, subjectRef: 'synthetic-human' }), null);
  assert.equal(mergeAuthenticationIncidents(disputed, [], context)[0]!.activity, 'UNKNOWN');
  const historical = mergeAuthenticationIncidents(disputed, [], { ...context, asOf: at(20) });
  assert.equal(historical[0]!.activity, 'HISTORICAL'); assert.deepEqual(historical[0]!.quarantinedEventIds, ['failure-0']);
});
test('quarantined IDs cannot silently return on replay; independent replacement restores support', () => {
  const findings = evaluateAuthenticationRules(evaluation(failures(10))).findings;
  const prior = mergeAuthenticationIncidents([], findings, context);
  const disputed = mergeAuthenticationIncidents(prior, [], { ...context, conflictingEventIds: ['failure-0'] });
  assert.equal(mergeAuthenticationIncidents(disputed, findings, context)[0]!.activity, 'UNKNOWN');
  const replacementRows = [...failures(10).filter(row => row.eventId !== 'failure-0'), event('replacement', 0)];
  const replacement = evaluateAuthenticationRules(evaluation(replacementRows)).findings;
  const supported = mergeAuthenticationIncidents(disputed, replacement, context);
  assert.equal(supported[0]!.activity, 'ACTIVE'); assert.equal(supported[0]!.incidentId, prior[0]!.incidentId);
  assert.ok(!supported[0]!.evidenceEventIds.includes('failure-0')); assert.deepEqual(supported[0]!.quarantinedEventIds, ['failure-0']);
  assert.equal(supported[0]!.evidenceCount, 10);
  assert.equal(supported[0]!.firstSeen, at(-9));
  assert.equal(supported[0]!.lastSeen, at(0));
});
test('STS tenant binding is mandatory, exact and typed', () => {
  for (const OrganizationId of [undefined, null, false, 0, {}, 'other-tenant']) {
    assert.equal(normalizeAuthenticationRecord(auditRecord({ OrganizationId }), normalization('M365_AUDIT_STS')).status, 'REJECTED');
  }
});
test('STS UserId path needs a unique tenant directory resolver attestation, not a UPN guess', () => {
  const ctx = normalization('M365_AUDIT_STS');
  const record = auditRecord({ UserId: 'Synthetic.Human@example.invalid' });
  const subject = { ...ctx.subject, sourceField: 'UserId' as const, sourceUserId: 'Synthetic.Human@example.invalid', matchedBy: 'EXACT_NORMALIZED_UPN' as const, uniqueMatch: true };
  assert.equal(normalizeAuthenticationRecord(record, { ...ctx, subject }).status, 'ACCEPTED');
  for (const changed of [{ uniqueMatch: false }, { matchedBy: undefined }, { conflictingIdentifiers: true }, { sourceUserId: 'guessed@example.invalid' }]) {
    assert.equal(normalizeAuthenticationRecord(record, { ...ctx, subject: { ...subject, ...changed } }).status, 'REJECTED');
  }
});
test('replacing a quarantined success derives boundaries and MFA only from supported evidence', () => {
  const originalSuccess = { ...success(), eventMfa: { fact: 'SATISFIED' as const, evidenceRef: 'synthetic-mfa-evidence' } };
  const findings = evaluateAuthenticationRules(evaluation([...failures(5, -5), originalSuccess])).findings;
  const prior = mergeAuthenticationIncidents([], findings, context);
  const disputed = mergeAuthenticationIncidents(prior, [], { ...context, conflictingEventIds: ['success'] });
  const newSuccess = event('replacement-success', -0.5, { outcome: 'SUCCESS', errorCode: 0 });
  const replacement = evaluateAuthenticationRules(evaluation([...failures(5, -5), newSuccess])).findings;
  const restored = mergeAuthenticationIncidents(disputed, replacement, context)[0]!;
  assert.equal(restored.activity, 'ACTIVE'); assert.equal(restored.incidentId, prior[0]!.incidentId);
  assert.equal(restored.lastSeen, at(-0.5)); assert.equal(restored.expiresAt, at(9.5));
  assert.equal(restored.eventMfa.fact, 'NOT_EVIDENCED'); assert.ok(!restored.evidenceEventIds.includes('success'));
});
