import { Prisma } from '../generated/prisma/client.js'

/** Shared, restart-safe opportunity order. Sequence gaps (including aborted
 * updates) are harmless; the value is not a count or evidence timestamp.
 * The scoped CAS prevents an old scan from overwriting newer consideration.
 * No transaction or scheduler-wide lock is held while collecting. */
export async function advanceScheduledSyncPosition(
  prisma: Pick<Prisma.TransactionClient, '$executeRaw'>,
  tenant: { id: string; organizationId: string; scheduledSyncPosition: bigint },
) {
  const updated = await prisma.$executeRaw(Prisma.sql`
    UPDATE customer_tenants
       SET scheduled_sync_position = nextval('scheduled_sync_position_seq')
     WHERE id = ${tenant.id}::uuid
       AND organization_id = ${tenant.organizationId}::uuid
       AND scheduled_sync_position = ${tenant.scheduledSyncPosition}
  `)
  return updated === 1
}
