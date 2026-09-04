import pg from 'pg'
import net from 'node:net'

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

async function withRiskTransaction<T>(deadlineAt: number, maximumMs: number, readOnly: boolean,
  read: (client: pg.Client, transactionDeadlineAt: number) => Promise<T>): Promise<T> {
  const budget = mailboxReadTransactionBudget(deadlineAt, maximumMs)
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
  const operationDeadline = Math.min(deadlineAt, Date.now() + budget.maxWait + budget.timeout)
  const socket = new net.Socket()
  let client: pg.Client
  try {
    client = new pg.Client({ connectionString, connectionTimeoutMillis: budget.maxWait,
      application_name: 'hawkview-mailbox-risk-read', stream: () => socket })
  } catch {
    socket.destroy()
    throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
  }
  client.on('error', () => { /* Errors are mapped to the closed code below. */ })
  let closing: Promise<void> | undefined
  const close = () => {
    if (!closing) {
      closing = client.end().catch(() => undefined)
      // Also close idle/connecting transports; graceful TCP termination must not
      // itself wait forever. pg retains the connection-string TLS configuration.
      socket.destroy()
    }
    return closing
  }
  const deadline = setTimeout(() => { void close() }, Math.max(1, operationDeadline - Date.now()))
  try {
    await client.connect()
    if (Date.now() >= operationDeadline) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
    const transactionDeadlineAt = Math.min(operationDeadline, Date.now() + budget.timeout)
    const statementMs = Math.min(5000, transactionDeadlineAt - Date.now() - 50)
    if (statementMs < 1) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(statementMs)])
    await client.query("SELECT set_config('TimeZone', 'UTC', true)")
    const zone = await client.query("SELECT current_setting('TimeZone') AS timezone")
    if (zone.rows[0]?.timezone !== 'UTC') throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    const result = await read(client, transactionDeadlineAt)
    if (Date.now() >= transactionDeadlineAt) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    await client.query('COMMIT')
    return result
  } catch { throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE') }
  finally { clearTimeout(deadline); await close() }
}
