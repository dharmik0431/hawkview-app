import { utcTestDatabase } from '../identity-risk/risk-utc.test-fixtures.js'
import {
  ENTRA_COLLECTION_LIMITS,
  GRAPH_LOG_COLLECTION_MAX_MATERIALIZED_BYTES,
  LIMITED_SIGN_IN_ENRICHMENT_LIMITS,
  MAILBOX_USAGE_CSV_MAX_COLUMNS,
  MAILBOX_USAGE_CSV_MAX_ROWS,
  parseMailboxUsageCsv,
  parseMicrosoftUsageReportCsv,
  settleSyncCollectorModules,
  TenantSyncService,
} from './tenant-sync.service.js'

const MIB = 1024 * 1024
const pagesPerCollector = 7
const paddingBytes = MIB
let activeHeavyCollectors = 0
let maximumConcurrentHeavyCollectors = 0
let collectorsCompleted = 0
let peakRss = process.memoryUsage().rss
let graphPeakRss = peakRss

globalThis.gc?.()
const baselineRss = process.memoryUsage().rss

async function collectNearLimit() {
  activeHeavyCollectors += 1
  maximumConcurrentHeavyCollectors = Math.max(maximumConcurrentHeavyCollectors, activeHeavyCollectors)
  try {
    const service = new TenantSyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any)
    let page = 0
    ;(service as any).fetchGraphPage = async () => {
      page += 1
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      return new Response(JSON.stringify({
        value: [{ padding: 'x'.repeat(paddingBytes) }],
        '@odata.nextLink': page < pagesPerCollector
          ? `https://graph.microsoft.com/v1.0/memory-probe?page=${page + 1}`
          : undefined,
      }))
    }
    const rows = await (service as any).fetchGraphCollection(
      'https://graph.microsoft.com/v1.0/memory-probe?page=1',
      'test-token',
      'memory probe',
    )
    if (rows.length !== pagesPerCollector) throw new Error('MEMORY_PROBE_INCOMPLETE')
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    rows.length = 0
    collectorsCompleted += 1
  } finally {
    activeHeavyCollectors -= 1
    globalThis.gc?.()
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
}

const results = await settleSyncCollectorModules([
  { resource: 'SIGN_INS', synchronize: collectNearLimit },
  { resource: 'AUDIT_LOGS', synchronize: collectNearLimit },
])
if (results.some((result) => result.status === 'rejected')) throw new Error('MEMORY_PROBE_FAILED')
if (pagesPerCollector * (paddingBytes + 32) >= GRAPH_LOG_COLLECTION_MAX_MATERIALIZED_BYTES) {
  throw new Error('MEMORY_PROBE_NOT_NEAR_LIMIT')
}
graphPeakRss = peakRss

let activeGenericCollectors = 0
let maximumConcurrentGenericCollectors = 0
let safeObservedGenericCollector = false
const safeOtherPayloads: Buffer[] = []
async function collectGenericNearLimit() {
  activeGenericCollectors += 1
  maximumConcurrentGenericCollectors = Math.max(maximumConcurrentGenericCollectors, activeGenericCollectors)
  try {
    const service = new TenantSyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any)
    let page = 0
    ;(service as any).fetchGraphPage = async () => {
      page += 1
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      return new Response(JSON.stringify({
        value: [{ padding: 'x'.repeat(paddingBytes) }],
        '@odata.nextLink': page < pagesPerCollector
          ? `https://graph.microsoft.com/v1.0/generic-memory?page=${page + 1}`
          : undefined,
      }))
    }
    const rows = await (service as any).collectEntraCollection(
      'token', 'DEVICES', 'https://graph.microsoft.com/v1.0/generic-memory?page=1',
    )
    if (rows.length !== pagesPerCollector) throw new Error('GENERIC_MEMORY_PROBE_INCOMPLETE')
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    rows.length = 0
  } finally {
    activeGenericCollectors -= 1
    globalThis.gc?.()
  }
}
const genericResults = await settleSyncCollectorModules([
  { resource: 'DEVICES', synchronize: collectGenericNearLimit },
  { resource: 'APPLICATIONS', synchronize: collectGenericNearLimit },
  { resource: 'RUNTIME_TELEMETRY', synchronize: async () => {
    safeObservedGenericCollector = activeGenericCollectors === 1
    const genericSafePayload = Buffer.alloc(4 * MIB, 1)
    safeOtherPayloads.push(genericSafePayload)
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    return genericSafePayload
  } },
])
if (genericResults.some((result) => result.status === 'rejected')) throw new Error('GENERIC_MEMORY_PROBE_FAILED')
if (pagesPerCollector * (paddingBytes + 32) >= ENTRA_COLLECTION_LIMITS.materializedBytes) {
  throw new Error('GENERIC_MEMORY_PROBE_NOT_NEAR_LIMIT')
}
const genericPeakRss = peakRss

globalThis.gc?.()
const mailboxHeaders = [
  'User Principal Name', 'Storage Used (Byte)', 'Item Count',
  ...Array.from({ length: MAILBOX_USAGE_CSV_MAX_COLUMNS - 3 }, (_, index) => `h${index}`),
]
const mailboxRow = [
  'u@x', '1', '1',
  ...Array.from({ length: MAILBOX_USAGE_CSV_MAX_COLUMNS - 3 }, () => 'x'),
].join(',')
const mailboxCsv = [
  mailboxHeaders.join(','),
  ...Array.from({ length: MAILBOX_USAGE_CSV_MAX_ROWS - 1 }, () => mailboxRow),
].join('\n')
const mailboxRows = parseMailboxUsageCsv(mailboxCsv)
if (mailboxRows.length !== MAILBOX_USAGE_CSV_MAX_ROWS - 1) {
  throw new Error('MAILBOX_MEMORY_PROBE_INCOMPLETE')
}
peakRss = Math.max(peakRss, process.memoryUsage().rss)
const mailboxPeakRss = peakRss
mailboxRows.length = 0
globalThis.gc?.()

const usageHeaders = [
  'Report Refresh Date', 'Site Id', 'Site URL', 'Site Name', 'Is Deleted',
  'Last Activity Date', 'Storage Used (Byte)', 'Storage Allocated (Byte)',
  'Report Period', 'Owner Display Name', 'Owner Principal Name',
  'Root Web Template', 'File Count', 'Active File Count', 'Page View Count',
  'Visited Page Count',
  ...Array.from({ length: MAILBOX_USAGE_CSV_MAX_COLUMNS - 16 }, (_, index) => `unused-${index}`),
]
const usageRow = [
  '', 's', '', '', 'F', '', '1', '2', 'D', '', '', '', '', '', '', '',
  ...Array.from({ length: MAILBOX_USAGE_CSV_MAX_COLUMNS - 16 }, () => 'x'),
].join(',')
const usageCsv = [usageHeaders.join(','), ...Array.from({ length: MAILBOX_USAGE_CSV_MAX_ROWS - 1 }, () => usageRow)].join('\n')
let sharePointRows: Record<string, string>[] = []
let oneDriveRows: Record<string, string>[] = []
let usageCollectorActive = false
let safeObservedUsageCollector = false
const usageResults = await settleSyncCollectorModules([
  {
    resource: 'SHAREPOINT_USAGE',
    synchronize: async () => {
      usageCollectorActive = true
      sharePointRows = parseMicrosoftUsageReportCsv(usageCsv)
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      await new Promise<void>((resolve) => setImmediate(resolve))
      oneDriveRows = parseMicrosoftUsageReportCsv(usageCsv)
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      usageCollectorActive = false
    },
  },
  {
    resource: 'RUNTIME_TELEMETRY',
    synchronize: async () => {
      safeObservedUsageCollector = usageCollectorActive
      const usageSafePayload = Buffer.alloc(4 * MIB, 1)
      safeOtherPayloads.push(usageSafePayload)
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      return usageSafePayload
    },
  },
])
if (usageResults.some((result) => result.status === 'rejected')) throw new Error('USAGE_MEMORY_PROBE_FAILED')
const usagePeakRss = peakRss
if (sharePointRows.length !== MAILBOX_USAGE_CSV_MAX_ROWS - 1 || oneDriveRows.length !== MAILBOX_USAGE_CSV_MAX_ROWS - 1) {
  throw new Error('USAGE_MEMORY_PROBE_INCOMPLETE')
}
const usageReportRowsProjected = sharePointRows.length + oneDriveRows.length
sharePointRows.length = 0
oneDriveRows.length = 0
globalThis.gc?.()

// Exercise the real USERS and Exchange collectors through full sync, an
// audit-triggered refresh, and the incremental scheduler. Only persistence
// and unrelated products are stubbed; every body still crosses production
// streaming, projection, pagination and aggregate bounds.
const actualRows = 5_000
const pageRows = 1_000
let actualActive = 0
let maximumConcurrentActualMaterializers = 0
let actualUserWrites = 0
let actualSnapshots = 0
let actualMaximumSnapshotBytes = 0
const actualResources = new Set<string>()
const actualModes: string[] = []
async function actualMaterializer<T>(resource: string, work: () => Promise<T>): Promise<T> {
  actualActive += 1
  maximumConcurrentActualMaterializers = Math.max(maximumConcurrentActualMaterializers, actualActive)
  actualResources.add(resource)
  try { return await work() } finally {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    actualActive -= 1
  }
}
const databaseUsers = Array.from({ length: actualRows }, (_, index) => ({ microsoftUserId: `user-${index}`, userPrincipalName: `user-${index}@example.invalid` }))
const actualPrisma: any = {
  customerTenant: { findFirst: async () => ({ microsoftTenantId: 'synthetic-microsoft' }) },
  syncState: {
    findFirst: async () => ({ status: 'SUCCEEDED', lastSuccessfulAt: new Date(), lastAttemptAt: null }),
    findUnique: async () => ({ id: 'state', lastSuccessfulAt: new Date(), deltaLink: 'https://graph.microsoft.com/v1.0/users/delta?probePage=1' }),
    updateMany: async () => ({ count: 1 }), update: async () => ({}), findMany: async () => [],
  },
  directoryUser: {
    findMany: async ({ skip = 0, take = 250 }: { skip?: number; take?: number }) => databaseUsers.slice(skip, skip + take),
    upsert: async () => { actualUserWrites += 1 }, updateMany: async () => undefined,
  },
  tenantConnection: { update: async () => ({}) },
  $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
}
const actualService = new TenantSyncService(utcTestDatabase(actualPrisma), {
  getTenantAccessToken: async () => 'synthetic-token', getTenantExchangeAccessToken: async () => 'synthetic-token',
} as any, {} as any, { publishIncident: async () => undefined } as any, {} as any, {} as any)
;(actualService as any).logger = { warn: () => undefined, log: () => undefined }
const originalUsers = (actualService as any).synchronizeUsers.bind(actualService)
;(actualService as any).synchronizeUsers = (...args: unknown[]) => actualMaterializer('USERS', () => originalUsers(...args))
;(actualService as any).runSnapshotSync = (_tenant: unknown, resource: string, work: () => Promise<void>) => actualMaterializer(resource, work)
;(actualService as any).saveSnapshot = async (_tenant: unknown, _resource: string, snapshot: { rows: unknown[] }) => {
  const serialized = JSON.stringify(snapshot.rows)
  if (serialized.includes('UNSELECTED_CONTENT')) throw new Error('ACTUAL_PATH_PROJECTION_FAILED')
  actualMaximumSnapshotBytes = Math.max(actualMaximumSnapshotBytes, Buffer.byteLength(serialized, 'utf8'))
  actualSnapshots += 1
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}
for (const method of ['syncLicenses', 'syncOrganizationConfiguration', 'syncDomains', 'syncGroups', 'syncSharePointSites', 'syncSharePointSettings', 'syncSharePointUsage', 'syncDomainDnsHealth', 'syncAuthenticationRegistrations', 'syncAuthenticationMethodPolicy', 'syncSecurityDefaults', 'syncSignInLogs', 'syncDirectoryAuditLogs', 'syncM365AuditActivity', 'syncEntraCollection', 'refreshCollectionFieldStates']) {
  ;(actualService as any)[method] = async () => undefined
}
;(actualService as any).fetchGraphPage = async (url: string) => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
  const parsed = new URL(url)
  const page = Number(parsed.searchParams.get('probePage') ?? 1)
  if (url.includes('/mailboxSettings')) return new Response(JSON.stringify({ userPurpose: 'user', timeZone: 'x'.repeat(1_000), unselected: 'UNSELECTED_CONTENT' }))
  if (url.includes('/messageRules')) return new Response(JSON.stringify({ value: [{ id: 'r', displayName: 'x'.repeat(1_000), isEnabled: true, actions: { delete: true }, unselected: 'UNSELECTED_CONTENT' }] }))
  if (url.includes('/reports/')) return new Response('User Principal Name,Storage Used (Byte),Item Count\nu@example.invalid,1,1')
  if (url.includes('/organization')) return new Response(JSON.stringify({ value: [{ id: 'synthetic-microsoft', verifiedDomains: [{ name: 'example.invalid', isDefault: true }] }], unselected: 'x'.repeat(1_800_000) }))
  const isConfiguration = url.includes('outlook.office365.com')
  const isDelta = url.includes('/users/delta')
  const rows = Array.from({ length: pageRows }, (_, offset) => {
    const id = (page - 1) * pageRows + offset
    return isConfiguration
      ? { UserPrincipalName: `user-${id}@example.invalid`, PrimarySmtpAddress: `user-${id}@example.invalid`, DisplayName: 'x'.repeat(256), RecipientType: 'UserMailbox', unselected: 'UNSELECTED_CONTENT' }
      : { id: `user-${id}`, userPrincipalName: `user-${id}@example.invalid`, displayName: 'x'.repeat(1_000), mail: `user-${id}@example.invalid`, accountEnabled: true, unselected: 'UNSELECTED_CONTENT' }
  })
  const more = page * pageRows < actualRows
  return new Response(JSON.stringify({ value: rows,
    '@odata.nextLink': more ? `${parsed.origin}${parsed.pathname}?probePage=${page + 1}` : undefined,
    '@odata.deltaLink': isDelta && !more ? 'https://graph.microsoft.com/v1.0/users/delta?checkpoint=done' : undefined,
  }))
}
const actualTenant = { id: 'synthetic-tenant', organizationId: 'synthetic-org', microsoftTenantId: 'synthetic-microsoft', status: 'ACTIVE', displayName: null, primaryDomain: null, connection: { status: 'CONNECTED', connectionMode: 'HAWKVIEW_MANAGED', clientId: null, credentialReference: null, exchangeReadOnlyEnabledAt: new Date() } }
await (actualService as any).syncConnectedTenant(actualTenant, false, { includeBundle: false })
actualModes.push('full-with-optional-exchange')
await (actualService as any).reconcileDirectoryAuditChanges(actualTenant, 'token', [{ activityDisplayName: 'Update mailbox' }])
actualModes.push('audit-reconciliation')
;(actualService as any).syncSignInLogs = async () => actualMaterializer('SIGN_INS', async () => { await new Promise<void>((resolve) => setImmediate(resolve)) })
;(actualService as any).syncDirectoryAuditLogs = async () => (actualService as any).reconcileDirectoryAuditChanges(actualTenant, 'token', [{ activityDisplayName: 'Update mailbox' }])
await (actualService as any).syncConnectedTenant(actualTenant, false, { incrementalOnly: true, includeBundle: false })
actualModes.push('incremental-with-reconciliation')
if (maximumConcurrentActualMaterializers !== 1 || actualUserWrites !== 2 * actualRows || actualSnapshots !== 16) throw new Error(`ACTUAL_PATH_MEMORY_PROBE_FAILED:${maximumConcurrentActualMaterializers}:${actualUserWrites}:${actualSnapshots}`)
const actualPathPeakRss = peakRss

// A logical 100k-row database fixture stays outside the JS heap, just like
// PostgreSQL. Only the actual SQL LIMIT page is returned to the real backfill.
// Neither syncSignInLogs, enrichment nor backfill is replaced in this probe.
const historicalDatasetRows = 100_000
const nonpremiumCurrentRows = 5_000
const nonpremiumUpdatedIds = new Set<string>()
let nonpremiumCreates = 0; let nonpremiumReadPages = 0; let maximumHistoryTake = 0
let activeHistoryUpdates = 0; let maximumHistoryUpdates = 0
let activeLocationLookups = 0; let maximumLocationLookups = 0; let locationLookups = 0
let nonpremiumFinalState: any = null
const nonpremiumPrisma: any = {
  syncState: { upsert: async () => ({ lastSuccessfulAt: new Date('2026-01-01') }), update: async ({ data }: any) => { nonpremiumFinalState = data; return { consecutiveFailures: 0 } } },
  signInLog: { findFirst: async () => null, createMany: async ({ data }: any) => { nonpremiumCreates += data.length }, deleteMany: async () => undefined, findMany: async () => { throw new Error('UNBOUNDED_HISTORY_READ') } },
  $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
    $queryRaw: async (query: any) => {
      if (query.strings.join('').includes('set_config')) {
        if (!(Number(query.values[0]) > 0 && Number(query.values[0]) <= LIMITED_SIGN_IN_ENRICHMENT_LIMITS.statementTimeoutMs)) throw new Error('INVALID_STATEMENT_TIMEOUT')
        return []
      }
      if (query.values[2] !== 'synthetic-org' || query.values[3] !== 'synthetic-tenant' || !(query.values[4] instanceof Date)) throw new Error('HISTORY_SCOPE_MISSING')
      const take = query.values.at(-1); const cursor = Number(String(query.values.at(-2)).split('-').at(-1))
      nonpremiumReadPages++; maximumHistoryTake = Math.max(maximumHistoryTake, take)
      if (take > LIMITED_SIGN_IN_ENRICHMENT_LIMITS.historyPageRows + 1) throw new Error('UNBOUNDED_HISTORY_TAKE')
      const page = []
      for (let index = cursor + 1; index <= historicalDatasetRows && page.length < take; index++) {
        const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
        if (!nonpremiumUpdatedIds.has(id)) page.push({ id, ipAddress: '10.1.0.1', location: null, locationOversized: false })
      }
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      return page
    },
    signInLog: { updateMany: async ({ where }: any) => {
      if (where.organizationId !== 'synthetic-org' || where.customerTenantId !== 'synthetic-tenant' || !where.expiresAt.gt || !where.location) throw new Error('HISTORY_UPDATE_SCOPE_MISSING')
      activeHistoryUpdates++; maximumHistoryUpdates = Math.max(maximumHistoryUpdates, activeHistoryUpdates)
      await new Promise<void>(resolve => setImmediate(resolve))
      nonpremiumUpdatedIds.add(where.id); activeHistoryUpdates--
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      return { count: 1 }
    } },
  }),
}
const nonpremiumService = new TenantSyncService(nonpremiumPrisma, {} as any, { lookup: async () => {
  locationLookups++; activeLocationLookups++; maximumLocationLookups = Math.max(maximumLocationLookups, activeLocationLookups)
  await new Promise<void>(resolve => setImmediate(resolve)); activeLocationLookups--
  return { city: 'Synthetic', countryOrRegion: 'ZZ', geoCoordinates: { latitude: 1, longitude: 2 }, source: 'MAXMIND_GEOLITE2' }
} } as any, { resolveIncident: async () => undefined } as any, { pruneExpired: async () => undefined } as any, {} as any)
;(nonpremiumService as any).signInEntitlement = async () => 'NON_PREMIUM'
;(nonpremiumService as any).fetchGraphCollection = async () => { throw new Error('Authentication_RequestFromNonPremiumTenantOrB2CTenant') }
;(nonpremiumService as any).fetchLimitedLoginActivity = async () => Array.from({ length: nonpremiumCurrentRows }, (_, index) => ({ id: `current-${index}`, createdDateTime: '2026-09-03T10:00:00Z', ipAddress: `10.1.${Math.floor(index / 250)}.${index % 250 + 1}`, status: { errorCode: 0 } }))
await (nonpremiumService as any).syncSignInLogs(actualTenant, 'synthetic-token')
peakRss = Math.max(peakRss, process.memoryUsage().rss)
const nonpremiumPeakRss = peakRss
if (nonpremiumCreates !== nonpremiumCurrentRows || nonpremiumUpdatedIds.size !== LIMITED_SIGN_IN_ENRICHMENT_LIMITS.historyRows || maximumHistoryUpdates !== 1 || maximumLocationLookups > 8 || locationLookups !== 1000 || nonpremiumFinalState.status !== 'RUNNING' || !(nonpremiumFinalState.lastSuccessfulAt instanceof Date) || Object.hasOwn(nonpremiumFinalState, 'deltaLink')) throw new Error('NONPREMIUM_ACTUAL_PATH_FAILED')

console.log(`HAWKVIEW_MEMORY_PROBE=${JSON.stringify({
  baselineRssMiB: Math.round(baselineRss / MIB * 10) / 10,
  peakRssMiB: Math.round(peakRss / MIB * 10) / 10,
  rssGrowthMiB: Math.round((peakRss - baselineRss) / MIB * 10) / 10,
  graphPeakRssMiB: Math.round(graphPeakRss / MIB * 10) / 10,
  genericPeakRssMiB: Math.round(genericPeakRss / MIB * 10) / 10,
  mailboxPeakRssMiB: Math.round(mailboxPeakRss / MIB * 10) / 10,
  usagePeakRssMiB: Math.round(usagePeakRss / MIB * 10) / 10,
  mailboxRowsProjected: MAILBOX_USAGE_CSV_MAX_ROWS - 1,
  mailboxColumnsParsed: MAILBOX_USAGE_CSV_MAX_COLUMNS,
  mailboxCsvBytes: Buffer.byteLength(mailboxCsv, 'utf8'),
  maximumConcurrentHeavyCollectors,
  collectorsCompleted,
  maximumConcurrentGenericCollectors,
  safeObservedGenericCollector,
  safeObservedUsageCollector,
  usageReportRowsProjected,
  usageReportCsvBytes: Buffer.byteLength(usageCsv, 'utf8'),
  safeOtherPayloadBytes: safeOtherPayloads.reduce((total, value) => total + value.byteLength, 0),
  retainedBudgetMiB: GRAPH_LOG_COLLECTION_MAX_MATERIALIZED_BYTES / MIB,
  actualPathPeakRssMiB: Math.round(actualPathPeakRss / MIB * 10) / 10,
  maximumConcurrentActualMaterializers,
  actualRows,
  actualUserWrites,
  actualSnapshots,
  actualMaximumSnapshotBytes,
  actualModes,
  actualResources: [...actualResources].sort(),
  nonpremiumPeakRssMiB: Math.round(nonpremiumPeakRss / MIB * 10) / 10,
  historicalDatasetRows,
  nonpremiumCurrentRows,
  nonpremiumCreates,
  nonpremiumReadPages,
  nonpremiumUpdatedRows: nonpremiumUpdatedIds.size,
  maximumHistoryTake,
  maximumHistoryUpdates,
  maximumLocationLookups,
  locationLookups,
  nonpremiumFinalStatus: nonpremiumFinalState.status,
  nonpremiumFinalCode: nonpremiumFinalState.lastErrorCode,
  nonpremiumPrimaryEvidenceTimestamp: nonpremiumFinalState.lastSuccessfulAt instanceof Date,
  nonpremiumAdvancedCompleteBaseline: nonpremiumFinalState.status === 'SUCCEEDED' || Object.hasOwn(nonpremiumFinalState, 'deltaLink'),
})}`)
