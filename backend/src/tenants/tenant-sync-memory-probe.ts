import {
  ENTRA_COLLECTION_LIMITS,
  GRAPH_LOG_COLLECTION_MAX_MATERIALIZED_BYTES,
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
  { resource: 'M365_AUDIT', synchronize: async () => {
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
    resource: 'M365_AUDIT',
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
  usageReportRowsProjected: sharePointRows.length + oneDriveRows.length,
  usageReportCsvBytes: Buffer.byteLength(usageCsv, 'utf8'),
  safeOtherPayloadBytes: safeOtherPayloads.reduce((total, value) => total + value.byteLength, 0),
  retainedBudgetMiB: GRAPH_LOG_COLLECTION_MAX_MATERIALIZED_BYTES / MIB,
})}`)
