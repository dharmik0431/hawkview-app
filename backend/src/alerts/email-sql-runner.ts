import { type PrismaService } from '../prisma/prisma.service.js'
import { type SqlRunner } from './pipeline-store.js'
import { emailDeadline } from './email-deadline.js'

type RawClient = {
  $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T>
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>
}

/** No HTTP inside transactions; acquisition and all statements share one absolute budget. */
export function emailSqlRunner(
  prisma: PrismaService, deadlineAt = Date.now() + 5_000,
  clock: () => number = Date.now, monotonic?: () => number,
): SqlRunner {
  const budget = emailDeadline(deadlineAt, clock, monotonic)
  const inside = (tx: RawClient): SqlRunner => {
    const bounded = async <T>(run: () => Promise<T>): Promise<T> => {
      const milliseconds = budget.statementLimit()
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '" + milliseconds + "ms'")
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '" + Math.min(500, budget.statementLimit()) + "ms'")
      budget.remaining()
      return run()
    }
    const runner: SqlRunner = {
      query: (sql, params) => bounded(() => tx.$queryRawUnsafe(sql, ...params)),
      execute: (sql, params) => bounded(() => tx.$executeRawUnsafe(sql, ...params)),
      transaction: run => { budget.remaining(); return run(runner) },
    }
    return runner
  }
  const transaction = <T>(run: (tx: SqlRunner) => Promise<T>): Promise<T> => {
    const limits = budget.transactionLimits()
    return prisma.$transaction(async tx => {
      budget.remaining()
      // PrismaPg timestamptz decoding requires UTC on the actual connection.
      // Keep this transaction-local so pooled connections retain their defaults.
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
      budget.remaining()
      return run(inside(tx))
    }, { ...limits, isolationLevel: 'ReadCommitted' })
  }
  return {
    query: (sql, params) => transaction(tx => tx.query(sql, params)),
    execute: (sql, params) => transaction(tx => tx.execute(sql, params)),
    transaction,
  }
}
