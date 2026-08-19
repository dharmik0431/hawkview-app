type PlainRecord = Record<string, unknown>

function record(value: unknown): PlainRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? (value as PlainRecord)
    : null
}

function own(value: PlainRecord | null, key: string): unknown {
  return value && Object.prototype.hasOwnProperty.call(value, key)
    ? value[key]
    : undefined
}

export type ExchangeDatasetState =
  | 'SUCCESS'
  | 'FAILED'
  | 'PARTIAL'
  | 'STALE'
  | 'RUNNING'
  | 'UNKNOWN'

export type ExchangeDatasetStatus = {
  state: ExchangeDatasetState
  label: string
  tone: 'success' | 'warning' | 'danger' | 'neutral'
  hasLastKnownRows: boolean
  lastSuccessfulAt: string | null
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  return Number.isFinite(new Date(value).getTime()) ? value : null
}

/** Status is derived only from the resource sync record; row count is context. */
export function exchangeDatasetStatus(
  value: unknown,
  rowCount: number,
): ExchangeDatasetStatus {
  const source = record(value)
  const raw = typeof own(source, 'status') === 'string'
    ? String(own(source, 'status')).trim().toLowerCase()
    : ''
  const hasLastKnownRows = Number.isInteger(rowCount) && rowCount > 0
  const suffix = hasLastKnownRows ? ' · last-known data' : ''
  const lastSuccessfulAt = safeTimestamp(own(source, 'lastSuccessfulAt'))

  if (raw === 'success' || raw === 'succeeded' || raw === 'ready') {
    return { state: 'SUCCESS', label: 'Synchronized', tone: 'success', hasLastKnownRows, lastSuccessfulAt }
  }
  if (raw === 'failed' || raw === 'error') {
    return { state: 'FAILED', label: `Failed${suffix}`, tone: 'danger', hasLastKnownRows, lastSuccessfulAt }
  }
  if (raw === 'partial') {
    return { state: 'PARTIAL', label: `Partial${suffix}`, tone: 'warning', hasLastKnownRows, lastSuccessfulAt }
  }
  if (raw === 'stale') {
    return { state: 'STALE', label: `Stale${suffix}`, tone: 'warning', hasLastKnownRows, lastSuccessfulAt }
  }
  if (raw === 'running' || raw === 'starting') {
    return { state: 'RUNNING', label: `Syncing${suffix}`, tone: 'warning', hasLastKnownRows, lastSuccessfulAt }
  }
  return {
    state: 'UNKNOWN',
    label: hasLastKnownRows ? 'Unverified · cached rows' : 'Awaiting sync',
    tone: 'neutral',
    hasLastKnownRows,
    lastSuccessfulAt,
  }
}
