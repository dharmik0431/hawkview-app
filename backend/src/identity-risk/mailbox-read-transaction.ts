import pg from 'pg'
import net from 'node:net'
import { performance } from 'node:perf_hooks'

export function mailboxReadTransactionBudget(deadlineAt: number, maximumMs: number) {
  const remaining = deadlineAt - Date.now()
  if (!Number.isSafeInteger(remaining) || remaining < 100) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
  const maxWait = Math.min(1000, Math.floor(remaining / 4))
  return { maxWait, timeout: Math.min(maximumMs, remaining - maxWait) }
}

/** One short-lived read-only connection under the existing shared memory lane.
 * No pool queue or global Prisma setting changes. Deadline closes the actual
 * socket (pg.end destroys an active query), never just abandons a Promise.
 */
export async function withMailboxReadTransaction<T>(deadlineAt: number, maximumMs: number,
  read: (client: pg.Client, transactionDeadlineAt: number) => Promise<T>): Promise<T> {
  return withRiskTransaction(deadlineAt, maximumMs, true, read)
}

/** Internal scoped key lifecycle only; never exposed as arbitrary SQL or an API. */
export async function withRiskKeyTransaction<T>(deadlineAt: number,
  work: (client: pg.Client, transactionDeadlineAt: number) => Promise<T>): Promise<T> {
  return withRiskTransaction(deadlineAt, 6000, false, work)
}

/** Retention alone may spend unused SQL time establishing its owned connection.
 * The single absolute 1s ceiling (or shorter caller deadline) is never renewed.
 * No pool/retry: a lost commit acknowledgement must remain unavailable.
 */
export async function withRiskRetentionTransaction<T>(deadlineAt: number,
  work: (client: pg.Client, transactionDeadlineAt: number) => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(deadlineAt)) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
  const wallStart = Date.now()
  const duration = Math.min(deadlineAt - wallStart, 1000)
  const monotonicDeadline = performance.now() + duration
  return withRiskTransaction(wallStart + duration, 1000, false, work, monotonicDeadline)
}

async function withRiskTransaction<T>(deadlineAt: number, maximumMs: number, readOnly: boolean,
  read: (client: pg.Client, transactionDeadlineAt: number) => Promise<T>, retentionDeadline?: number): Promise<T> {
  const budget = mailboxReadTransactionBudget(deadlineAt, maximumMs)
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
  const operationDeadline = Math.min(deadlineAt, Date.now() + budget.maxWait + budget.timeout)
  const remaining = () => retentionDeadline === undefined ? operationDeadline - Date.now() : retentionDeadline - performance.now()
  const socket = new net.Socket()
  let client: pg.Client
  try {
    client = new pg.Client({ connectionString, connectionTimeoutMillis: retentionDeadline === undefined ? budget.maxWait : Math.max(1, Math.floor(remaining() - 50)),
      application_name: 'hawkview-mailbox-risk-read', stream: () => socket })
  } catch {
    socket.destroy()
    throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
  }
  client.on('error', () => { /* Errors are mapped to the closed code below. */ })
  let closing: Promise<void> | undefined
  const close = () => {
    if (!closing) {
      try { closing = client.end().catch(() => undefined) }
      catch { closing = Promise.resolve() }
      finally {
        // Even a synchronous end failure cannot leave the owned transport live.
        socket.destroy()
      }
    }
    return closing
  }
  const deadline = setTimeout(() => { void close() }, Math.max(1, remaining()))
  try {
    await client.connect()
    if (remaining() <= 0) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
    const transactionDeadlineAt = retentionDeadline === undefined ? Math.min(operationDeadline, Date.now() + budget.timeout) : Date.now() + Math.floor(remaining())
    const statementMs = Math.min(5000, retentionDeadline === undefined ? transactionDeadlineAt - Date.now() - 50 : Math.floor(remaining() - 50))
    if (!Number.isSafeInteger(statementMs) || statementMs < 1) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    if (retentionDeadline !== undefined) {
      // Materialization makes verification depend on both transaction-local
      // settings. Fixed SQL + parameterized timeout; BEGIN remains separate.
      const zone = await client.query(`WITH retention_settings AS MATERIALIZED (
        SELECT set_config('statement_timeout', $1, true) AS timeout,
          set_config('TimeZone', 'UTC', true) AS zone
        ) SELECT current_setting('TimeZone') AS timezone, retention_settings.timeout
          FROM retention_settings WHERE retention_settings.zone='UTC'`, [String(statementMs)])
      if (zone.rows.length !== 1 || zone.rows[0]?.timezone !== 'UTC') throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    } else {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(statementMs)])
      await client.query("SELECT set_config('TimeZone', 'UTC', true)")
      const zone = await client.query("SELECT current_setting('TimeZone') AS timezone")
      if (zone.rows[0]?.timezone !== 'UTC') throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    }
    if (retentionDeadline !== undefined && remaining() <= 0) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    const result = await read(client, transactionDeadlineAt)
    if (retentionDeadline === undefined ? Date.now() >= transactionDeadlineAt : remaining() <= 0) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    await client.query('COMMIT')
    if (retentionDeadline !== undefined && remaining() <= 0) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    return result
  } catch { throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE') }
  finally { try { await close() } finally { clearTimeout(deadline) } }
}
