import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client.js'
import {
  cancellationPreviewStatement, cancelStatement, classifyCancellation,
  type CancelOrder, type CancelScope, type CancelledJob, type CancelledRow,
} from '../src/alerts/send-queue.js'
import { parseCancellationArguments, type CancellationArguments } from '../src/alerts/cancellation-operator.js'

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
  const statement = cancellationPreviewStatement(scope)
  return prisma.$queryRawUnsafe<CancelledRow[]>(statement.sql, ...statement.params)
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

  let args: CancellationArguments
  try {
    args = parseCancellationArguments(process.argv.slice(2))
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
