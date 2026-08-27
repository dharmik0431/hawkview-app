export type MfaRegistrationState =
  | 'Registered'
  | 'Not registered'
  | 'Unknown'

export type PerUserMfaState =
  | 'Enabled'
  | 'Enforced'
  | 'Disabled'
  | 'Unknown'

export type MfaBadgeTone = 'positive' | 'caution' | 'info' | 'neutral'

export type MfaBadgePresentation = {
  label: string
  tone: MfaBadgeTone
}

export type EffectiveMfaPolicy = {
  id: string
  name: string
  state: 'ENABLED' | 'REPORT_ONLY' | 'DISABLED'
  outcome: 'UNIVERSAL' | 'CONDITIONAL' | 'NOT_ENFORCED'
  materialConditions: string[]
}

export type EffectiveMfaEnforcement = {
  contractVersion: 1
  status:
    | 'COVERED_BY_CONDITIONAL_ACCESS'
    | 'CONDITIONALLY_COVERED'
    | 'REPORT_ONLY'
    | 'NOT_COVERED'
    | 'UNKNOWN'
  label: string
  policies: EffectiveMfaPolicy[]
  evidenceObservedAt: string | null
  riskReductionAllowed: boolean
}

type RecordLike = Record<string, unknown>

function plainRecord(value: unknown): value is RecordLike {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function own(record: RecordLike, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined
}

function safeText(value: unknown, fallback: string, maxLength = 512) {
  return typeof value === 'string' && value.trim()
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength)
    : fallback
}

export function tenantUserEffectiveMfaEnforcement(
  value: unknown,
): EffectiveMfaEnforcement | null {
  if (!plainRecord(value)) return null
  const raw = own(value, 'effectiveMfaEnforcement')
  if (!plainRecord(raw) || own(raw, 'contractVersion') !== 1) return null
  const status = own(raw, 'status')
  if (
    status !== 'COVERED_BY_CONDITIONAL_ACCESS' &&
    status !== 'CONDITIONALLY_COVERED' &&
    status !== 'REPORT_ONLY' &&
    status !== 'NOT_COVERED' &&
    status !== 'UNKNOWN'
  ) return null
  const policies = Array.isArray(own(raw, 'policies'))
    ? (own(raw, 'policies') as unknown[]).flatMap((candidate) => {
        if (!plainRecord(candidate)) return []
        const state = own(candidate, 'state')
        const outcome = own(candidate, 'outcome')
        if (
          (state !== 'ENABLED' && state !== 'REPORT_ONLY' && state !== 'DISABLED') ||
          (outcome !== 'UNIVERSAL' && outcome !== 'CONDITIONAL' && outcome !== 'NOT_ENFORCED')
        ) return []
        const parsedState: EffectiveMfaPolicy['state'] = state
        const parsedOutcome: EffectiveMfaPolicy['outcome'] = outcome
        return [{
          id: safeText(own(candidate, 'id'), 'Unknown policy ID', 128),
          name: safeText(own(candidate, 'name'), 'Unnamed policy', 256),
          state: parsedState,
          outcome: parsedOutcome,
          materialConditions: Array.isArray(own(candidate, 'materialConditions'))
            ? (own(candidate, 'materialConditions') as unknown[])
                .filter((item): item is string => typeof item === 'string')
                .map((item) => safeText(item, '', 128))
                .filter(Boolean)
            : [],
        }]
      })
    : []
  return {
    contractVersion: 1,
    status,
    label: safeText(own(raw, 'label'), 'MFA enforcement unknown'),
    policies,
    evidenceObservedAt:
      typeof own(raw, 'evidenceObservedAt') === 'string'
        ? safeText(own(raw, 'evidenceObservedAt'), '', 64) || null
        : null,
    riskReductionAllowed: own(raw, 'riskReductionAllowed') === true,
  }
}

export function effectiveMfaEnforcementPresentation(
  value: unknown,
): MfaBadgePresentation {
  const fact = tenantUserEffectiveMfaEnforcement(value)
  if (!fact) return { label: 'Coverage unknown', tone: 'neutral' }
  if (fact.status === 'COVERED_BY_CONDITIONAL_ACCESS') {
    return { label: fact.label, tone: 'positive' }
  }
  if (fact.status === 'CONDITIONALLY_COVERED') {
    return { label: fact.label, tone: 'caution' }
  }
  if (fact.status === 'REPORT_ONLY') return { label: fact.label, tone: 'info' }
  if (fact.status === 'NOT_COVERED') return { label: fact.label, tone: 'caution' }
  return { label: fact.label, tone: 'neutral' }
}

export function compactEffectiveMfaEnforcementPresentation(
  value: unknown,
): MfaBadgePresentation {
  const fact = tenantUserEffectiveMfaEnforcement(value)
  if (!fact) return { label: 'Coverage unknown', tone: 'neutral' }
  if (fact.status === 'COVERED_BY_CONDITIONAL_ACCESS') {
    return { label: 'Covered by CA', tone: 'positive' }
  }
  if (fact.status === 'CONDITIONALLY_COVERED') {
    return { label: 'Conditionally covered', tone: 'caution' }
  }
  if (fact.status === 'REPORT_ONLY') {
    return { label: 'Report-only', tone: 'info' }
  }
  if (fact.status === 'NOT_COVERED') {
    return { label: 'Not covered', tone: 'caution' }
  }
  return { label: 'Coverage unknown', tone: 'neutral' }
}

export function tenantUserMfaRegistration(value: unknown): MfaRegistrationState {
  if (!plainRecord(value)) return 'Unknown'
  const explicit = own(value, 'mfaRegistration')
  if (explicit === 'Registered' || explicit === 'Not registered') return explicit
  if (explicit === 'Unknown') return explicit

  // Older bundles used Enabled/Disabled for the registration fact. Preserve
  // compatibility while correcting the user-facing meaning.
  const legacy = own(value, 'mfa')
  if (legacy === 'Enabled' || legacy === 'Enforced') return 'Registered'
  if (legacy === 'Disabled') return 'Not registered'
  return 'Unknown'
}

export function tenantUserPerUserMfaState(value: unknown): PerUserMfaState {
  if (!plainRecord(value)) return 'Unknown'
  const state = own(value, 'perUserMfaState')
  return state === 'Enabled' || state === 'Enforced' || state === 'Disabled'
    ? state
    : 'Unknown'
}

export function mfaRegistrationPresentation(
  value: unknown,
): MfaBadgePresentation {
  const state = tenantUserMfaRegistration(value)
  if (state === 'Registered') return { label: state, tone: 'positive' }
  if (state === 'Not registered') return { label: state, tone: 'caution' }
  return { label: 'Not reported', tone: 'neutral' }
}

export function perUserMfaPresentation(
  value: unknown,
): MfaBadgePresentation {
  const state = tenantUserPerUserMfaState(value)
  if (state === 'Enforced') return { label: state, tone: 'positive' }
  if (state === 'Enabled') return { label: state, tone: 'info' }
  if (state === 'Disabled') return { label: state, tone: 'neutral' }
  return { label: 'Not reported', tone: 'neutral' }
}
