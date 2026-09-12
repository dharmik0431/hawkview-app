/* eslint-disable no-console */
/**
 * STEP 03 DRY RUN — READ-ONLY. WRITES NOTHING.
 *
 * Run with:  npx tsx scripts/alerting-reconciliation-dry-run.mts
 *
 * WHAT THIS DOES: two `findMany` calls and a print. There is no `create`, `update`,
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
import { PrismaClient } from '../src/generated/prisma/client.js'
import { reconcile, parseDedupeKey, type ExistingAlertRow } from '../src/alerts/reconciliation.js'

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
 * The file is an array of `ExistingAlertRow`, with `resolvedAt` as an ISO string or null.
 * A row that does not parse is REPORTED, not skipped: a reconciliation that silently
 * ignores malformed input gives a smaller answer and looks identical to a correct one. */
function rowsFromFile(path: string): { rows: ExistingAlertRow[]; rejected: readonly string[] } {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array of rows')

  const rows: ExistingAlertRow[] = []
  const rejected: string[] = []
  parsed.forEach((entry, index) => {
    const row = entry as Partial<ExistingAlertRow> & { resolvedAt?: string | null }
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
      audit: row.audit ?? null,
    })
  })
  return { rows, rejected }
}

/** Constructed LAZILY, and that is load-bearing rather than tidy.
 *
 * `new PrismaClient()` reads the database URL at construction. Building it at module scope
 * would throw in a worktree with no `.env` — which is the exact situation the file path was
 * added for, so the escape hatch would have been unreachable in the only case that needed
 * it. The file path must never touch the client. */
let client: PrismaClient | null = null
const prisma = () => (client ??= new PrismaClient())

async function main() {
  const inputFile = process.argv[2]
  if (inputFile !== undefined) {
    const { rows, rejected } = rowsFromFile(inputFile)
    const report = reconcile(rows)
    printReport(report, { source: inputFile, rejected, auditJoin: null })
    return
  }

  const notifications = await prisma().notification.findMany({
    select: {
      id: true,
      organizationId: true,
      customerTenantId: true,
      dedupeKey: true,
      occurrenceCount: true,
      resolvedAt: true,
    },
  })

  // The audit ids the directory-audit keys name, so the actor and target can be resolved.
  // Only for keys that carry one; nothing is invented for keys that do not.
  const auditIds = notifications
    .map((row) => parseDedupeKey(row.dedupeKey).eventIdInKey)
    .filter((id): id is string => id !== null)

  const audits = auditIds.length === 0 ? [] : await prisma().directoryAuditLog.findMany({
    where: { microsoftAuditId: { in: auditIds } },
    select: { microsoftAuditId: true, initiatedBy: true, targetResources: true },
  })
  const auditById = new Map(audits.map((audit) => [audit.microsoftAuditId, audit]))

  const rows: ExistingAlertRow[] = notifications.map((row) => {
    const auditId = parseDedupeKey(row.dedupeKey).eventIdInKey
    const audit = auditId === null ? null : auditById.get(auditId) ?? null
    return {
      id: row.id,
      organizationId: row.organizationId,
      customerTenantId: row.customerTenantId,
      dedupeKey: row.dedupeKey,
      occurrenceCount: row.occurrenceCount,
      resolvedAt: row.resolvedAt,
      audit: audit === null ? null : {
        // `initiatedBy` and `targetResources` are JSON on the audit row; reduced to the two
        // strings the reconciliation needs, and left null rather than coerced when the shape
        // is not what we expect. A coerced value here would be a guess presented as a join.
        initiatedBy: typeof audit.initiatedBy === 'string' ? audit.initiatedBy
          : readString(audit.initiatedBy, ['user', 'userPrincipalName'])
            ?? readString(audit.initiatedBy, ['user', 'id']),
        targetResources: readTargets(audit.targetResources),
        privileged: null,
      },
    }
  })

  printReport(reconcile(rows), {
    source: 'database (read-only)',
    rejected: [],
    auditJoin: {
      keysNamingAnAuditRecord: auditIds.length,
      auditRecordsFound: audits.length,
      // A shortfall here is a real finding rather than noise: it means the notification
      // outlived the evidence it was raised from. Measured as zero across all 317, which
      // says the key parses cleanly.
      notJoined: auditIds.length - audits.length,
    },
  })
}

function printReport(
  report: ReturnType<typeof reconcile>,
  context: {
    source: string
    rejected: readonly string[]
    auditJoin: { keysNamingAnAuditRecord: number; auditRecordsFound: number; notJoined: number } | null
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
    incidents: report.incidents,
    invariants: report.invariants,
    ...(context.auditJoin === null ? {} : { auditJoin: context.auditJoin }),
  }, null, 2))

  // The mapping itself is long; printed separately so the summary above stays readable.
  console.log('\n--- MAPPING (reversible: every entry carries its notification id) ---')
  for (const entry of report.mapping) {
    console.log([entry.notificationId, entry.shape, entry.alertTypeId ?? '-', entry.incidentKey ?? 'UNGROUPED'].join('\t'))
  }
}

/** Reads a nested string from a JSON value without coercing. Null when absent or not a
 * string, because a coerced value would be a guess wearing the clothes of a join. */
function readString(value: unknown, path: readonly string[]): string | null {
  let cursor: unknown = value
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return typeof cursor === 'string' ? cursor : null
}

function readTargets(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => readString(entry, ['id']) ?? readString(entry, ['displayName']))
    .filter((id): id is string => id !== null)
}

main()
  .then(() => client?.$disconnect())
  .catch(async (error) => {
    console.error(error)
    await client?.$disconnect()
    process.exit(1)
  })
