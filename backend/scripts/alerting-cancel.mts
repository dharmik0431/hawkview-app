import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client.js'
import {
  cancelReason, cancelStatement, classifyCancellation,
  type CancelOrder, type CancelReason, type CancelScope, type CancelledJob, type CancelledRow,
} from '../src/alerts/send-queue.js'

/**
 * THE STOP BUTTON'S PRESS.
 *
 * `cancelStatement` existed with zero callers, and **a release precondition that cannot be
 * pressed is not met by the function existing.** This is the press: something an operator can
 * actually run at three in the morning, from a laptop, without a deploy.
 *
 * A SCRIPT RATHER THAN AN ENDPOINT, deliberately. An endpoint would be a new public surface with
 * its own authorisation question, added under a release hold, for a queue nothing drains yet. A
 * script needs no route, no auth decision and no deploy, and it is reachable the moment somebody
 * has the database URL — which is the situation the stop button is for. If the queue ever gains
 * a consumer and an operator needs this from the UI, the endpoint wraps the same two functions.
 *
 * IT PRINTS THE PREVIEW BEFORE IT DOES ANYTHING, and `--apply` is required to write. Nobody
 * should discover the blast radius of a stop by taking it.
 *
 * IT NEVER SENDS ANYTHING and never touches `alert_incidents`.
 */

// ---------------------------------------------------------------------------------------
// ARGUMENTS. Every one of them required on purpose; see the note on each.
// ---------------------------------------------------------------------------------------

interface Arguments {
  readonly scope: CancelScope
  readonly by: string
  readonly because: CancelReason
  readonly apply: boolean
}

const USAGE = `
Stop unsent alert send jobs.

  --organisation <uuid>     stop one MSP's jobs. Omit for --everything.
  --everything              stop every organisation's jobs.
  --created-before <iso>    REQUIRED. Only jobs created strictly before this instant.
  --by <who>                REQUIRED. You, as somebody findable six months from now.
  --because <why>           REQUIRED. Why you are stopping them, in a sentence.
  --apply                   actually cancel. Without it this only previews.

WHY --created-before IS REQUIRED AND HAS NO DEFAULT
  Intake runs every five minutes, so jobs created AFTER you press stop are a real category.
  Whether "stop" means the jobs that exist now or also the ones the next tick writes is your
  decision, and a default would make it for you silently. Pass the current time to stop what
  exists; pass a future instant to stop the next few ticks as well.

EXAMPLE — from backend/, and it must be --import tsx rather than --experimental-strip-types,
because the generated Prisma client is TypeScript and plain node cannot resolve it.
  node --import tsx scripts/alerting-cancel.mts \\
    --organisation 1111... --created-before 2026-09-13T09:00:00Z \\
    --by dharmik --because "duplicate storm from the 09:00 tick"
`

function parse(argv: readonly string[]): Arguments {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const organisation = value('--organisation')
  const everything = argv.includes('--everything')
  const createdBefore = value('--created-before')
  const by = value('--by')
  const because = value('--because')

  // BOTH OR NEITHER IS AN ERROR, not a precedence rule. An operator who typed both does not know
  // which they meant, and picking one for them is how the wrong MSP gets silenced.
  if (organisation !== undefined && everything) {
    throw new Error('Pass --organisation or --everything, not both. Which one you meant is not something this can guess.')
  }
  if (organisation === undefined && !everything) throw new Error('Pass --organisation <uuid> or --everything.')
  if (createdBefore === undefined) throw new Error('--created-before is required. See the note in --help.')
  if (by === undefined || by.trim() === '') throw new Error('--by is required.')
  if (because === undefined) throw new Error('--because is required. An unexplained stop is what turns into an argument with a customer.')

  const parsed = Date.parse(createdBefore)
  // A REFUSAL, NOT A FALLBACK. `Date.parse` of nonsense is NaN, and a NaN comparison in SQL
  // matches nothing — so a typo would silently stop zero jobs and read as "nothing was waiting".
  if (Number.isNaN(parsed)) throw new Error(`--created-before is not a date: ${createdBefore}`)
  const createdBeforeIso = new Date(parsed).toISOString()

  return {
    scope: organisation !== undefined
      ? { kind: 'ORGANISATION', organizationId: organisation, createdBeforeIso }
      : { kind: 'EVERYTHING', createdBeforeIso },
    by,
    // CONSTRUCTED HERE so a blank reason is an argument error with an exit code, not a
    // stack trace. It threw past the handler when it lived in main, which is a worse first
    // experience than the mistake deserves.
    because: cancelReason(because),
    apply: argv.includes('--apply'),
  }
}

// ---------------------------------------------------------------------------------------
// THE TWO QUESTIONS. Before: which jobs would stop. After: which of them may already have gone.
// ---------------------------------------------------------------------------------------

/** The preview, read-only.
 *
 * DELIBERATELY THE SAME WHERE CLAUSE AS THE CANCEL, and that is a known weakness rather than an
 * oversight: a preview derived from the statement it previews agrees with it by construction. It
 * is here to show the operator the size and the shape of what they are about to stop, not to
 * verify the cancel. The verification is the integration test, which checks the database's
 * behaviour from the other side.
 */
async function preview(prisma: PrismaClient, scope: CancelScope): Promise<readonly CancelledRow[]> {
  const where = [
    "WHERE state NOT IN ('SENT', 'EXHAUSTED', 'GAVE_UP', 'CANCELLED')",
    '  AND created_at < $1::timestamptz',
  ]
  const params: unknown[] = [scope.createdBeforeIso]
  if (scope.kind === 'ORGANISATION') {
    where.push("  AND message_id LIKE $2 || '%'")
    params.push(`incident/${scope.organizationId}|`)
  }
  return prisma.$queryRawUnsafe<CancelledRow[]>(
    `SELECT message_id, state AS state_before, attempts_made, (claimed_by IS NOT NULL) AS was_claimed
       FROM alert_send_jobs
       ${where.join('\n       ')}
      ORDER BY message_id`,
    ...params)
}

const describe = (scope: CancelScope): string =>
  scope.kind === 'EVERYTHING' ? 'every organisation' : `organisation ${scope.organizationId}`

function report(jobs: readonly CancelledJob[], heading: string): void {
  const stopped = jobs.filter((each) => each.outcome === 'STOPPED_BEFORE_ANY_ATTEMPT')
  const uncertain = jobs.filter((each) => each.outcome === 'MAY_HAVE_REACHED_PROVIDER')

  console.log(`\n${heading}`)
  console.log(`  stopped before any attempt : ${stopped.length}`)
  console.log(`  MAY ALREADY HAVE GONE      : ${uncertain.length}`)

  // THE TWO NUMBERS ARE NEVER ADDED INTO ONE. Somebody told a message was stopped behaves
  // completely differently from somebody told it might not have been — they stop apologising,
  // they stop watching the inbox, and they tell the customer it was caught. A single total is
  // the report that produces that behaviour for jobs in the second group.
  if (uncertain.length > 0) {
    console.log('\n  These had an attempt open or a live claim when they were stopped. An attempt row')
    console.log('  is written BEFORE the send, so its existence means a message may have left.')
    console.log('  KEEP WATCHING THESE. Check alert_send_attempts for what actually reached a provider:')
    for (const each of uncertain) {
      console.log(`    ${each.messageId}  was ${each.stateBefore}, ${each.attemptsMade} attempt(s)${each.wasClaimed ? ', claimed' : ''}`)
    }
  }
  for (const each of stopped) console.log(`    ${each.messageId}  stopped cleanly`)
}

// ---------------------------------------------------------------------------------------

async function main(): Promise<number> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    console.error('DATABASE_URL is not set.')
    return 2
  }

  let args: Arguments
  try {
    args = parse(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error('\nRun with --help.')
    return 2
  }

  const because = args.because
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })

  try {
    const candidates = classifyCancellation(await preview(prisma, args.scope))
    console.log(`Scope     : ${describe(args.scope)}`)
    console.log(`Created   : strictly before ${args.scope.createdBeforeIso}`)
    console.log(`By        : ${args.by}`)
    console.log(`Because   : ${because}`)
    report(candidates, `WOULD STOP ${candidates.length} job(s):`)

    if (!args.apply) {
      console.log('\nPREVIEW ONLY. Nothing was changed. Add --apply to stop these.')
      return 0
    }
    if (candidates.length === 0) {
      console.log('\nNothing to stop.')
      return 0
    }

    const order: CancelOrder = { scope: args.scope, by: args.by, because }
    const statement = cancelStatement(order, new Date().toISOString())
    const rows = await prisma.$queryRawUnsafe<CancelledRow[]>(statement.sql, ...statement.params)
    const stopped = classifyCancellation(rows)

    // THE RESULT IS REPORTED FROM WHAT THE STATEMENT RETURNED, never from the preview. Between
    // the two, a worker can have claimed a job or a tick can have written a new one — so a
    // report built from the preview would describe a queue that no longer existed.
    report(stopped, `STOPPED ${stopped.length} job(s):`)
    if (stopped.length !== candidates.length) {
      console.log(`\n  Note: the preview saw ${candidates.length}. The queue moved between the two, which is`)
      console.log('  ordinary — intake runs every five minutes and workers claim jobs. The list above is')
      console.log('  what actually happened.')
    }
    console.log('\nIncidents are untouched. The record of what the product decided is intact.')
    return 0
  } finally {
    await prisma.$disconnect()
  }
}

main().then(
  (code) => { process.exitCode = code },
  (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
