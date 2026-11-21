import type { Prisma, PrismaClient } from '../generated/prisma/client.js'
import {
  releaseTenantVisitLease, renewTenantVisitLease, tryAcquireTenantVisitLease,
} from './tenant-visit-lease-store.js'
import type { TenantVisitLifecycleStore } from './tenant-visit-lifecycle.js'

/** Renewal and cleanup cannot wait indefinitely behind a materialization lock.
 * A timeout rejects the visit; only the normal later admission may recover. */
export function createTenantVisitLifecycleStore(
  database: Pick<PrismaClient, '$transaction'>,
): TenantVisitLifecycleStore {
  const bounded = <T>(work: (transaction: Prisma.TransactionClient) => Promise<T>) =>
    database.$transaction(async transaction => {
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '1s'")
      await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '2s'")
      return work(transaction)
    }, { maxWait: 2000, timeout: 5000 })
  return {
    acquire: (scope, durationMs) => tryAcquireTenantVisitLease(database, scope, durationMs),
    renew: (owner, durationMs) => bounded(transaction => renewTenantVisitLease(transaction, owner, durationMs)),
    release: owner => bounded(transaction => releaseTenantVisitLease(transaction, owner)),
  }
}
