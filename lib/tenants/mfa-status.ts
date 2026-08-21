export type MfaRegistrationState =
  | 'Registered'
  | 'Not registered'
  | 'Unknown'

export type PerUserMfaState =
  | 'Enabled'
  | 'Enforced'
  | 'Disabled'
  | 'Unknown'

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
