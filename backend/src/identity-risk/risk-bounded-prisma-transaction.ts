import net from 'node:net'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, type Prisma } from '../generated/prisma/client.js'
import type { PrismaService } from '../prisma/prisma.service.js'

/** Risk-only transport ownership. No shared pool settings or Promise-race
 * cancellation: expiry destroys this transaction's socket, then we await the
 * actual transaction, rollback/release, pool and socket close before returning.
 * Prisma's own transaction timers are longer than the physical boundary so a
 * detached timeout/rollback cannot race this cancellation path.
 */
export async function runRiskTransaction<T>(shared: PrismaService,
  request: { executionDeadlineAt?: number }, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (request.executionDeadlineAt === undefined) return shared.$transaction(work)
  if (!Number.isSafeInteger(request.executionDeadlineAt)) throw new Error('IDENTITY_RISK_CYCLE_DEFERRED')
  const deadlineAt = Math.min(request.executionDeadlineAt, Date.now() + 5_000)
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt - Date.now() < 100)
    throw new Error('IDENTITY_RISK_CYCLE_DEFERRED')
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('IDENTITY_RISK_CYCLE_DEFERRED')
  const sockets = new Set<net.Socket>()
  const closed: Promise<void>[] = []
  let expired = false
  const pool = new pg.Pool({ connectionString, max: 1,
    connectionTimeoutMillis: Math.max(1, deadlineAt - Date.now()),
    application_name: 'hawkview-risk-bounded-transaction',
    stream: () => {
      const socket = new net.Socket()
      sockets.add(socket)
      closed.push(new Promise<void>(resolve => socket.once('close', () => { sockets.delete(socket); resolve() })))
      return socket
    },
  })
  // The adapter also handles errors; this prevents idle-pool errors from being
  // unhandled when transport destruction races release. Never log payloads.
  pool.on('error', () => undefined)
  const client = new PrismaClient({ adapter: new PrismaPg(pool) })
  const destroySockets = () => {
    for (const socket of sockets) socket.destroy()
  }
  // Expiry must interrupt the blocked statement immediately, but ending the
  // pool here races Prisma's transaction cleanup: a queued rollback may acquire
  // a replacement connection after pool.end() has begun. Keep the pool alive
  // until the transaction settles, then disconnect Prisma before ending it.
  const timer = setTimeout(() => { expired = true; destroySockets() }, Math.max(1, deadlineAt - Date.now()))
  try {
    const result = await client.$transaction(async tx => {
      if (Date.now() >= deadlineAt) throw new Error('IDENTITY_RISK_CYCLE_DEFERRED')
      const result = await work(tx)
      if (Date.now() >= deadlineAt) throw new Error('IDENTITY_RISK_CYCLE_DEFERRED')
      return result
    }, { maxWait: 60_000, timeout: 60_000 })
    if (expired || Date.now() >= deadlineAt) throw new Error('IDENTITY_RISK_CYCLE_DEFERRED')
    return result
  } catch (error) {
    if (expired || Date.now() >= deadlineAt) throw new Error('IDENTITY_RISK_CYCLE_DEFERRED')
    throw error
  } finally {
    clearTimeout(timer)
    destroySockets()
    await client.$disconnect()
    await pool.end()
    await Promise.all(closed)
  }
}
