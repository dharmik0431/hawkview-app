import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateEffectiveMfaEnforcement, type EffectiveMfaEvaluationInput, type MfaEvidenceState } from '../tenants/effective-mfa-enforcement.js';
import { projectAssessmentProtection } from './risk-assessment-protection.js';

const NOW = new Date('2026-09-08T21:00:00.000Z');
const at = (hours: number): string => new Date(NOW.getTime() + hours * 3600000).toISOString();
const fresh = (observedAt: string | null = at(0)): MfaEvidenceState => ({ status: 'FRESH', observedAt, reason: null });
const policy = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'synthetic-policy', displayName: 'Require MFA for all users', state: 'enabled',
  conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] } }, grantControls: { operator: 'OR', builtInControls: ['mfa'] }, ...overrides });
const input = (overrides: Partial<EffectiveMfaEvaluationInput> = {}): EffectiveMfaEvaluationInput => ({
  subject: { id: 'synthetic-subject', userType: 'Member', transitiveGroupIds: [], activeRoleTemplateIds: [] }, policies: [policy()], authenticationStrengths: [],
  evidence: { policies: fresh(), membership: fresh(), roles: fresh(), authenticationStrengths: fresh() }, now: NOW, ...overrides,
});
const extra = (): Parameters<typeof projectAssessmentProtection>[1] => ({ registration: { isMfaRegistered: true, perUserMfaState: 'enforced' }, registrationEvidence: fresh(), securityDefaults: { isEnabled: true }, securityDefaultsEvidence: fresh() });

test('uses the existing evaluator and projects separate current source-backed facts without risk reduction', () => {
  const ca = input(); const output = projectAssessmentProtection(ca, extra());
  assert.equal(output.conditionalAccess.status, evaluateEffectiveMfaEnforcement(ca).status);
  assert.equal(output.conditionalAccess.status, 'COVERED_BY_CONDITIONAL_ACCESS'); assert.equal(output.conditionalAccess.freshness, 'CURRENT');
  assert.deepEqual(output.conditionalAccess.policies.map(item => item.name), ['Require MFA for all users']);
  assert.equal(output.registration.state, 'REGISTERED'); assert.equal(output.legacyPerUserMfa.state, 'ENFORCED'); assert.equal(output.securityDefaults.state, 'ENABLED');
  assert.equal(output.registration.source, 'MICROSOFT_GRAPH'); assert.equal(output.registration.observedAt, at(0));
  assert.ok(!('riskReductionAllowed' in output.conditionalAccess)); assert.ok(output.explanation.includes('does not reduce finding priority'));
});
for (const changed of [
  { state: 'disabled' }, { state: 'enabledForReportingButNotEnforced' },
  { conditions: { users: { includeUsers: ['All'], excludeUsers: ['synthetic-subject'] }, applications: { includeApplications: ['All'] } } },
  { conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: ['specific-app'] } } },
  { grantControls: { operator: 'OR', builtInControls: ['mfa', 'compliantDevice'] } },
]) test(`preserves existing CA semantics ${JSON.stringify(changed)}`, () => {
  const ca = input({ policies: [policy(changed)] });
  assert.equal(projectAssessmentProtection(ca, extra()).conditionalAccess.status, evaluateEffectiveMfaEnforcement(ca).status);
});
for (const stamp of [null, 'not-a-date', '2026-02-30T12:00:00Z', at(1), at(-27)]) {
  test(`purported fresh evidence cannot prove protection at invalid/old observation ${stamp}`, () => {
    const ca = input(); ca.evidence.policies = fresh(stamp);
    const other = extra(); other.registrationEvidence = fresh(stamp); other.securityDefaultsEvidence = fresh(stamp);
    const output = projectAssessmentProtection(ca, other);
    assert.equal(output.conditionalAccess.status, 'UNKNOWN'); assert.notEqual(output.conditionalAccess.freshness, 'CURRENT');
    assert.equal(output.registration.state, 'UNKNOWN'); assert.equal(output.legacyPerUserMfa.state, 'UNKNOWN'); assert.equal(output.securityDefaults.state, 'UNKNOWN');
    assert.notEqual(output.registration.freshness, 'CURRENT');
  });
}
test('26-hour freshness boundary is inclusive, one millisecond later is stale', () => {
  const ca = input(); ca.evidence.policies = fresh(at(-26));
  assert.equal(projectAssessmentProtection(ca, extra()).conditionalAccess.status, 'COVERED_BY_CONDITIONAL_ACCESS');
  ca.evidence.policies = fresh(new Date(Date.parse(at(-26)) - 1).toISOString());
  assert.equal(projectAssessmentProtection(ca, extra()).conditionalAccess.freshness, 'STALE');
});
for (const dimension of ['membership', 'roles'] as const) test(`stale ${dimension} evidence cannot decide a required selector`, () => {
  const ca = input(); ca.evidence[dimension] = fresh(at(-27));
  ca.subject.transitiveGroupIds = ['synthetic-group']; ca.subject.activeRoleTemplateIds = ['synthetic-role'];
  ca.policies = [policy({ conditions: { users: dimension === 'membership' ? { includeGroups: ['synthetic-group'] } : { includeRoles: ['synthetic-role'] }, applications: { includeApplications: ['All'] } } })];
  assert.equal(projectAssessmentProtection(ca, extra()).conditionalAccess.status, 'UNKNOWN');
  assert.equal(projectAssessmentProtection(ca, extra()).conditionalAccess.freshness, 'STALE');
});
test('irrelevant stale membership does not replace existing universal-policy logic', () => {
  const ca = input(); ca.evidence.membership = fresh(at(-27));
  assert.equal(projectAssessmentProtection(ca, extra()).conditionalAccess.status, 'COVERED_BY_CONDITIONAL_ACCESS');
});
test('authentication-strength proof requires its own valid observation', () => {
  const id = '00000000-0000-0000-0000-000000000002';
  const ca = input({ policies: [policy({ grantControls: { operator: 'OR', builtInControls: [], authenticationStrength: { id } } })], authenticationStrengths: [{ id }] });
  assert.equal(projectAssessmentProtection(ca, extra()).conditionalAccess.status, 'COVERED_BY_CONDITIONAL_ACCESS');
  ca.evidence.authenticationStrengths = fresh(null);
  assert.equal(projectAssessmentProtection(ca, extra()).conditionalAccess.status, 'UNKNOWN');
});
for (const value of ['true', 'false', 1, 0, null, {}, []]) test(`registration/security-defaults never coerce ${JSON.stringify(value)}`, () => {
  const other = extra(); other.registration = { isMfaRegistered: value }; other.securityDefaults = { isEnabled: value };
  const output = projectAssessmentProtection(input(), other);
  assert.equal(output.registration.state, 'UNKNOWN'); assert.equal(output.securityDefaults.state, 'UNKNOWN');
});
test('exact false states are verified negatives, not missing evidence', () => {
  const other = extra(); other.registration = { isMfaRegistered: false, perUserMfaState: 'disabled' }; other.securityDefaults = { isEnabled: false };
  const output = projectAssessmentProtection(input(), other);
  assert.equal(output.registration.state, 'NOT_REGISTERED'); assert.equal(output.legacyPerUserMfa.state, 'DISABLED'); assert.equal(output.securityDefaults.state, 'DISABLED');
  assert.equal(output.registration.reasonCode, 'VERIFIED');
});
for (const value of ['enabled', 'enforced', 'disabled', 'ENFORCED', 'Enabled', true, 1, undefined]) test(`legacy MFA uses only documented exact enums ${String(value)}`, () => {
  const other = extra(); other.registration = { perUserMfaState: value };
  const state = projectAssessmentProtection(input(), other).legacyPerUserMfa.state;
  assert.equal(state, value === 'enabled' ? 'ENABLED' : value === 'enforced' ? 'ENFORCED' : value === 'disabled' ? 'DISABLED' : 'UNKNOWN');
});
for (const state of ['FAILED', 'PERMISSION_LIMITED', 'MISSING', 'STALE'] as const) test(`non-current registration evidence ${state} never proves positive state`, () => {
  const other = extra(); other.registrationEvidence = { status: state, observedAt: at(0), reason: 'private-provider-error' };
  const output = projectAssessmentProtection(input(), other);
  assert.equal(output.registration.state, 'UNKNOWN'); assert.equal(output.legacyPerUserMfa.state, 'UNKNOWN');
  assert.equal(output.conditionalAccess.status, 'COVERED_BY_CONDITIONAL_ACCESS'); assert.equal(output.securityDefaults.state, 'ENABLED');
  assert.ok(!JSON.stringify(output).includes('private-provider-error'));
});
test('malformed CA input does not erase independent valid registration/default facts', () => {
  const output = projectAssessmentProtection(input({ policies: 'provider-error' }), extra());
  assert.equal(output.conditionalAccess.status, 'UNKNOWN'); assert.equal(output.registration.state, 'REGISTERED'); assert.equal(output.securityDefaults.state, 'ENABLED');
  assert.ok(!JSON.stringify(output).includes('provider-error'));
});
for (const dimension of ['policies', 'strengths', 'groups', 'roles'] as const) test(`${dimension} cap fails closed instead of truncating exclusions`, () => {
  const ca = input();
  if (dimension === 'policies') ca.policies = Array.from({ length: 101 }, (_, i) => policy({ id: `policy-${i}` }));
  if (dimension === 'strengths') ca.authenticationStrengths = Array.from({ length: 101 }, (_, i) => ({ id: `strength-${i}` }));
  if (dimension === 'groups') ca.subject.transitiveGroupIds = Array.from({ length: 1001 }, (_, i) => `group-${i}`);
  if (dimension === 'roles') ca.subject.activeRoleTemplateIds = Array.from({ length: 1001 }, (_, i) => `role-${i}`);
  const output = projectAssessmentProtection(ca, extra());
  assert.equal(output.conditionalAccess.status, 'UNKNOWN'); assert.deepEqual(output.conditionalAccess.reasonCodes, ['CAPACITY_LIMIT']);
});
test('provider details are discarded; authorized bounded names and code-owned conditions remain', () => {
  const ca = input({ policies: [policy({ diagnostic: 'private-provider-error', conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: ['specific-app'] } } })] });
  ca.evidence.policies.reason = 'private-provider-error';
  const output = projectAssessmentProtection(ca, extra());
  assert.deepEqual(output.conditionalAccess.policies[0]!.materialConditions, ['application subset']); assert.ok(!JSON.stringify(output).includes('private-provider-error'));
});
test('control-bearing or oversized policy names cannot reach output', () => {
  for (const displayName of ['unsafe\u202ename', 'bad\nname', 'x'.repeat(257)]) {
    const output = projectAssessmentProtection(input({ policies: [policy({ displayName })] }), extra());
    assert.equal(output.conditionalAccess.status, 'UNKNOWN'); assert.equal(output.conditionalAccess.policies.length, 0);
  }
});
test('invalid dates, cyclic data and accessors are caught without leaking errors', () => {
  assert.equal(projectAssessmentProtection(input({ now: new Date('invalid') }), extra()).registration.state, 'UNKNOWN');
  const cyclic = policy(); cyclic.self = cyclic;
  assert.equal(projectAssessmentProtection(input({ policies: [cyclic] }), extra()).conditionalAccess.status, 'UNKNOWN');
  const accessor = policy(); Object.defineProperty(accessor, 'private', { enumerable: true, get() { throw new Error('do-not-expose'); } });
  const output = projectAssessmentProtection(input({ policies: [accessor] }), extra());
  assert.equal(output.conditionalAccess.status, 'UNKNOWN'); assert.ok(!JSON.stringify(output).includes('do-not-expose'));
});
test('projections do not mutate caller evidence or policy arrays', () => {
  const ca = input(); const other = extra(); const before = JSON.stringify([ca, other]);
  projectAssessmentProtection(ca, other); assert.equal(JSON.stringify([ca, other]), before);
});
