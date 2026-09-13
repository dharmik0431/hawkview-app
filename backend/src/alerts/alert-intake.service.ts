import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import { runIntake, type IntakeReport, type PipelineStore, type Watermark } from './finding-pipeline.js'
import { pipelineStore, type SqlRunner } from './pipeline-store.js'

/**
 * THE PRODUCTION CALLER. Until this existed, `runIntake` was called by nothing and the only
 * `PipelineStore` lived inside a test file — so the chain was joined by the test rather than by
 * the product.
 *
 * RAW SQL RATHER THAN THE PRISMA CLIENT, deliberately and for the same reason the integration
 * test uses it: these tables are new, and the point is to prove the columns exist rather than to
 * prove the ORM can spell them. It goes through `PrismaService` so there is one connection pool
 * and one place that reads `DATABASE_URL`.
 */
@Injectable()
export class AlertIntakeService {
  private readonly logger = new Logger(AlertIntakeService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** Run one tick, inside the window the caller gives it.
   *
   * NEVER THROWS INTO THE CASCADE. Every failure is logged and reported, because this stage sits
   * in a handler where a throw would abort the collectors that run after it — and collection
   * outranks alerting, always.
   *
   * ⚠ **A NULL RETURN IS AMBIGUOUS ON PURPOSE, AND THAT IS WHY YOU MUST NOT VERIFY THIS FROM ITS
   * RETURN VALUE.** A rolled-back transaction comes back as null with a logged FAILED, and a
   * deliberate refusal — no watermark chosen — comes back as null too. From the return value
   * alone they are indistinguishable. Collapsing them would be a defect anywhere else; here it
   * is correct, because the caller's only sane response to either is to carry on and let the
   * collectors run, and giving it a choice it must not make is worse than giving it none.
   *
   * The consequence is where the ambiguity has to be paid for: **check the database, not the
   * report.** Every test of this path asserts over `alert_incidents`, `notifications` and
   * `alert_send_jobs` rather than over what `runOnce` handed back, and the log line carries
   * the status a person needs. Anyone tempted to "improve" this by returning a richer result
   * should notice they are proposing to let an alerting failure change what collection does. */
  async runOnce(deadlineAt: number, tickAt: Date = new Date()): Promise<IntakeReport | null> {
    const watermark = configuredWatermark()
    if (watermark === null) {
      // A REFUSAL, NOT A DEFAULT. See `configuredWatermark`. Logged once per tick so it is
      // visible without being alarming: nothing is broken, nothing has been decided.
      this.logger.warn(JSON.stringify({
        event: 'alert_intake', status: 'NOT_CONFIGURED',
        detail: 'HAWKVIEW_ALERT_WATERMARK_ISO is unset; intake will not run until it is chosen.',
      }))
      return null
    }

    try {
      const report = await runIntake(
        this.store(), watermark, tickAt.toISOString(), deadlineAt, readSinceIso(tickAt))

      this.logger.log(JSON.stringify({
        event: 'alert_intake',
        status: report.yieldedOnBudget ? 'YIELDED' : 'COMPLETED',
        findingsRead: report.findingsRead,
        incidentsWritten: report.incidentsWritten,
        notificationsWritten: report.notificationsWritten,
        jobsWritten: report.jobsWritten,
        // COUNTS BY REASON, NOT A TOTAL. "17 skipped" collapses waiting-on-the-classifier with
        // never-writable, which is the collapse this feature has now fixed three times.
        skipped: countByReason(report.skipped),
        unmappedRules: report.unmappedRules,
        accountingProblems: report.accountingProblems,
      }))
      return report
    } catch (error) {
      // A settled intake failure does not suppress ordinary collectors. Same rule the maintenance
      // stage states in its own comment, and the same reason.
      this.logger.warn(JSON.stringify({
        event: 'alert_intake', status: 'FAILED',
        detail: error instanceof Error ? error.message : 'unknown',
      }))
      return null
    }
  }

  /** The store that ships, adapted onto Prisma.
   *
   * THE SQL LIVES IN `pipeline-store.ts`, NOT HERE, and that is the point: the integration tests
   * construct the same `pipelineStore` against a bare `pg.Client`, so the store they prove is
   * the store that runs. It used to live in this method, where no test could reach it — five
   * green tests drove a copy written inside the test file, and the two had already drifted.
   *
   * This method is now only the adapter: three methods turning `PrismaService` into a
   * `SqlRunner`. There is no SQL to disagree with anything. */
  private store(): PipelineStore {
    return pipelineStore(runnerFor(this.prisma))
  }
}

/** The watermark, or null.
 *
 * **A REQUIRED SETTING WITH NO DEFAULT, AND THE REFUSAL IS THE POINT.** Nobody has chosen the
 * instant before which nothing is sent. Until somebody does, this returns null and intake does
 * not run — because a refusal is recoverable and a guess is not. The guess that would be
 * available here is "now", and taking it silently would mean the first tick after a deploy
 * decides, for ever, which historical findings were never worth telling anybody about.
 *
 * The value is an ISO instant in `HAWKVIEW_ALERT_WATERMARK_ISO`. An unparseable one is also a
 * refusal rather than a fallback: a typo must not become a decision. */
function configuredWatermark(): Watermark | null {
  const raw = process.env.HAWKVIEW_ALERT_WATERMARK_ISO
  if (raw === undefined || raw === '') return null
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) return null
  return {
    sendNothingObservedBeforeIso: new Date(parsed).toISOString(),
    because: 'HAWKVIEW_ALERT_WATERMARK_ISO, chosen by an operator',
  }
}

/** How far back to READ, which is not the same as how far back to send.
 *
 * A BOUNDED WINDOW, because a tick has an admission budget and reading the whole table every five
 * minutes would spend it. The consequence is stated rather than hidden: **findings older than
 * this never receive an incident row from ordinary ticks.** Backfilling the history is a separate
 * one-off job that does not exist yet — see the commit that added this. */
function readSinceIso(tickAt: Date): string {
  const hours = Number(process.env.HAWKVIEW_ALERT_READ_WINDOW_HOURS ?? '24')
  const bounded = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 168) : 24
  return new Date(tickAt.getTime() - bounded * 3_600_000).toISOString()
}

const countByReason = (skipped: IntakeReport['skipped']): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const each of skipped) counts[each.because] = (counts[each.because] ?? 0) + 1
  return counts
}

/** Raw SQL, without saying which client it came from. `PrismaService` and the client
 * `$transaction` hands back both satisfy it. */
type RawCapable = {
  $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T>
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>
}

/** `PrismaService` as a `SqlRunner`.
 *
 * THE ONLY PLACE THE PRODUCTION CLIENT MEETS THE STORE. `$queryRawUnsafe` and
 * `$executeRawUnsafe` take their parameters spread rather than as an array, which is very nearly
 * the whole difference between this and the test's adapter — and keeping that difference this
 * small is why the store itself can be shared instead of written twice. */
function runnerFor(prisma: PrismaService): SqlRunner {
  return {
    query: (sql, params) => prisma.$queryRawUnsafe(sql, ...params),
    execute: (sql, params) => prisma.$executeRawUnsafe(sql, ...params),
    // The callback form, so every write inside `commit` lands in ONE transaction — the property
    // the stranding blocker turned on.
    transaction: (run) => prisma.$transaction((tx) => run(insideTransaction(tx))),
  }
}

/** The client Prisma hands a transaction callback, as a `SqlRunner`.
 *
 * `transaction` HERE IS THE IDENTITY, deliberately. We are already inside one; opening another
 * would be a savepoint, and `commit` neither needs one nor should quietly get one — a nested
 * rollback that left the outer transaction alive would be exactly the partial write this seam
 * exists to make impossible. */
function insideTransaction(tx: RawCapable): SqlRunner {
  return {
    query: (sql, params) => tx.$queryRawUnsafe(sql, ...params),
    execute: (sql, params) => tx.$executeRawUnsafe(sql, ...params),
    transaction: (run) => run(insideTransaction(tx)),
  }
}
