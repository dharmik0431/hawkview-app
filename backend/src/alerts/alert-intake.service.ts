import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import {
  runIntake,
  type AttemptedWork, type IntakePhase, type IntakeOutcome as PipelineOutcome,
  type IntakeReport, type PipelineStore, type Watermark,
} from './finding-pipeline.js'
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
/** What one tick did. Four arms, and the two that matter are `YIELDED` and `FAILED` — see
 * `runOnce`. `NOT_CONFIGURED` is a refusal: nothing is broken and nothing has been decided. */
export type IntakeOutcome =
  | Readonly<{ kind: 'COMPLETED'; report: IntakeReport }>
  | Readonly<{ kind: 'YIELDED'; report: IntakeReport }>
  | Readonly<{ kind: 'NOT_CONFIGURED'; because: string }>
  | Readonly<{ kind: 'FAILED'; phase: IntakePhase; because: string; attempted: AttemptedWork }>

@Injectable()
export class AlertIntakeService {
  private readonly logger = new Logger(AlertIntakeService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** Run one tick, inside the window the caller gives it.
   *
   * NEVER THROWS INTO THE CASCADE. Every failure is caught and reported, because this stage sits
   * in a handler where a throw would abort the collectors that run after it — and collection
   * outranks alerting, always.
   *
   * **IT RETURNS WHAT HAPPENED, IN FOUR WORDS THAT ARE NOT INTERCHANGEABLE.** It used to return
   * a report or null, and null meant either *nobody has chosen a watermark* or *the tick failed*.
   * The log distinguished them; the value did not. That is now four arms, because the two facts
   * a reader most needs kept apart are the two that look most alike from the outside:
   *
   * - `YIELDED` — the system DECLINED work it could not fit in the window. Routine.
   * - `FAILED` — the system ATTEMPTED work and lost it, with the phase and how much.
   *
   * Both leave every finding OPEN and reprocessable, so the next tick redoes them either way —
   * and that similarity is exactly why they must not read alike. An intermittent failure that
   * looks like a yield gets explained away once and never looked at again.
   *
   * ⚠ **THE CALLER STILL DOES NOTHING WITH THIS, AND MUST NOT START.** Enriching the value is for
   * the record, the log and the tests. The moment a collector branches on an alerting outcome,
   * an alerting failure changes what collection does — which is the thing the never-throw rule
   * exists to prevent, arriving through the return value instead of through an exception.
   *
   * And the corollary is unchanged: **check the database, not the report.** */
  async runOnce(deadlineAt: number, tickAt: Date = new Date()): Promise<IntakeOutcome> {
    const watermark = configuredWatermark()
    if (watermark === null) {
      // A REFUSAL, NOT A DEFAULT, AND NOT A FAILURE. Nothing is broken; nothing has been decided.
      this.logger.warn(JSON.stringify({
        event: 'alert_intake', status: 'NOT_CONFIGURED',
        detail: 'HAWKVIEW_ALERT_WATERMARK_ISO is unset; intake will not run until it is chosen.',
      }))
      return { kind: 'NOT_CONFIGURED', because: 'HAWKVIEW_ALERT_WATERMARK_ISO is unset.' }
    }

    let outcome: PipelineOutcome
    try {
      outcome = await runIntake(
        this.store(), watermark, tickAt.toISOString(), deadlineAt, readSinceIso(tickAt))
    } catch (cause) {
      // THE BACKSTOP, and it should be unreachable: `runIntake` catches each phase and returns a
      // FAILED outcome. Kept because a safety net that excludes what you handled leaves the
      // handled cases with no backstop — and `UNKNOWN` is honest about the phase rather than
      // guessing one.
      this.logger.warn(JSON.stringify({
        event: 'alert_intake', status: 'FAILED', phase: 'UNKNOWN',
        detail: cause instanceof Error ? cause.message : 'unknown',
      }))
      return {
        kind: 'FAILED',
        // **UNKNOWN, NOT READING.** This said READING while the log two lines above said UNKNOWN,
        // so the value claimed nothing was decided and nothing lost — the most reassuring answer
        // available and, on the path that reaches here, the least likely to be true.
        phase: 'UNKNOWN',
        because: cause instanceof Error ? cause.message : 'unknown',
        // ZEROES BECAUSE NOTHING IS KNOWN, WHICH IS NOT THE SAME AS NOTHING HAPPENING. The phase
        // above is what says so; these numbers are the absence of a measurement, not a
        // measurement of absence.
        attempted: { findingsRead: 0, incidents: 0, notifications: 0, jobs: 0 },
      }
    }

    if (outcome.kind === 'FAILED') {
      // WORK ATTEMPTED AND LOST, with the phase and the size of it. "intake failed" and "intake
      // lost five thousand findings mid-write" are the same line without these fields.
      this.logger.warn(JSON.stringify({
        event: 'alert_intake', status: 'FAILED',
        phase: outcome.phase,
        attempted: outcome.attempted,
        detail: outcome.because,
      }))
      return outcome
    }

    const report = outcome.report
    this.logger.log(JSON.stringify({
      event: 'alert_intake',
      // TWO WORDS, NOT A BOOLEAN ON ONE. A reader scanning for trouble reads statuses.
      status: report.yieldedOnBudget ? 'YIELDED' : 'COMPLETED',
      findingsRead: report.findingsRead,
      incidentsWritten: report.incidentsWritten,
      notificationsWritten: report.notificationsWritten,
      jobsWritten: report.jobsWritten,
      // COUNTS BY REASON, NOT A TOTAL. "17 skipped" collapses waiting-on-the-classifier with
      // never-writable, which is the collapse this feature has now fixed three times.
      skipped: countByReason(report.skipped),
      unmappedRules: report.unmappedRules,
      // A SETTING THE PRODUCT CANNOT ACT ON, where operators look. It silences nothing — the
      // catalogue default applies — so the harm is entirely that the MSP believes otherwise.
      unreadableDispositions: report.unreadableDispositions,
      notificationsWithUnknownAlertType: report.notificationsWithUnknownAlertType,
      accountingProblems: report.accountingProblems,
    }))
    return report.yieldedOnBudget
      ? { kind: 'YIELDED', report }
      : { kind: 'COMPLETED', report }
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
