import { createHash, randomUUID } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import {
  IDENTITY_RISK_OPERATIONAL_EVENT_RETENTION_MS,
} from './identity-risk-safety.service.js'
import { IdentityRiskPlatformClock } from './identity-risk-evaluator.service.js'
import { pilotRiskConfig } from './pilot-risk-config.js'
import { WrappedRiskKeyStore } from './wrapped-risk-key-store.js'
import { runRiskTransaction } from './risk-bounded-prisma-transaction.js'

export const IDENTITY_RISK_OPERATIONAL_EVENT_PRUNE_BATCH_SIZE = 500
const MAINTENANCE_BUCKET_MS = 5 * 60 * 1_000

export function identityRiskMaintenanceEnabled() {
  return process.env.HAWKVIEW_IDENTITY_RISK_MODE === 'shadow'
}

function sha256(...parts: readonly string[]) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

function globalScopeOpaqueId() {
  return sha256('identity-risk-control/v1', 'GLOBAL').slice(0, 32)
}

function maintenanceEventKey(now: Date) {
  const bucket = Math.floor(now.getTime() / MAINTENANCE_BUCKET_MS)
  return sha256('IDENTITY_RISK_RETENTION_MAINTENANCE', String(bucket))
}

/**
 * Internal-only retention maintenance. The existing scheduler controller calls
 * this only after SchedulerTokenVerifier succeeds; no customer/admin route is
 * exposed. Work is deliberately capped so repeated scheduler runs drain a
 * backlog without an unbounded delete.
 */
@Injectable()
export class IdentityRiskMaintenanceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IdentityRiskPlatformClock)
    private readonly clock: IdentityRiskPlatformClock,
  ) {}

  async runAuthorizedScheduledMaintenance(executionDeadlineAt?: number) {
    if (!identityRiskMaintenanceEnabled()) {
      return { status: 'SKIPPED_OFF' as const, deletedCount: 0, hasMore: false }
    }
    const pilot = pilotRiskConfig()
    if (pilot?.provider === 'wrapped-pilot-v1') {
      await new WrappedRiskKeyStore().pruneExpired(pilot, Math.min(executionDeadlineAt ?? Infinity, Date.now() + 6000))
    }
    const now = new Date(this.clock.now().getTime())
    if (!Number.isFinite(now.getTime())) {
      throw new Error('Identity risk maintenance clock is invalid.')
    }

    // Existing operational-event retention scope/batch only, not global risk
    // evidence pruning. The scheduler supplies a physical transport deadline.
    return runRiskTransaction(this.prisma, { executionDeadlineAt }, async (transaction) => {
      const candidates = await transaction.identityRiskOperationalEvent.findMany({
        where: { expiresAt: { lte: now } },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: IDENTITY_RISK_OPERATIONAL_EVENT_PRUNE_BATCH_SIZE + 1,
        select: { id: true },
      })
      const ids = candidates
        .slice(0, IDENTITY_RISK_OPERATIONAL_EVENT_PRUNE_BATCH_SIZE)
        .map(({ id }) => id)
      const deleted = ids.length === 0
        ? { count: 0 }
        : await transaction.identityRiskOperationalEvent.deleteMany({
            where: { id: { in: ids } },
          })

      await transaction.identityRiskOperationalEvent.upsert({
        where: { eventKey: maintenanceEventKey(now) },
        create: {
          eventKey: maintenanceEventKey(now),
          eventType: 'RETENTION_MAINTENANCE',
          controlType: null,
          scopeType: 'GLOBAL',
          scopeOpaqueId: globalScopeOpaqueId(),
          reasonCode: 'RETENTION_POLICY_APPLIED',
          correlationId: randomUUID(),
          actorServiceId: 'identity-risk-scheduler',
          expiresAt: new Date(
            now.getTime() + IDENTITY_RISK_OPERATIONAL_EVENT_RETENTION_MS,
          ),
          createdAt: now,
        },
        update: {},
      })

      return {
        status: 'COMPLETED' as const,
        deletedCount: Math.min(
          deleted.count,
          IDENTITY_RISK_OPERATIONAL_EVENT_PRUNE_BATCH_SIZE,
        ),
        hasMore:
          candidates.length > IDENTITY_RISK_OPERATIONAL_EVENT_PRUNE_BATCH_SIZE,
      }
    })
  }
}
