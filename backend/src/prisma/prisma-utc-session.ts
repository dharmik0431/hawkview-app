import { type ClientBase, type QueryConfig } from 'pg'

const INITIALIZATION_MS = 5_000

/** pg-pool awaits this config hook before acquisition and discards failed clients. */
export async function initializePrismaUtcSession(client: Pick<ClientBase, 'query'>): Promise<void> {
  const deadline = performance.now() + INITIALIZATION_MS
  const query = (text: string) => {
    const remaining = Math.floor(deadline - performance.now())
    if (remaining <= 0) throw new Error('DATABASE_UTC_SESSION_INITIALIZATION_FAILED')
    const configuration: QueryConfig & { query_timeout: number } = { text, query_timeout: remaining }
    return client.query<{ timezone: string }>(configuration)
  }
  try {
    await query("SET TIME ZONE 'UTC'")
    const result = await query("SELECT current_setting('TimeZone') AS timezone")
    if (performance.now() >= deadline || result.rows.length !== 1 || result.rows[0]?.timezone !== 'UTC') {
      throw new Error('DATABASE_UTC_SESSION_INITIALIZATION_FAILED')
    }
  } catch {
    // Never expose connection details or permit a partially initialized client.
    throw new Error('DATABASE_UTC_SESSION_INITIALIZATION_FAILED')
  }
}
