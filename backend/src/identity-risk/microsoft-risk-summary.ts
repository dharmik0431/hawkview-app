import type { MicrosoftRiskDetail, MicrosoftRiskLevel, MicrosoftRiskState } from './identity-risk.contract.js'

export const MICROSOFT_RISK_MAX_ROWS = 50_000
const MAX_AGE_MS = 36 * 60 * 60 * 1_000
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000
export type MicrosoftRiskSummaryReason = 'SOURCE_UNAVAILABLE' | 'COLLECTION_NOT_SUCCEEDED' | 'INVALID_CLOCK' | 'STALE_EVIDENCE' | 'INVALID_SNAPSHOT' | 'PARTIAL_RECORDS' | 'CONFLICTING_RECORDS'
type SummaryBase = Readonly<{
  source: 'MICROSOFT_IDENTITY_PROTECTION'
  snapshotObservedAt: string | null
  collectionSucceededAt: string | null
}>
export type MicrosoftRiskSummary = SummaryBase & (
  | Readonly<{ availability: 'AVAILABLE'; completeness: 'COMPLETE'; rawRecordCount: number; observedActiveDistinctUserCount: number; activeDistinctUserCount: number; reasonCode: null }>
  | Readonly<{ availability: 'PARTIAL'; completeness: 'PARTIAL' | 'CONFLICTING' | 'UNKNOWN'; rawRecordCount: number; observedActiveDistinctUserCount: number; activeDistinctUserCount: null; reasonCode: 'PARTIAL_RECORDS' | 'CONFLICTING_RECORDS' }>
  | Readonly<{ availability: 'UNAVAILABLE'; completeness: 'UNKNOWN'; rawRecordCount: null; observedActiveDistinctUserCount: null; activeDistinctUserCount: null; reasonCode: MicrosoftRiskSummaryReason }>
)

const levels = new Set(['none', 'low', 'medium', 'high', 'hidden', 'unknownFutureValue'])
const states = new Set(['none', 'atRisk', 'remediated', 'dismissed', 'confirmedSafe', 'confirmedCompromised', 'unknownFutureValue'])
const details = new Set(['none', 'adminGeneratedTemporaryPassword', 'userPerformedSecuredPasswordChange', 'userPerformedSecuredPasswordReset', 'adminConfirmedSigninSafe', 'aiConfirmedSigninSafe', 'userPassedMFADrivenByRiskBasedPolicy', 'adminDismissedAllRiskForUser', 'adminConfirmedSigninCompromised', 'hidden', 'adminConfirmedUserCompromised', 'm365DAdminDismissedDetection', 'userChangedPasswordOnPremises', 'adminDismissedRiskForSignIn', 'adminConfirmedAccountSafe', 'unknownFutureValue'])
const safeDetails = new Set(['adminConfirmedSigninSafe', 'aiConfirmedSigninSafe', 'adminConfirmedAccountSafe'])

/** Framework-neutral source boundary. No identities or provider strings leave the aggregate. */
function timestamp(value: unknown, now: Date): Date | null {
  if (!(value instanceof Date) && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))) return null
  if (typeof value === 'string') {
    const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10))
    const calendar = new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return null
  }
  const parsed = new Date(value instanceof Date ? value.getTime() : value as string)
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(parsed.getTime()) || parsed.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) return null
  return parsed
}

export function microsoftRiskPolarity(state: MicrosoftRiskState, detail: MicrosoftRiskDetail | null): 'ACTIVE' | 'INACTIVE' | 'UNKNOWN' {
  if (detail && safeDetails.has(detail)) return 'INACTIVE'
  if (state === 'atRisk' || state === 'confirmedCompromised') return 'ACTIVE'
  if (state === 'none' || state === 'confirmedSafe' || state === 'remediated' || state === 'dismissed') return 'INACTIVE'
  return 'UNKNOWN'
}

/** Internal normalized source identity is used only for tenant-local distinctness/projection. */
export function parseMicrosoftRiskRecord(value: unknown, snapshotObservedAt: Date, now: Date) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return null
  const row = value as Record<string, unknown>
  if (Object.values(Object.getOwnPropertyDescriptors(row)).some((descriptor) => !('value' in descriptor))) return null
  if (typeof row.id !== 'string' || row.id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(row.id)) return null
  if (typeof row.riskLevel !== 'string' || row.riskLevel.length > 128 || typeof row.riskState !== 'string' || row.riskState.length > 128 || (row.riskDetail != null && (typeof row.riskDetail !== 'string' || row.riskDetail.length > 128))) return null
  const observedAt = timestamp(row.riskLastUpdatedDateTime ?? snapshotObservedAt, now)
  if (!observedAt) return null
  const riskLevel = (levels.has(row.riskLevel) ? row.riskLevel : 'unknownFutureValue') as MicrosoftRiskLevel
  const riskState = (states.has(row.riskState) ? row.riskState : 'unknownFutureValue') as MicrosoftRiskState
  const riskDetail = (row.riskDetail == null ? null : details.has(row.riskDetail as string) ? row.riskDetail : 'unknownFutureValue') as MicrosoftRiskDetail | null
  const sourceId = /^[a-f0-9-]{36}$/i.test(row.id) ? row.id.toLowerCase() : row.id
  return { sourceId, riskLevel, riskState, riskDetail, observedAt }
}

export function summarizeMicrosoftRisk(input: {
  payload: unknown; snapshotObservedAt: unknown; collectionSucceededAt: unknown
  collectionStatus: unknown; sourceAllowed?: boolean; now: Date
}): MicrosoftRiskSummary {
  const observation = timestamp(input.snapshotObservedAt, input.now)
  const collection = timestamp(input.collectionSucceededAt, input.now)
  const base: SummaryBase = { source: 'MICROSOFT_IDENTITY_PROTECTION', snapshotObservedAt: observation?.toISOString() ?? null, collectionSucceededAt: collection?.toISOString() ?? null }
  const unavailable = (reasonCode: MicrosoftRiskSummaryReason): MicrosoftRiskSummary => Object.freeze({ ...base, availability: 'UNAVAILABLE', completeness: 'UNKNOWN', rawRecordCount: null, observedActiveDistinctUserCount: null, activeDistinctUserCount: null, reasonCode })
  if (input.sourceAllowed === false) return unavailable('SOURCE_UNAVAILABLE')
  if (input.collectionStatus !== 'SUCCEEDED') return unavailable('COLLECTION_NOT_SUCCEEDED')
  if (!observation || !collection) return unavailable('INVALID_CLOCK')
  // Snapshot persistence completes before runSnapshotSync records success.
  // Millisecond equality is valid; even a 1ms inversion cannot attest this snapshot.
  if (collection.getTime() < observation.getTime()) return unavailable('INVALID_CLOCK')
  if (input.now.getTime() - observation.getTime() > MAX_AGE_MS || input.now.getTime() - collection.getTime() > MAX_AGE_MS) return unavailable('STALE_EVIDENCE')
  if (!Array.isArray(input.payload) || input.payload.length > MICROSOFT_RISK_MAX_ROWS) return unavailable('INVALID_SNAPSHOT')
  const identities = new Map<string, { active: boolean; signature: string; conflict: boolean }>()
  let partial = false
  let conflict = false
  for (const value of input.payload) {
    const row = parseMicrosoftRiskRecord(value, observation, input.now)
    if (!row) { partial = true; continue }
    const polarity = microsoftRiskPolarity(row.riskState, row.riskDetail)
    if (polarity === 'UNKNOWN' || row.riskLevel === 'unknownFutureValue' || row.riskDetail === 'unknownFutureValue') partial = true
    const signature = `${row.riskState}:${row.riskDetail ?? ''}:${row.riskLevel}`
    const existing = identities.get(row.sourceId)
    if (existing) {
      existing.active ||= polarity === 'ACTIVE'
      existing.conflict ||= existing.signature !== signature
      conflict ||= existing.conflict
    } else identities.set(row.sourceId, { active: polarity === 'ACTIVE', signature, conflict: false })
  }
  const observedActiveDistinctUserCount = [...identities.values()].filter((identity) => identity.active).length
  if (partial || conflict) return Object.freeze({ ...base, availability: 'PARTIAL', completeness: conflict ? 'CONFLICTING' : 'PARTIAL', rawRecordCount: input.payload.length, observedActiveDistinctUserCount, activeDistinctUserCount: null, reasonCode: conflict ? 'CONFLICTING_RECORDS' : 'PARTIAL_RECORDS' })
  return Object.freeze({ ...base, availability: 'AVAILABLE', completeness: 'COMPLETE', rawRecordCount: input.payload.length, observedActiveDistinctUserCount, activeDistinctUserCount: observedActiveDistinctUserCount, reasonCode: null })
}
