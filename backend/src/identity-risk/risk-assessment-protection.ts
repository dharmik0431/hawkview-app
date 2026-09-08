import { evaluateEffectiveMfaEnforcement, type EffectiveMfaEvaluationInput, type MfaEvidenceState } from '../tenants/effective-mfa-enforcement.js';
import type { RiskProtectionDto, RiskProtectionEvidence } from './identity-risk-assessment.contract.js';
import { unknownRiskProtection } from './risk-assessment-projection.js';

const MAX_AGE = 26 * 60 * 60000;
const MAX_POLICIES = 100;
const MAX_STRENGTHS = 100;
const MAX_MEMBERSHIPS = 1000;
const EVIDENCE_STATES = new Set(['FRESH', 'STALE', 'MISSING', 'FAILED', 'PERMISSION_LIMITED']);
const MATERIAL_CONDITIONS = new Set(['application subset', 'application exclusions', 'user actions', 'authentication context', 'platform', 'location', 'client app', 'device state', 'sign-in risk', 'user risk', 'service-principal risk', 'authentication flow', 'effective exclusion']);
const REASONS = new Set(['EXTERNAL_TENANT_UNKNOWN', 'EFFECTIVE_EXCLUSION', 'NOT_TARGETED', 'AUTHENTICATION_STRENGTH_NOT_RESOLVED', 'AUTHENTICATION_STRENGTH_AMBIGUOUS', 'TARGET_EVALUATION_UNKNOWN', 'GRANT_EVALUATION_UNKNOWN', 'POLICY_SHAPE_UNKNOWN', 'MATERIAL_CONDITIONS_PRESENT', 'REPORT_ONLY_NOT_ENFORCED', 'NO_UNIVERSAL_MFA_POLICY']);
const EXPLANATION = 'Conditional Access, security defaults, legacy per-user MFA and registration are separate protection facts. Registration does not prove enforcement, and current protection does not prove that a historical sign-in used MFA. Protection does not reduce finding priority.';
type Extra = {
  registration: { isMfaRegistered?: unknown; perUserMfaState?: unknown } | null;
  registrationEvidence: MfaEvidenceState;
  securityDefaults: { isEnabled?: unknown } | null;
  securityDefaultsEvidence: MfaEvidenceState;
};
class CapacityError extends Error {}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function own(value: unknown, key: string): unknown {
  if (!plain(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function safeString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value);
}
function observed(value: unknown, now: number): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return new Date(time).toISOString();
}
function evidence(value: unknown, now: number): MfaEvidenceState {
  const status = own(value, 'status');
  const stamp = observed(own(value, 'observedAt'), now);
  if (typeof status !== 'string' || !EVIDENCE_STATES.has(status) || status === 'MISSING') return { status: 'MISSING', observedAt: null, reason: null };
  if (status === 'FAILED' || status === 'PERMISSION_LIMITED') return { status, observedAt: stamp, reason: null };
  if (stamp === null) return { status: 'MISSING', observedAt: null, reason: null };
  return { status: status === 'STALE' || now - Date.parse(stamp) > MAX_AGE ? 'STALE' : 'FRESH', observedAt: stamp, reason: null };
}
function fact<State extends string>(state: State | undefined, source: MfaEvidenceState): RiskProtectionEvidence<State> {
  return {
    state: source.status === 'FRESH' && state !== undefined ? state : 'UNKNOWN',
    source: source.observedAt === null ? 'NOT_REPORTED' : 'MICROSOFT_GRAPH', observedAt: source.observedAt,
    freshness: source.status === 'FRESH' ? 'CURRENT' : source.status === 'STALE' ? 'STALE' : 'UNKNOWN',
    reasonCode: source.status === 'FRESH' ? state === undefined ? 'NOT_REPORTED' : 'VERIFIED'
      : source.status === 'STALE' ? 'STALE' : source.status === 'FAILED' ? 'FAILED' : source.status === 'PERMISSION_LIMITED' ? 'MISSING_PERMISSION' : 'NOT_REPORTED',
  };
}
/** Reject oversized trees; never truncate selectors or grants before evaluation. */
function boundedTree(value: unknown, budget = { nodes: 0, characters: 0 }, depth = 0): boolean {
  if (++budget.nodes > 20000 || depth > 10) throw new CapacityError();
  if (value === null || value === undefined || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    budget.characters += value.length;
    if (value.length > 512 || budget.characters > 200000) throw new CapacityError();
    return !/[\p{Cc}\p{Cf}]/u.test(value);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_MEMBERSHIPS) throw new CapacityError();
    return value.every(item => boundedTree(item, budget, depth + 1));
  }
  if (!plain(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64) throw new CapacityError();
  return keys.every(key => {
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return 'value' in descriptor && boundedTree(descriptor.value, budget, depth + 1);
  });
}
function identifiers(value: unknown): boolean {
  if (value === null) return true;
  if (!Array.isArray(value)) return false;
  if (value.length > MAX_MEMBERSHIPS) throw new CapacityError();
  return value.every(id => safeString(id, 128));
}

export function projectAssessmentProtection(caInput: EffectiveMfaEvaluationInput, extra: Extra): RiskProtectionDto {
  const output: { -readonly [Key in keyof RiskProtectionDto]: RiskProtectionDto[Key] } = unknownRiskProtection();
  output.explanation = EXPLANATION;
  try {
    const clock = caInput.now ?? new Date();
    if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) return output;
    const now = clock.getTime();
    const registrationEvidence = evidence(own(extra, 'registrationEvidence'), now);
    const securityEvidence = evidence(own(extra, 'securityDefaultsEvidence'), now);
    const registration = own(extra, 'registration');
    const registered = own(registration, 'isMfaRegistered');
    const legacy = own(registration, 'perUserMfaState');
    const defaults = own(own(extra, 'securityDefaults'), 'isEnabled');
    output.registration = fact(registered === true ? 'REGISTERED' : registered === false ? 'NOT_REGISTERED' : undefined, registrationEvidence);
    output.legacyPerUserMfa = fact(legacy === 'disabled' ? 'DISABLED' : legacy === 'enabled' ? 'ENABLED' : legacy === 'enforced' ? 'ENFORCED' : undefined, registrationEvidence);
    output.securityDefaults = fact(defaults === true ? 'ENABLED' : defaults === false ? 'DISABLED' : undefined, securityEvidence);

    try {
      const subject = caInput.subject;
      if (!subject || !safeString(subject.id, 128) || !['Member', 'Guest', 'Unknown'].includes(subject.userType)
        || (subject.externalTenantId !== undefined && subject.externalTenantId !== null && !safeString(subject.externalTenantId, 128))
        || !identifiers(subject.transitiveGroupIds) || !identifiers(subject.activeRoleTemplateIds)) throw new TypeError();
      if (Array.isArray(caInput.policies) && caInput.policies.length > MAX_POLICIES) throw new CapacityError();
      if (Array.isArray(caInput.authenticationStrengths) && caInput.authenticationStrengths.length > MAX_STRENGTHS) throw new CapacityError();
      if (!Array.isArray(caInput.policies) || !boundedTree(caInput.policies) || !boundedTree(caInput.authenticationStrengths)) throw new TypeError();
      const authorizedNames = new Map<string, string>();
      for (const policy of caInput.policies) {
        const id = own(policy, 'id'); const name = own(policy, 'displayName'); const state = own(policy, 'state');
        if (!safeString(id, 128) || !safeString(name, 256) || !['enabled', 'disabled', 'enabledForReportingButNotEnforced'].includes(state as string) || authorizedNames.has(id)) throw new TypeError();
        authorizedNames.set(id, name);
      }
      const normalizedEvidence: EffectiveMfaEvaluationInput['evidence'] = {
        policies: evidence(own(caInput.evidence, 'policies'), now), membership: evidence(own(caInput.evidence, 'membership'), now),
        roles: evidence(own(caInput.evidence, 'roles'), now), authenticationStrengths: evidence(own(caInput.evidence, 'authenticationStrengths'), now),
      };
      const projected = evaluateEffectiveMfaEnforcement({ ...caInput, evidence: normalizedEvidence, now: clock });
      if (projected.policies.length > MAX_POLICIES || projected.policies.some(policy => authorizedNames.get(policy.id) !== policy.name
        || policy.materialConditions.length > 16 || !policy.materialConditions.every(condition => MATERIAL_CONDITIONS.has(condition)))) throw new TypeError();
      const policyEvidence = normalizedEvidence.policies;
      const stale = policyEvidence.status === 'STALE' || (projected.status === 'UNKNOWN' && projected.reasonCodes.some(reason => reason.endsWith('_STALE')));
      output.conditionalAccess = {
        contractVersion: 1, status: projected.status, policies: projected.policies.map(policy => ({ ...policy, materialConditions: [...policy.materialConditions] })),
        source: 'EFFECTIVE_MFA_V1', freshness: stale ? 'STALE' : policyEvidence.status === 'FRESH' && projected.status !== 'UNKNOWN' ? 'CURRENT' : 'UNKNOWN',
        observedAt: policyEvidence.observedAt, evaluatedAt: clock.toISOString(),
        reasonCodes: [...new Set(projected.reasonCodes.map(reason => REASONS.has(reason) || /^(POLICIES|MEMBERSHIP|ROLES|AUTHENTICATION_STRENGTHS)_(FRESH|STALE|MISSING|FAILED|PERMISSION_LIMITED)$/.test(reason) ? reason : 'EVIDENCE_INCOMPLETE'))].slice(0, 32),
      };
    } catch (error) {
      output.conditionalAccess = { ...unknownRiskProtection().conditionalAccess, evaluatedAt: clock.toISOString(), reasonCodes: [error instanceof CapacityError ? 'CAPACITY_LIMIT' : 'INVALID_PROTECTION_INPUT'] };
    }
    return output;
  } catch {
    return { ...unknownRiskProtection(), explanation: EXPLANATION };
  }
}
