import type { Prisma } from '../generated/prisma/client.js'

/** These existing mailbox sources participate in the risk evidence read path.
 * Keep the policy independent of activation: disabled risk must not stop normal
 * collection, and future activation needs correctly stored natural evidence. */
export function requiresRiskUtcSnapshot(resourceType: string): boolean {
  return resourceType === 'EXCHANGE_MAILBOX_RULES' ||
    resourceType === 'EXCHANGE_ACCEPTED_DOMAINS' ||
    resourceType === 'EXCHANGE_MAILBOXES'
}

/** Must be called first inside an interactive transaction, never on the pool.
 * Prisma's pg adapter maps timestamp strings assuming UTC. SET LOCAL confines
 * the correction to this transaction; verification fails before evidence IO.
 * Deliberately discard driver errors (which may include connection details). */
export async function enforceRiskUtcTransaction(
  transaction: Pick<Prisma.TransactionClient, '$executeRawUnsafe' | '$queryRawUnsafe'>,
): Promise<void> {
  try {
    await transaction.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
    const rows = await transaction.$queryRawUnsafe<Array<{ timezone: string }>>(
      "SELECT current_setting('TimeZone') AS timezone",
    )
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.timezone !== 'UTC') {
      throw new Error('UTC verification failed')
    }
  } catch {
    throw new Error('IDENTITY_RISK_UTC_UNAVAILABLE')
  }
}
