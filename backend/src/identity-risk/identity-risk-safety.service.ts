import { createHash, randomUUID } from 'node:crypto'
import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import type {
  IdentityRiskControlScope,
  IdentityRiskControlType,
} from './identity-risk.contract.js'
import { boundedSafeString } from './identity-risk.validation.js'

const CONTROL_REASONS = new Set([
  'ISOLATION_FAILURE',
  'SECRET_EXPOSURE',
  'SOURCE_INTEGRITY_CONFLICT',
  'CROSS_TENANT_SCOPE_FAILURE',
  'ALERT_STORM',
  'MANUAL_SECURITY_CONTROL',
])

export type IdentityRiskSafetyState = Readonly<{
  evaluationHardDisabled: boolean
  alertDeliveryDisabled: boolean
  hardDisableEpisodeId: string | null
  hardDisableScopeType: 'GLOBAL' | 'TENANT' | null
}>

function scopeKey(scope: IdentityRiskControlScope) {
  return scope.type === 'GLOBAL'
    ? 'GLOBAL'
    : `${scope.organizationId}:${scope.customerTenantId}`
}

function scopeFields(scope: IdentityRiskControlScope) {
  return scope.type === 'GLOBAL'
    ? { scopeType: 'GLOBAL', organizationId: null, customerTenantId: null }
    : {
        scopeType: 'TENANT',
        organizationId: scope.organizationId,
        customerTenantId: scope.customerTenantId,
      }
}

function opaqueScope(scope: IdentityRiskControlScope) {
  return createHash('sha256')
    .update(`identity-risk-control/v1\u0000${scopeKey(scope)}`)
    .digest('hex')
    .slice(0, 32)
}

function eventKey(...parts: readonly string[]) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

function uniqueViolation(error: unknown) {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && error.code === 'P2002',
  )
}

@Injectable()
export class IdentityRiskSafetyService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async stateForTenant(
    organizationId: string,
    customerTenantId: string,
  ): Promise<IdentityRiskSafetyState> {
    const controls = await this.prisma.identityRiskOperationalControl.findMany({
      where: {
        state: 'ACTIVE',
        OR: [
          { scopeType: 'GLOBAL', scopeKey: 'GLOBAL' },
          {
            scopeType: 'TENANT',
            scopeKey: `${organizationId}:${customerTenantId}`,
            organizationId,
            customerTenantId,
          },
        ],
      },
      select: { controlType: true, episodeId: true, scopeType: true },
    })
    const hard = controls.find(
      (control) => control.controlType === 'EVALUATION_HARD_DISABLED',
    )
    return {
      evaluationHardDisabled: Boolean(hard),
      alertDeliveryDisabled: controls.some(
        (control) => control.controlType === 'ALERT_DELIVERY_DISABLED',
      ),
      hardDisableEpisodeId: hard?.episodeId ?? null,
      hardDisableScopeType:
        hard?.scopeType === 'GLOBAL' || hard?.scopeType === 'TENANT'
          ? hard.scopeType
          : null,
    }
  }

  async activate(input: {
    controlType: IdentityRiskControlType
    scope: IdentityRiskControlScope
    reasonCode: string
    actorServiceId: string
    correlationId?: string
    now?: Date
  }) {
    const reasonCode = boundedSafeString(input.reasonCode, 80)
    const actorServiceId = boundedSafeString(input.actorServiceId, 128)
    if (!reasonCode || !CONTROL_REASONS.has(reasonCode) || !actorServiceId) {
      throw new BadRequestException('Identity risk safety control request is invalid.')
    }
    const now = input.now ?? new Date()
    const episodeId = randomUUID()
    const correlationId = input.correlationId ?? randomUUID()
    const key = scopeKey(input.scope)
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `hawkview:identity-risk-control:${input.controlType}:${key}`,
      )
      const existing = await transaction.identityRiskOperationalControl.findUnique({
        where: { controlType_scopeKey: { controlType: input.controlType, scopeKey: key } },
      })
      if (existing?.state === 'ACTIVE') return existing
      const control = await transaction.identityRiskOperationalControl.upsert({
        where: { controlType_scopeKey: { controlType: input.controlType, scopeKey: key } },
        create: {
          controlType: input.controlType,
          scopeKey: key,
          ...scopeFields(input.scope),
          state: 'ACTIVE',
          episodeId,
          reasonCode,
          actorServiceId,
          activatedAt: now,
        },
        update: {
          ...scopeFields(input.scope),
          state: 'ACTIVE',
          episodeId,
          reasonCode,
          actorServiceId,
          activatedAt: now,
          resumedAt: null,
        },
      })
      await transaction.identityRiskOperationalEvent.create({
        data: {
          controlId: control.id,
          eventKey: eventKey('ACTIVATED', control.episodeId),
          eventType: 'CONTROL_ACTIVATED',
          controlType: input.controlType,
          scopeType: input.scope.type,
          scopeOpaqueId: opaqueScope(input.scope),
          reasonCode,
          correlationId,
          actorServiceId,
          createdAt: now,
        },
      })
      return control
    })
  }

  async resume(input: {
    controlType: IdentityRiskControlType
    scope: IdentityRiskControlScope
    actorServiceId: string
    reasonCode: string
    correlationId?: string
    now?: Date
    recovery?: Readonly<{
      evidenceBoundaryVerified: boolean
      unsafeQueueRemediated: boolean
      replayCanaryPassed: boolean
    }>
  }) {
    const reasonCode = boundedSafeString(input.reasonCode, 80)
    const actorServiceId = boundedSafeString(input.actorServiceId, 128)
    if (!reasonCode || !actorServiceId) {
      throw new BadRequestException('Identity risk safety control request is invalid.')
    }
    if (
      input.controlType === 'EVALUATION_HARD_DISABLED' &&
      (!input.recovery?.evidenceBoundaryVerified ||
        !input.recovery.unsafeQueueRemediated ||
        !input.recovery.replayCanaryPassed)
    ) {
      throw new BadRequestException('Identity risk hard-stop recovery is incomplete.')
    }
    const now = input.now ?? new Date()
    const correlationId = input.correlationId ?? randomUUID()
    const key = scopeKey(input.scope)
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `hawkview:identity-risk-control:${input.controlType}:${key}`,
      )
      const existing = await transaction.identityRiskOperationalControl.findUnique({
        where: { controlType_scopeKey: { controlType: input.controlType, scopeKey: key } },
      })
      if (!existing || existing.state !== 'ACTIVE') return existing
      const resumed = await transaction.identityRiskOperationalControl.update({
        where: { id: existing.id },
        data: {
          state: 'RESUMED',
          resumedAt: now,
          reasonCode,
          actorServiceId,
        },
      })
      await transaction.identityRiskOperationalEvent.create({
        data: {
          controlId: existing.id,
          eventKey: eventKey('RESUMED', existing.episodeId),
          eventType: 'CONTROL_RESUMED',
          controlType: input.controlType,
          scopeType: input.scope.type,
          scopeOpaqueId: opaqueScope(input.scope),
          reasonCode,
          correlationId,
          actorServiceId,
          createdAt: now,
        },
      })
      return resumed
    })
  }

  async recordHardStopBlocked(input: {
    organizationId: string
    customerTenantId: string
    episodeId: string
    scopeType: 'GLOBAL' | 'TENANT'
    now?: Date
  }) {
    const scope: IdentityRiskControlScope = input.scopeType === 'GLOBAL'
      ? { type: 'GLOBAL' }
      : {
          type: 'TENANT',
          organizationId: input.organizationId,
          customerTenantId: input.customerTenantId,
        }
    try {
      await this.prisma.identityRiskOperationalEvent.create({
        data: {
          eventKey: eventKey('HARD_STOP_BLOCKED', input.episodeId),
          eventType: 'EVALUATION_BLOCKED',
          controlType: 'EVALUATION_HARD_DISABLED',
          scopeType: input.scopeType,
          scopeOpaqueId: opaqueScope(scope),
          reasonCode: 'EVALUATION_HARD_DISABLED',
          correlationId: input.episodeId,
          actorServiceId: 'identity-risk-evaluator',
          createdAt: input.now ?? new Date(),
        },
      })
    } catch (error) {
      if (!uniqueViolation(error)) throw error
    }
  }

  async recordDetectorRejection(input: {
    organizationId: string
    customerTenantId: string
    runKey: string
    ruleId: string
    reasonCode: string
    now: Date
  }) {
    const scope: IdentityRiskControlScope = {
      type: 'TENANT',
      organizationId: input.organizationId,
      customerTenantId: input.customerTenantId,
    }
    const correlationId = randomUUID()
    try {
      await this.prisma.identityRiskOperationalEvent.create({
        data: {
          eventKey: eventKey(
            'DETECTOR_REJECTED',
            input.organizationId,
            input.customerTenantId,
            input.runKey,
            input.ruleId,
            input.reasonCode,
          ),
          eventType: 'DETECTOR_OUTPUT_REJECTED',
          controlType: null,
          scopeType: 'TENANT',
          scopeOpaqueId: opaqueScope(scope),
          reasonCode: input.reasonCode,
          correlationId,
          actorServiceId: 'identity-risk-evaluator',
          createdAt: input.now,
        },
      })
    } catch (error) {
      if (!uniqueViolation(error)) throw error
    }
  }
}
