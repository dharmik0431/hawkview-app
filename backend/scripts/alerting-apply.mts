/* eslint-disable no-console */
/**
 * STEP 03 APPLY - the runner. Five subcommands, one of which writes.
 *
 *   npx tsx scripts/alerting-apply.mts save-mapping --out ../artefacts/mapping.json
 *   npx tsx scripts/alerting-apply.mts preflight    --mapping ... --out ...
 *   npx tsx scripts/alerting-apply.mts apply        --mapping ... --receipt ...
 *   npx tsx scripts/alerting-apply.mts verify       --receipt ... --out ...
 *   npx tsx scripts/alerting-apply.mts revert       --receipt ... --out ...
 *
 * NOTHING IN THIS FILE HAS BEEN RUN. There is no database, no DATABASE_URL and no production
 * access in the worktree where it was written, so every figure it prints is unverified and the
 * first run is Dharmik's. That is also why it is thin: everything decidable without a database
 * lives in `src/alerts/apply-mapping.ts` under test, and this file is only the part that
 * cannot be. A runner printing plausible numbers is the failure the runbook exists to prevent.
 *
 * THE WRITE IS ONE STATEMENT. `applyStatement()` emits it and a test asserts it is one
 * statement for 1, 10, 364 and 5,000 rows. It is executed here with `$executeRawUnsafe` and
 * bound parameters - "unsafe" names the string interpolation of the SQL TEXT, which that
 * function builds and which contains no values; every value travels as $1, $2, ...
 *
 * IF YOU CHANGE THIS TO A LOOP you have replaced the conditional write with the naive
 * read-then-write, which let both writers through in all 25 of QA's concurrency rounds. The
 * property is not "we check the version", it is "the check and the write are one statement".
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { parseDedupeKey, reconcile, type ExistingAlertRow } from '../src/alerts/reconciliation.js'
import {
  applyStatement, applyValidated, digestOf, explain, revertStatement, validateApply,
  validateRevert, watchedFieldsDisturbedBetween,
  type ApplyReceipt, type MappingEntry, type StoredRow, type StoredSnapshot,
} from '../src/alerts/apply-mapping.js'

/** Constructed LAZILY, and with an adapter.
 *
 * LAZILY so that `--help`-shaped mistakes and a missing `DATABASE_URL` fail with a sentence
 * rather than a stack trace from module scope, and so nothing connects until a subcommand has
 * decided it needs to.
 *
 * WITH AN ADAPTER, because Prisma 7 requires one — `new PrismaClient()` with no argument does
 * not construct. Worth stating because the dry-run script next door was written without it and
 * nobody found out: `tsconfig.json` includes only `src/**`, so `npx tsc --noEmit` walked past
 * both scripts and exited 0. Typecheck these two with `tsconfig.scripts.json`. */
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

const arg = (name: string): string | null => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? null : process.argv[at + 1] ?? null
}
const required = (name: string): string => {
  const value = arg(name)
  if (value === null) { console.error(`Missing --${name}`); process.exit(2) }
  return value
}
const writeFile = (path: string, text: string): void => {
  mkdirSync(dirname(resolve(path)), { recursive: true })
  writeFileSync(resolve(path), text)
}

/** THE STORE, AS THE APPLY SEES IT.
 *
 * `incident_key` and `episode` are read with a raw query rather than through the Prisma client
 * because THE COLUMNS ARE NOT IN THE PRISMA SCHEMA YET - the migration adding them is part of
 * this work. If this fails with "column does not exist", the migration has not been applied,
 * and that is the correct place to stop: before the preflight, not half way through a write.
 *
 * Timestamps are rendered to ISO text in SQL rather than in JavaScript, because `WatchedFields`
 * compares them as strings and a driver handing back a Date in the machine's zone would make
 * `watchedFieldsDisturbedBetween` fire on a row nobody touched. */
const STORE_QUERY = `
  SELECT id, organization_id AS "organizationId", dedupe_key AS "dedupeKey",
         occurrence_count AS "occurrenceCount",
         to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "resolvedAt",
         to_char(last_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastOccurredAt",
         incident_key AS "incidentKey", episode
  FROM notifications
  ORDER BY id
`

type Reader = Readonly<{ $queryRawUnsafe: <T>(sql: string) => Promise<T> }>
const readStore = (on: Reader): Promise<StoredSnapshot> => on.$queryRawUnsafe<StoredRow[]>(STORE_QUERY)

/** The mapping, computed the way the dry run computes it - same `reconcile`, same inputs. */
async function computeMapping(): Promise<{ entries: MappingEntry[]; figures: Record<string, number> }> {
  const notifications = await prisma().notification.findMany({
    select: {
      id: true, organizationId: true, customerTenantId: true,
      dedupeKey: true, occurrenceCount: true, resolvedAt: true,
    },
  })
  const auditIds = notifications
    .map((row) => parseDedupeKey(row.dedupeKey).eventIdInKey)
    .filter((id): id is string => id !== null)
  const audits = auditIds.length === 0 ? [] : await prisma().directoryAuditLog.findMany({
    where: { microsoftAuditId: { in: auditIds } },
    select: { microsoftAuditId: true, initiatedBy: true, targetResources: true, eventDateTime: true },
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
      occurredAt: audit?.eventDateTime ?? null,
      audit: audit === null ? null : {
        initiatedBy: typeof audit.initiatedBy === 'string' ? audit.initiatedBy : null,
        targetResources: [],
        privileged: null,
      },
    }
  })

  const report = reconcile(rows)
  if (report.invariants.episodeOrdinalsAgreeWithCounts.length > 0) {
    throw new Error('The episode ordinals disagree with the episode counts:\n  '
      + report.invariants.episodeOrdinalsAgreeWithCounts.join('\n  '))
  }

  const entries: MappingEntry[] = []
  for (const entry of report.mapping) {
    if (entry.incidentKey === null) continue
    // AN UNDECIDED EPISODE IS AN ERROR, NOT A NULL. Null is a VALUE here - it means the count
    // could not be recovered, which 47 rows are entitled to and 317 are not. A row the episode
    // pass never reached would otherwise be written as unrecoverable and read as if that had
    // been measured. No input reaches this today; it stops the convenient default from being
    // available if one ever does.
    if (!report.episodeByRow.has(entry.notificationId)) {
      throw new Error(`No episode decision for ${entry.notificationId}. Refusing to guess.`)
    }
    entries.push({
      notificationId: entry.notificationId,
      incidentKey: entry.incidentKey,
      episode: report.episodeByRow.get(entry.notificationId) ?? null,
      observed: digestOf({ dedupeKey: entry.dedupeKey, occurrenceCount: entry.occurrenceCount }),
    })
  }

  return {
    entries,
    figures: {
      rows: notifications.length,
      entries: entries.length,
      unnumbered: entries.filter((entry) => entry.episode === null).length,
      incidents: new Set(entries.map((entry) => entry.incidentKey)).size,
      episodes: report.episodes.counted,
      attributed: report.episodes.fromAttributedRows,
      standingAlone: report.episodes.fromStandingAloneRows,
      unrecoverable: report.episodes.incidentsWithUnrecoverableEpisodes,
    },
  }
}

async function main(): Promise<void> {
  const command = process.argv[2]

  if (command === 'save-mapping') {
    const { entries, figures } = await computeMapping()
    console.log(`Read ${figures.rows} notification rows.`)
    console.log(`Mapping: ${figures.entries} entries across ${figures.incidents} incidents; `
      + `${figures.unnumbered} carry no episode number.`)
    console.log(`Episodes: ${figures.episodes} counted (${figures.attributed} attributed, `
      + `${figures.standingAlone} standing alone), ${figures.unrecoverable} incidents unrecoverable.`)
    const out = required('out')
    writeFile(out, JSON.stringify({ savedAt: new Date().toISOString(), figures, entries }, null, 2))
    console.log(`Wrote ${out}`)
    console.log('CHECK THESE FIGURES AGAINST WHAT WAS APPROVED before going further. They are '
      + 'printed to be compared against the dry run, not to be read as confirmation.')
    return
  }

  if (command === 'preflight') {
    const mapping: MappingEntry[] = JSON.parse(readFileSync(resolve(required('mapping')), 'utf8')).entries
    const decision = validateApply(await readStore(prisma()), mapping)
    const report = decision.proceed
      ? ['No differences. The mapping still describes the data.',
         `${decision.run.writes.length} rows would be written. `
           + `${decision.run.alreadyApplied.length} already carry it and would not be written again.`,
         'PREFLIGHT PASSED - safe to apply.'].join('\n')
      : `${explain(decision.differences)}\n`
        + 'PREFLIGHT FAILED - do not apply. Re-run save-mapping and have the new figures approved.'
    console.log(report)
    const out = arg('out')
    if (out !== null) { writeFile(out, report); console.log(`Wrote ${out}`) }
    process.exitCode = decision.proceed ? 0 : 1
    return
  }

  if (command === 'apply') {
    const mapping: MappingEntry[] = JSON.parse(readFileSync(resolve(required('mapping')), 'utf8')).entries
    const receiptPath = required('receipt')

    // ONE TRANSACTION, AND THE PREFLIGHT RUNS AGAIN INSIDE IT - so a change between the
    // operator's preflight and this one still stops the run before anything is written.
    const result = await prisma().$transaction(async (tx) => {
      const before = await readStore(tx as unknown as Reader)
      const decision = validateApply(before, mapping)
      if (!decision.proceed) {
        return { aborted: explain(decision.differences), written: 0, receipt: null, before }
      }

      const statement = applyStatement(decision.run)
      if (statement.expectedRowCount === 0) return { aborted: null, written: 0, receipt: null, before }

      const written = await tx.$executeRawUnsafe(statement.sql, ...statement.params)
      // ALL-OR-NOTHING. The statement declines the rows whose version moved; this turns "some
      // declined" into "nothing written", which is what was required. Throwing rolls back.
      if (written !== statement.expectedRowCount) {
        throw new Error(
          `ROWCOUNT MISMATCH - expected ${statement.expectedRowCount}, wrote ${written}. `
          + 'A row changed between the check and the write. Rolled back; nothing was written.')
      }
      const { receipt } = applyValidated(before, decision.run, randomUUID(), new Date().toISOString())
      return { aborted: null, written, receipt, before }
    })

    if (result.aborted !== null) {
      console.log(result.aborted)
      console.log('APPLY ABORTED - nothing was written.')
      process.exitCode = 1
      return
    }
    const disturbed = watchedFieldsDisturbedBetween(result.before, await readStore(prisma()))
    console.log('Preflight re-run inside the transaction: no differences.')
    console.log(`Applied ${result.written} rows in one statement, in one transaction.`)
    console.log(`Watched fields disturbed: ${disturbed.length === 0 ? 'none' : disturbed.join('; ')}`)
    if (result.receipt !== null) {
      writeFile(receiptPath, JSON.stringify(result.receipt, null, 2))
      console.log(`Wrote ${receiptPath} - ${result.receipt.changed.length} changes, `
        + `${result.receipt.untouched.length} untouched. THE REVERT NEEDS THIS FILE.`)
    }
    console.log(disturbed.length === 0
      ? 'APPLY COMPLETE.'
      : 'APPLY COMPLETE, BUT A WATCHED FIELD MOVED - investigate before going further. This '
        + 'migration writes neither of those columns, so something else did.')
    return
  }

  if (command === 'verify') {
    const receipt: ApplyReceipt = JSON.parse(readFileSync(resolve(required('receipt')), 'utf8'))
    const store = await readStore(prisma())
    const byId = new Map(store.map((row) => [row.id, row]))
    const lines: string[] = []
    const check = (ok: boolean, text: string) => lines.push(`[${ok ? 'ok' : '--'}] ${text}`)
    const note = (text: string) => lines.push(`[  ] ${text}`)

    const carrying = receipt.changed.filter((entry) =>
      byId.get(entry.notificationId)?.incidentKey === entry.written.incidentKey)
    check(carrying.length === receipt.changed.length,
      `${carrying.length} of ${receipt.changed.length} receipt rows carry the key the receipt records`)

    const keyed = store.filter((row) => row.incidentKey !== null)
    check(keyed.length > 0, `${new Set(keyed.map((row) => row.incidentKey)).size} distinct incident `
      + `keys across ${keyed.length} keyed rows`)

    const numbered = keyed.filter((row) => row.episode !== null).length
    note(`${numbered} keyed rows carry an episode number, ${keyed.length - numbered} carry null - `
      + 'compare both against the save-mapping figures rather than reading either as a pass')

    const orgsPerKey = new Map<string, Set<string>>()
    for (const row of keyed) {
      const key = row.incidentKey as string
      orgsPerKey.set(key, (orgsPerKey.get(key) ?? new Set()).add(row.organizationId))
    }
    const shared = [...orgsPerKey.values()].filter((orgs) => orgs.size > 1).length
    check(shared === 0, `no incident key is shared across two organisations (${shared} are)`)

    // NOT A CHECK, AND SAYING SO. A non-zero count here is the system working: occurrences keep
    // arriving after the apply. It is printed because it is the number that explains why the
    // revert does not predicate on this field, not because zero would be better.
    const moved = receipt.changed.filter((entry) => {
      const row = byId.get(entry.notificationId)
      return row === undefined || digestOf(row) !== entry.observed
    })
    note(`${moved.length} receipt rows now have a different dedupeKey or occurrenceCount than when `
      + 'they were written - expected to be non-zero on a live system, and not a failure')

    const inReceipt = new Set([...receipt.changed.map((entry) => entry.notificationId), ...receipt.untouched])
    const strays = keyed.filter((row) => !inReceipt.has(row.id))
    check(strays.length === 0, `${strays.length} rows carry an incident key this run did not write`)

    const failed = lines.filter((line) => line.startsWith('[--]')).length
    const report = [...lines, failed === 0 ? 'VERIFY PASSED.' : `VERIFY FAILED - ${failed} check(s).`].join('\n')
    console.log(report)
    const out = arg('out')
    if (out !== null) { writeFile(out, report); console.log(`Wrote ${out}`) }
    process.exitCode = failed === 0 ? 0 : 1
    return
  }

  if (command === 'revert') {
    const receipt: ApplyReceipt = JSON.parse(readFileSync(resolve(required('receipt')), 'utf8'))
    // PER ROW, NOT WHOLESALE - the opposite of the apply, and deliberate. A partial revert is
    // described by the report below; a partial apply would be silent. Refusing all 364 because
    // one row moved would block a recovery action during the incident that prompted it.
    const outcome = await prisma().$transaction(async (tx) => {
      const before = await readStore(tx as unknown as Reader)
      const decision = validateRevert(before, receipt)
      const statement = revertStatement(receipt, decision)
      const reverted = statement.expectedRowCount === 0
        ? 0
        : await tx.$executeRawUnsafe(statement.sql, ...statement.params)
      if (reverted !== statement.expectedRowCount) {
        throw new Error('ROWCOUNT MISMATCH on revert - the statement approved '
          + `${statement.expectedRowCount} rows and wrote ${reverted}. A row moved between the `
          + 'check and the write. Rolled back; nothing was reverted.')
      }
      return { decision, reverted, before }
    })

    console.log(`Checked ${receipt.changed.length} rows from receipt ${receipt.runId}.`)
    console.log(`Reverted ${outcome.reverted}. Refused ${outcome.decision.refused.length}.`)
    if (outcome.decision.refused.length > 0) {
      console.log('')
      console.log(explain(outcome.decision.refused))
      console.log('A refused row is not half-done work: somebody changed it after the apply, so it '
        + 'is no longer this run’s to undo. Leaving it alone is the answer, not a partial one.')
    }
    const disturbed = watchedFieldsDisturbedBetween(outcome.before, await readStore(prisma()))
    console.log(`Watched fields disturbed: ${disturbed.length === 0 ? 'none' : disturbed.join('; ')}`)
    const out = arg('out')
    if (out !== null) {
      writeFile(out, JSON.stringify({
        runId: receipt.runId, revertedAt: new Date().toISOString(),
        reverted: [...outcome.decision.rows].sort(), refused: outcome.decision.refused,
      }, null, 2))
      console.log(`Wrote ${out}`)
    }
    const accounted = outcome.decision.rows.length + outcome.decision.refused.length
    console.log(`REVERT COMPLETE - ${outcome.reverted} put back, ${outcome.decision.refused.length} `
      + `left alone, ${accounted} of ${receipt.changed.length} accounted for.`)
    return
  }

  console.error('Usage: save-mapping | preflight | apply | verify | revert')
  process.exitCode = 2
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => { void client?.$disconnect() })
