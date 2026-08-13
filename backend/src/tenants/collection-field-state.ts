export type CollectionFieldState =
  | 'AVAILABLE'
  | 'PENDING'
  | 'FAILED'
  | 'UNSUPPORTED'
  | 'NOT_LICENSED'
  | 'PERMISSION_REQUIRED'
  | 'NOT_CONFIGURED'
  | 'STALE'

export function classifyCollectionFailure(message: string | null | undefined): {
  state: CollectionFieldState
  reasonCode: string
} {
  const text = (message ?? '').toLowerCase()
  if (/license|premium|subscription|not licensed/.test(text)) {
    return { state: 'NOT_LICENSED', reasonCode: 'MICROSOFT_LICENSE_REQUIRED' }
  }
  if (/403|forbidden|permission|access denied|authorization/.test(text)) {
    return { state: 'PERMISSION_REQUIRED', reasonCode: 'MICROSOFT_PERMISSION_REQUIRED' }
  }
  if (/not supported|not available|does not expose|404/.test(text)) {
    return { state: 'UNSUPPORTED', reasonCode: 'MICROSOFT_API_NOT_AVAILABLE' }
  }
  return { state: 'FAILED', reasonCode: 'MICROSOFT_COLLECTION_FAILED' }
}

export function deriveCollectionFieldState(input: {
  syncStatus?: string | null
  lastErrorMessage?: string | null
  hasPriorSnapshot?: boolean
  unsupported?: boolean
  unsupportedMessage?: string
  notConfigured?: boolean
}): { state: CollectionFieldState; reasonCode: string | null; message: string | null; isStale: boolean } {
  if (input.unsupported) {
    return {
      state: 'UNSUPPORTED',
      reasonCode: 'MICROSOFT_API_NOT_AVAILABLE',
      message: input.unsupportedMessage ?? 'Microsoft does not expose this data through a supported API.',
      isStale: false,
    }
  }
  if (input.notConfigured) {
    return {
      state: 'NOT_CONFIGURED',
      reasonCode: 'NO_CONDITIONAL_ACCESS_POLICIES',
      message: 'No Conditional Access policies configured.',
      isStale: false,
    }
  }
  if (input.syncStatus === 'SUCCEEDED') {
    return { state: 'AVAILABLE', reasonCode: null, message: null, isStale: false }
  }
  if (input.syncStatus === 'FAILED' && input.hasPriorSnapshot) {
    return {
      state: 'STALE',
      reasonCode: 'REFRESH_FAILED',
      message: input.lastErrorMessage ?? 'The latest refresh failed; the last successful value is shown.',
      isStale: true,
    }
  }
  if (input.syncStatus === 'RUNNING' || !input.syncStatus) {
    return {
      state: 'PENDING',
      reasonCode: input.syncStatus ? 'SYNC_IN_PROGRESS' : 'SYNC_NOT_STARTED',
      message: null,
      isStale: false,
    }
  }
  return {
    ...classifyCollectionFailure(input.lastErrorMessage),
    message: input.lastErrorMessage ?? 'Microsoft collection failed.',
    isStale: false,
  }
}

export function bytesToGigabytes(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round((value / 1024 ** 3) * 100) / 100
    : null
}
