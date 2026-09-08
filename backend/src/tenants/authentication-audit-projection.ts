/** Bounded storage projection, not an authentication detector. Never infer success
 * from ResultStatus or invent a human/application binding during collection. */
const FIELDS = new Set([
  'RecordType', 'Operation', 'LoginStatus', 'ErrorCode', 'ResultStatus', 'Id',
  'CreationTime', 'UserId', 'ObjectId', 'UserKey', 'UserType', 'OrganizationId',
  'ActorContextId', 'ApplicationId', 'ActorIpAddress', 'ClientIP', 'UserDisplayName',
  'Country', 'CountryOrRegion', 'City', 'Application', 'Workload',
])
const CODES = /^(?:AccountLocked|InvalidUserNameOrPassword|InvalidPassword|UserAccountNotFound|UserAccountDisabled|UserNotFound|PasswordExpired|InvalidGrant|MfaRequired|MFARequired|StrongAuthenticationRequired|InteractionRequired|ConditionalAccessBlocked|[0-9]{1,12})$/
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))
function scalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)) return value
  return null
}
function diagnostic(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return typeof value === 'string' && value.length <= 64 && CODES.test(value)
    ? value : 'UnclassifiedAuthenticationError'
}
export function projectAuthenticationAuditRecord(value: unknown): Record<string, unknown> {
  if (!plain(value)) throw new Error('Microsoft returned an invalid bounded authentication record.')
  const row: Record<string, unknown> = {}
  for (const key of FIELDS) if (own(value, key)) row[key] = scalar(value[key])
  if (own(value, 'LogonError')) row.LogonError = diagnostic(value.LogonError)
  if (own(value, 'ExtendedProperties')) {
    if (!Array.isArray(value.ExtendedProperties) || value.ExtendedProperties.length > 64) {
      row.LogonError = 'UnclassifiedAuthenticationError'
    } else {
      row.ExtendedProperties = value.ExtendedProperties.flatMap(item => {
        if (!plain(item) || !own(item, 'Name') || !own(item, 'Value') || typeof item.Name !== 'string') return []
        const name = item.Name.toLowerCase()
        if (name === 'loginstatus' || name === 'errorcode') return [{ Name: item.Name, Value: scalar(item.Value) }]
        if (name === 'loginerror' || name === 'logonerror') return [{ Name: item.Name, Value: diagnostic(item.Value) }]
        return []
      })
    }
  }
  if (own(value, 'Actor')) {
    row.Actor = Array.isArray(value.Actor) && value.Actor.length <= 16
      ? value.Actor.filter(plain).map(actor => ({
        ID: own(actor, 'ID') ? scalar(actor.ID) : null,
        Type: own(actor, 'Type') ? scalar(actor.Type) : null,
      })) : []
  }
  return row
}

/** Validate applicable login envelopes BEFORE filtering/projecting a mixed
 * audit page. A malformed login candidate is a collection gap, not no activity. */
export function projectAuthenticationAuditPageRow(value: unknown): Record<string, unknown> {
  const projected = projectAuthenticationAuditRecord(value)
  const raw = value as Record<string, unknown>
  const applicable = raw.RecordType === 15 || raw.RecordType === '15' ||
    ['UserLoggedIn','UserLoginFailed'].includes(raw.Operation as string)
  if (applicable && (typeof projected.Id !== 'string' || !projected.Id ||
    typeof projected.CreationTime !== 'string' || !Number.isFinite(Date.parse(projected.CreationTime))))
    throw new Error('IDENTITY_AUTH_APPLICABLE_RECORD_INVALID')
  return projected
}

/** Display projection only. The strict rule normalizer independently validates
 * operation, all conflicting error fields and source identity before detection. */
export function reportedAuthenticationErrorCode(row: Record<string, unknown>): number | null {
  const values: unknown[] = []
  for (const key of ['LoginStatus', 'ErrorCode']) if (own(row, key)) values.push(row[key])
  if (Array.isArray(row.ExtendedProperties)) for (const item of row.ExtendedProperties) {
    if (plain(item) && typeof item.Name === 'string' && ['loginstatus', 'errorcode'].includes(item.Name.toLowerCase())) values.push(item.Value)
  }
  if (!values.length) return null
  const parsed = values.map(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value
    : typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : null)
  if (parsed.some(value => value === null || value !== parsed[0])) return null
  if (parsed[0] === 0 && (row.Operation !== 'UserLoggedIn' || row.LogonError ||
    (Array.isArray(row.ExtendedProperties) && row.ExtendedProperties.some(item => plain(item) &&
      typeof item.Name === 'string' && ['loginerror', 'logonerror'].includes(item.Name.toLowerCase()) && item.Value)))) return null
  return parsed[0] ?? null
}
