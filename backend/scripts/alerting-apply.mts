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
import {
  exclusionKindFor, parseDedupeKey, reconcile, type ExistingAlertRow,
} from '../src/alerts/reconciliation.js'
import {
  applyStatement, applyValidated, digestOf, explain, revertStatement, validateApply,
  validateRevert, watchedFieldsDisturbedBetween,
  type ApplyReceipt, type Excluded, type Mapping, type MappingDecision, type MappingEntry,
  type StoredRow, type StoredSnapshot,
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
 * deep inside the driver; this says which variable is missing, at the top.
 *
 * AND IT SAYS SOMETHING ABOUT THE SHAPE, because the first attempt to run this against
 * production failed twice on the connection string and a credential was pasted into a chat
 * message in the process. The two known traps produce errors that read like network problems:
 * the direct host is IPv6-only and does not resolve on most connections, and 6543 is the
 * transaction-mode pooler where a one-shot migration has no business being.
 *
 * A WARNING RATHER THAN A REFUSAL. Neither rule has been tested from anywhere, and refusing on
 * an unverified heuristic would block a run that might be perfectly fine. It also NEVER PRINTS
 * THE STRING — only which of the two shapes it matched. */
const databaseUrl = (): string => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set. This command reads the database; there is no offline mode.\n'
      + 'Copy the string from the Supabase dashboard verbatim - do not assemble it - and use the\n'
      + 'session-mode pooler on 5432. See "Connecting" in docs/alerting-apply-runbook.md.')
  }

  // Parsed for its shape only. A malformed URL is left to the driver, which reports it better
  // than a guess here would.
  try {
    const parsed = new URL(url)
    if (/^db\..*\.supabase\.co$/.test(parsed.hostname)) {
      console.warn('WARNING: DATABASE_URL points at the direct Supabase host, which is IPv6-only '
        + 'and does not resolve on most connections. Use the session-mode pooler on 5432.')
    }
    if (parsed.port === '6543') {
      console.warn('WARNING: port 6543 is the transaction-mode pooler. Session mode on 5432 is '
        + 'the one to use for a one-shot migration - see "Connecting" in the runbook.')
    }
  } catch {
    // Not a URL this parser understands. The driver will say so.
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
async function computeMapping(): Promise<{ decisions: MappingDecision[]; figures: Record<string, number> }> {
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

  const decisions: MappingDecision[] = []
  for (const entry of report.mapping) {
    if (entry.incidentKey === null) {
      // EXCLUDED, AND SAID SO RATHER THAN LEFT OUT. Under ruling (b) this is the larger
      // share — and a row left out of the mapping entirely is indistinguishable from an
      // alert that arrived after the mapping was saved, which aborts the run. Stating the
      // exclusion is what lets the preflight tell a decision from a surprise.
      decisions.push({
        decision: 'EXCLUDE',
        notificationId: entry.notificationId,
        // THREE OUTCOMES, AND ONLY ONE OF THEM IS WAITING FOR THE CLASSIFIER. The third is
        // decided by the key GRAMMAR rather than by this row: a shape with no segment for
        // what its subject reads can never group, whatever arrives later.
        because: exclusionKindFor(entry.alertTypeId, entry.dedupeKey),
      })
      continue
    }
    // AN UNDECIDED EPISODE IS AN ERROR, NOT A NULL. Null is a VALUE here - it means the count
    // could not be recovered, which 47 rows are entitled to and 317 are not. A row the episode
    // pass never reached would otherwise be written as unrecoverable and read as if that had
    // been measured. No input reaches this today; it stops the convenient default from being
    // available if one ever does.
    if (!report.episodeByRow.has(entry.notificationId)) {
      throw new Error(`No episode decision for ${entry.notificationId}. Refusing to guess.`)
    }
    decisions.push({
      decision: 'WRITE',
      notificationId: entry.notificationId,
      incidentKey: entry.incidentKey,
      episode: report.episodeByRow.get(entry.notificationId) ?? null,
      observed: digestOf({ dedupeKey: entry.dedupeKey, occurrenceCount: entry.occurrenceCount }),
    })
  }

  const writes = decisions.filter((entry): entry is MappingEntry => entry.decision === 'WRITE')
  const excluded = decisions.filter((entry): entry is Excluded => entry.decision === 'EXCLUDE')

  return {
    decisions,
    figures: {
      rows: notifications.length,
      writable: writes.length,
      typeUndetermined: excluded.filter((entry) => entry.because === 'TYPE_UNDETERMINED').length,
      subjectUnresolved: excluded.filter((entry) => entry.because === 'SUBJECT_UNRESOLVED').length,
      shapeCannotName: excluded.filter((entry) => entry.because === 'SHAPE_CANNOT_NAME_SUBJECT').length,
      unnumbered: writes.filter((entry) => entry.episode === null).length,
      incidentsAmongWritable: new Set(writes.map((entry) => entry.incidentKey)).size,
      // THE FIGURES THAT ANSWER A DIFFERENT QUESTION, and they are grouped apart for that
      // reason. These count incidents and episodes across ALL the data under the nominated
      // type — the right answer to "how many incidents are in here", and not the answer to
      // "how many rows may be keyed today". The two were read as one number for a while.
      incidentsInAllData: report.incidents.assumingSingleType,
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
    const { decisions, figures } = await computeMapping()

    // THE SPLIT IS THE HEADLINE, and each number is labelled by the question it answers.
    // Two questions were read as one for long enough to reach a status report: "how many
    // incidents are in this data" and "how many rows may be keyed today" are different, and
    // the first is much the larger. The operator sees both before anything is written.
    console.log('')
    console.log(`Read ${figures.rows} notification rows.`)
    console.log('')
    console.log('  HOW MANY ROWS THIS RUN WOULD KEY')
    console.log(`    ${figures.writable} writable, across ${figures.incidentsAmongWritable} incidents`)
    console.log(`    ${figures.unnumbered} of those carry no episode number (unrecoverable)`)
    console.log('')
    console.log('  HOW MANY IT WOULD LEAVE ALONE, AND WHY - decisions, not refusals')
    console.log(`    ${figures.typeUndetermined} waiting on the classifier (the key shape does not type)`)
    console.log(`    ${figures.shapeCannotName} NEVER writable - the key shape cannot name what its subject reads`)
    console.log(`    ${figures.subjectUnresolved} typed, but this row\u2019s subject did not resolve`)
    console.log('')
    console.log('  HOW MANY INCIDENTS ARE IN THE DATA - a different question, under the nominated type')
    console.log(`    ${figures.incidentsInAllData} incidents, ${figures.episodes} episodes `
      + `(${figures.attributed} attributed, ${figures.standingAlone} standing alone)`)
    console.log(`    ${figures.unrecoverable} incidents whose episode count cannot be recovered`)
    console.log('')
    const out = required('out')
    writeFile(out, JSON.stringify({ savedAt: new Date().toISOString(), figures, decisions }, null, 2))
    console.log(`Wrote ${out}`)
    console.log('CHECK THESE AGAINST WHAT WAS APPROVED before going further, and check each '
      + 'against the question it answers. They are printed to be compared, not to confirm.')
    return
  }

  if (command === 'preflight') {
    const mapping: Mapping = JSON.parse(readFileSync(resolve(required('mapping')), 'utf8')).decisions
    const decision = validateApply(await readStore(prisma()), mapping)
    const report = decision.proceed
      ? ['No differences. The mapping still describes the data.',
         `${decision.run.writes.length} rows would be written. `
           + `${decision.run.alreadyApplied.length} already carry it and would not be written again.`,
         // UNAUTHORISED-BY-MAPPING IS NOT REFUSED-BECAUSE-MOVED, and the report keeps them
         // apart. Under ruling (b) most rows are left alone on purpose; if that read as a
         // refusal the preflight would abort every time by design and the apply could never
         // run. This line is why a large number here is not alarming.
         `${decision.run.excluded.length} left alone by decision, not by refusal.`,
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
    const mapping: Mapping = JSON.parse(readFileSync(resolve(required('mapping')), 'utf8')).decisions
    const receiptPath = required('receipt')

    // ONE TRANSACTION, AND THE PREFLIGHT RUNS AGAIN INSIDE IT - so a change between the
    // operator's preflight and this one still stops the run before anything is written.
    const result = await prisma().$transaction(async (tx) => {
      const before = await readStore(tx as unknown as Reader)
      const decision = validateApply(before, mapping)
      if (!decision.proceed) {
        return { aborted: explain(decision.differences), written: 0, receipt: null, before, excluded: 0 }
      }

      const statement = applyStatement(decision.run)
      if (statement.expectedRowCount === 0) {
        return { aborted: null, written: 0, receipt: null, before, excluded: decision.run.excluded.length }
      }

      const written = await tx.$executeRawUnsafe(statement.sql, ...statement.params)
      // ALL-OR-NOTHING. The statement declines the rows whose version moved; this turns "some
      // declined" into "nothing written", which is what was required. Throwing rolls back.
      if (written !== statement.expectedRowCount) {
        throw new Error(
          `ROWCOUNT MISMATCH - expected ${statement.expectedRowCount}, wrote ${written}. `
          + 'A row changed between the check and the write. Rolled back; nothing was written.')
      }
      const { receipt } = applyValidated(before, decision.run, randomUUID(), new Date().toISOString())
      return { aborted: null, written, receipt, before, excluded: decision.run.excluded.length }
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
    console.log(`Left alone by decision: ${result.excluded}. These were never candidates.`)
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
