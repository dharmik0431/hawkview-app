/* eslint-disable no-console */
/**
 * STEP 03 DRY RUN — READ-ONLY. WRITES NOTHING.
 *
 * Run with:  npx tsx scripts/alerting-reconciliation-dry-run.mts
 *
 * WHAT THIS DOES: a notification read, bounded tenant-scoped audit reads and a print.
 * There is no `create`, `update`,
 * `upsert`, `delete` or `$executeRaw` anywhere in this file, and the reconciliation it
 * calls is a pure function with no client, clock or environment of its own. Verify that by
 * reading it rather than by trusting this comment — it is short on purpose.
 *
 * WHY IT IS A SEPARATE FILE FROM THE LOGIC: I have no production access, so I could not run
 * or test this query. Everything decidable without production lives in
 * `src/alerts/reconciliation.ts` and is covered by `reconciliation.test.ts`; this file is
 * the thin part that cannot be tested here, kept small enough to review by inspection. If
 * the query is wrong the report will be wrong, which is why the generator states its own
 * invariants — `everyRowMappedExactlyOnce` is the one that catches a query returning fewer
 * rows than expected.
 *
 * NOTHING IS APPLIED. The mapping this prints is a proposal. Applying it is a separate
 * step, after review, and it is reversible because every entry carries the original
 * notification id.
 */
import { readFileSync } from 'node:fs'
import { readDryRunReconciliationRows } from '../src/alerts/reconciliation-audit-reader.js'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { reconcile, type ExistingAlertRow } from '../src/alerts/reconciliation.js'

/** Rows from a JSON file instead of the database.
 *
 *   npx tsx scripts/alerting-reconciliation-dry-run.mts rows.json
 *
 * Added because the worktree this lives in has no `.env`, so the query path could not run
 * where the numbers were needed — and the alternative was somebody reimplementing the
 * grouping in SQL, which is the instrument sharing an origin with what it measures. With a
 * file, the rows come from wherever you can get them and the counts come from the tested
 * `reconcile()`.
 *
 * The file is an array of `ExistingAlertRow`, with `resolvedAt` and `occurredAt` as ISO
 * strings or null. `occurredAt` is the EVENT's own time — `event_date_time` on the joined
 * audit record — and without it an incident's episodes cannot be recovered, so the report
 * counts that incident as an unknown number of episodes rather than as one.
 * A row that does not parse is REPORTED, not skipped: a reconciliation that silently
 * ignores malformed input gives a smaller answer and looks identical to a correct one. */
function rowsFromFile(path: string): { rows: ExistingAlertRow[]; rejected: readonly string[] } {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array of rows')

  const rows: ExistingAlertRow[] = []
  const rejected: string[] = []
  parsed.forEach((entry, index) => {
    const row = entry as Partial<ExistingAlertRow>
      & { resolvedAt?: string | null; occurredAt?: string | null }
    if (typeof row.id !== 'string' || typeof row.organizationId !== 'string'
      || typeof row.dedupeKey !== 'string' || typeof row.occurrenceCount !== 'number') {
      rejected.push(`index ${index}: missing id, organizationId, dedupeKey or occurrenceCount`)
      return
    }
    rows.push({
      id: row.id,
      organizationId: row.organizationId,
      customerTenantId: typeof row.customerTenantId === 'string' ? row.customerTenantId : null,
      dedupeKey: row.dedupeKey,
      occurrenceCount: row.occurrenceCount,
      resolvedAt: typeof row.resolvedAt === 'string' ? new Date(row.resolvedAt) : null,
      occurredAt: typeof row.occurredAt === 'string' ? new Date(row.occurredAt) : null,
      audit: row.audit ?? null,
    })
  })
  return { rows, rejected }
}

/** Constructed LAZILY, and with an adapter, which are two separate requirements.
 *
 * LAZILY, because building the client at module scope would throw in a worktree with no
 * `.env` — and for the dry run that is the exact situation the file-input path exists for, so
 * the escape hatch would have been unreachable in the only case that needed it.
 *
 * WITH AN ADAPTER, because Prisma 7 requires one: `new PrismaClient()` with no argument does
 * not construct. It was written that way here and NOBODY NOTICED, because `tsconfig.json`
 * includes only `src/**` — `npx tsc --noEmit` walked past both scripts and exited 0. So the
 * database path of the dry run had never been executed, and any figure attributed to it came
 * from somewhere else. `tsconfig.scripts.json` is the fix for the class; this is the instance. */
let client: PrismaClient | null = null
const prisma = () => (client ??= new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl(), max: 1 }),
}))

/** Named rather than defaulted. An empty connection string produces a connection error from
 * deep inside the driver; this says which variable is missing, at the top. */
const databaseUrl = (): string => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is not set. This command reads the database; there is no offline mode.')
  }
  return url
}

async function main() {
  const inputFile = process.argv[2]
  if (inputFile !== undefined) {
    const { rows, rejected } = rowsFromFile(inputFile)
    const report = reconcile(rows)
    printReport(report, { source: inputFile, rejected, auditJoin: null })
    return
  }

  const { rows, auditJoin } = await readDryRunReconciliationRows(prisma())
  printReport(reconcile(rows), {
    source: 'database (read-only)',
    rejected: [],
    auditJoin,
  })
}

function printReport(
  report: ReturnType<typeof reconcile>,
  context: {
    source: string
    rejected: readonly string[]
    auditJoin: Awaited<ReturnType<typeof readDryRunReconciliationRows>>['auditJoin'] | null
  },
) {
  console.log(JSON.stringify({
    DRY_RUN: 'read-only; nothing written',
    source: context.source,
    // Malformed input is named rather than dropped. A reconciliation that silently ignores
    // rows it could not read returns a smaller number and looks exactly like a correct one.
    rowsRejected: context.rejected.length,
    rejectedReasons: context.rejected,
    total: report.total,
    occurrencesRepresented: report.occurrencesRepresented,
    byShape: report.byShape,
    auditCategories: report.auditCategories,
    unrecognisedExamples: report.unrecognisedExamples,
    // THE NUMBERS CARRY THEIR CAVEAT IN THE OUTPUT, not only in the source. A figure
    // printed as "incidents" that is really "a floor computed over all rows" is exactly the
    // kind of thing that gets quoted into a decision and then relied on.
    incidentsNote:
      'declared counts ONLY rows whose type the key shape determines, which excludes every '
      + 'directory-audit row. assumingSingleType* are LOWER BOUNDS: undetermined rows are '
      + 'counted under one nominated type, and classification can only split an actor\'s '
      + 'events across types, never merge them. The DirectoryAuditOnly pair is the '
      + 'like-for-like comparison against a SQL figure filtered on that key prefix.',
    incidents: report.incidents,
    // EPISODES ARE NOT INCIDENTS, and the incident key carries no episode component: it
    // identifies a stream, so a count of incidents answers "how many subjects" rather than
    // "how many separate bursts". Over a two-month window those differ by roughly a factor
    // of two, and only the second is the question the plan asks.
    episodesNote:
      'counted with step 02 placeEvent at the interval the nominated type declares. '
      + 'incidentsWithUnrecoverableEpisodes are NOT one episode each — an aggregate row '
      + 'carries no per-event time, so its episode count is unknown and is reported as '
      + 'unknown. countedDirectoryAuditOnly is the like-for-like figure against a '
      + 'key-prefix-filtered SQL count. rowsStandingAloneBecauseSubjectUnresolved is the '
      + 'number a SQL count will most often disagree about: coalescing those rows onto one '
      + 'literal UNATTRIBUTED actor is the obvious thing to do in SQL and asserts a '
      + 'relationship nothing evidences, so compare this figure before comparing totals. '
      + 'standingAloneByShape breaks that figure down by key shape so it can be derived from '
      + 'the other side rather than taken on trust. WARNING ON rowsWithoutEventTime: before '
      + 'this commit it was summed over the incident buckets, which excluded ungrouped rows, '
      + 'so it UNDER-REPORTED -- 22 was quoted where the answer was 47. It is now counted per '
      + 'row, invariants.eventTimeCountsAddUp must be empty, and it must NOT be compared with '
      + 'any figure recorded from an earlier run.',
    episodes: report.episodes,
    invariants: report.invariants,
    ...(context.auditJoin === null ? {} : { auditJoin: context.auditJoin }),
  }, null, 2))

  // The mapping itself is long; printed separately so the summary above stays readable.
  console.log('\n--- MAPPING (reversible: every entry carries its notification id) ---')
  for (const entry of report.mapping) {
    console.log([entry.notificationId, entry.shape, entry.alertTypeId ?? '-', entry.incidentKey ?? 'UNGROUPED'].join('\t'))
  }
}

main()
  .then(() => client?.$disconnect())
  .catch(async (error) => {
    console.error(error)
    await client?.$disconnect()
    process.exit(1)
  })
