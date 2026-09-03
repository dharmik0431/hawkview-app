import {
  GRAPH_LOG_COLLECTION_MAX_MATERIALIZED_BYTES,
  MAILBOX_USAGE_CSV_MAX_COLUMNS,
  MAILBOX_USAGE_CSV_MAX_ROWS,
  parseMailboxUsageCsv,
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

console.log(`HAWKVIEW_MEMORY_PROBE=${JSON.stringify({
  baselineRssMiB: Math.round(baselineRss / MIB * 10) / 10,
  peakRssMiB: Math.round(peakRss / MIB * 10) / 10,
  rssGrowthMiB: Math.round((peakRss - baselineRss) / MIB * 10) / 10,
  graphPeakRssMiB: Math.round(graphPeakRss / MIB * 10) / 10,
  mailboxPeakRssMiB: Math.round(mailboxPeakRss / MIB * 10) / 10,
  mailboxRowsProjected: MAILBOX_USAGE_CSV_MAX_ROWS - 1,
  mailboxColumnsParsed: MAILBOX_USAGE_CSV_MAX_COLUMNS,
  mailboxCsvBytes: Buffer.byteLength(mailboxCsv, 'utf8'),
  maximumConcurrentHeavyCollectors,
  collectorsCompleted,
  retainedBudgetMiB: GRAPH_LOG_COLLECTION_MAX_MATERIALIZED_BYTES / MIB,
})}`)
