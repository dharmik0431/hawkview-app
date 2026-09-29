export type TenantBundle = {
  tenant: any
  users: any[]
  signIns: any[]
  exchange: any
  sharepoint: any
  teams: any
  licenses?: {
    rows: Array<{
      name: string
      used: number
      total: number
      status?: 'ok' | 'warn' | 'bad'
      note?: string
    }>
  }
  dns?: {
    domain?: string
    spf?: string | { record: string; status: 'healthy' | 'warning' }
    dkim?: string | { record: string; status: 'healthy' | 'warning' }
    dmarc?: string | { record: string; status: 'healthy' | 'warning' }
    blacklist?: { record: string; status: 'not_checked' }
    checkedAt?: string
    byDomain?: Record<string, any>
  }
  entra?: {
    caPolicies: any[]
    authMethods: any[]
    namedLocations: any[]
  }
  sync?: {
    users?: TenantSyncStatus
    licenses?: TenantSyncStatus
    domains?: TenantSyncStatus
    groups?: TenantSyncStatus
    signIns?: TenantSyncStatus
    auditLogs?: TenantSyncStatus
    [resource: string]: TenantSyncStatus | undefined
  }
  syncFreshness?: {
    overallLastSuccessfulAt: string | null
    services: {
      office365: ServiceSyncFreshness
      entraId: ServiceSyncFreshness
      exchange: ServiceSyncFreshness
      sharePointOneDrive: ServiceSyncFreshness
      signInLogs: ServiceSyncFreshness
      auditLogs: ServiceSyncFreshness
    }
  }
}

export type ServiceSyncFreshness = {
  service: string
  status: 'SUCCESS' | 'PARTIAL' | 'RUNNING' | 'PENDING' | 'FAILED' | 'STALE' | 'NOT_COLLECTED' | 'UNKNOWN'
  freshnessStatus: 'CURRENT' | 'AGING' | 'STALE' | 'NEVER_SYNCED' | 'UNKNOWN'
  lastAttemptStartedAt: string | null
  lastAttemptCompletedAt: string | null
  lastSuccessfulCollectionAt: string | null
  nextScheduledAttemptAt: string | null
  partialFailures: Array<{ collector: string; status: string; message: string | null }>
}

export type TenantSyncStatus = {
  status: string
  lastSuccessfulAt: string | null
  lastError: string | null
  resourceType?: string
  outcomeProjection?: SyncOutcomeProjection
}

/** Recorded outcomes do not attest that a collector is executing now. */
export type SyncOutcomeProjection = {
  version: 1
  resourceType: string
  recordedOutcome: {
    kind: 'SUCCEEDED' | 'FAILED' | 'NOT_STARTED_OR_IDLE' | 'AWAITING_EXECUTION' |
      'LIMITED_COLLECTION_RECORDED' | 'INITIALIZATION_WAIT_RECORDED' |
      'DEFERRED_WORK_RECORDED' | 'UNKNOWN'
    basis: 'STORED_STATUS' | 'RECOGNIZED_RETURN_PATH' | 'LEGACY_LABEL' | 'UNCLASSIFIED'
    relation: 'LATEST_RECORDED' | 'PREDATES_ATTEMPT' | 'RETAINED_OR_CURRENT' | 'UNKNOWN'
  }
  execution: 'UNKNOWN'
  lastAttemptAt: string | null
  reasonCode: string | null
}
