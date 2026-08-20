import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import { Prisma } from '../generated/prisma/client.js'

const preferenceFields = [
  'securityEnabled',
  'connectionEnabled',
  'synchronizationEnabled',
  'accountEnabled',
  'inAppEnabled',
  'emailEnabled',
] as const
const severities = ['info', 'low', 'medium', 'high', 'critical'] as const
const digestModes = ['off', 'daily', 'weekly'] as const
const severityRank = new Map(severities.map((value, index) => [value, index]))

export type NotificationIncident = {
  organizationId: string
  customerTenantId?: string
  recipientUserId?: string
  eventType: string
  category: 'success' | 'info' | 'warning' | 'error'
  severity?: (typeof severities)[number]
  title: string
  description: string
  dedupeKey: string
  source: string
  actionUrl?: string
  actionLabel?: string
  metadata?: Record<string, unknown>
  expiresAt?: Date
}

type ListQuery = {
  page?: string
  pageSize?: string
  unread?: string
  category?: string
  severity?: string
  tenantId?: string
  from?: string
  to?: string
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async context(identity: AuthenticatedIdentity) {
    const user = await this.prisma.user.findUnique({
      where: { authProviderUserId: identity.subject },
      select: {
        id: true,
        disabledAt: true,
        memberships: {
          where: {
            status: 'ACTIVE',
            organization: { status: 'ACTIVE' },
          },
          select: { organizationId: true },
        },
      },
    })
    if (!user || user.disabledAt) {
      throw new ForbiddenException('This HawkView account cannot access notifications.')
    }
    return { userId: user.id, organizationIds: user.memberships.map((item) => item.organizationId) }
  }

  private async visible(identity: AuthenticatedIdentity, id: string) {
    const context = await this.context(identity)
    const notification = await this.prisma.notification.findFirst({
      where: {
        id,
        organizationId: { in: context.organizationIds },
        OR: [{ recipientUserId: null }, { recipientUserId: context.userId }],
      },
      select: { id: true },
    })
    if (!notification) throw new ForbiddenException('Notification is not available in this workspace.')
    return context
  }

  private parseDate(value: string | undefined, field: string) {
    if (!value) return undefined
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${field} must be a valid date.`)
    return date
  }

  private visibilityFilter(
    organizationIds: string[],
    preferences: Array<{
      organizationId: string
      securityEnabled: boolean
      connectionEnabled: boolean
      synchronizationEnabled: boolean
      accountEnabled: boolean
      inAppEnabled: boolean
      minimumSeverity: string
    }>,
  ): Prisma.NotificationWhereInput {
    const preferencesByOrganization = new Map(preferences.map((item) => [item.organizationId, item]))
    const knownFamilies: Prisma.NotificationWhereInput[] = [
      { eventType: { startsWith: 'security.' } },
      { eventType: { contains: 'connection' } },
      { eventType: { contains: 'sync' } },
      { eventType: { startsWith: 'account.' } },
    ]

    return {
      OR: organizationIds.map((organizationId): Prisma.NotificationWhereInput => {
        const preference = preferencesByOrganization.get(organizationId)
        if (!preference) return { organizationId }

        const minimum = severityRank.get(preference.minimumSeverity as (typeof severities)[number]) ?? 0
        const allowedSeverities = severities.filter((severity) => (severityRank.get(severity) ?? 0) >= minimum)
        const enabledFamilies: Prisma.NotificationWhereInput[] = [
          ...(preference.securityEnabled ? [knownFamilies[0]] : []),
          ...(preference.connectionEnabled ? [knownFamilies[1]] : []),
          ...(preference.synchronizationEnabled ? [knownFamilies[2]] : []),
          ...(preference.accountEnabled ? [knownFamilies[3]] : []),
          { NOT: { OR: knownFamilies } },
        ]

        return {
          organizationId,
          OR: [
            { severity: 'critical' },
            ...(preference.inAppEnabled ? [{ AND: [{ severity: { in: allowedSeverities } }, { OR: enabledFamilies }] }] : []),
          ],
        }
      }),
    }
  }

  async list(identity: AuthenticatedIdentity, query: ListQuery = {}) {
    const { userId, organizationIds } = await this.context(identity)
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1)
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize ?? '50', 10) || 50))
    if (organizationIds.length === 0) return { items: [], total: 0, page, pageSize, unreadCount: 0 }

    const now = new Date()
    const from = this.parseDate(query.from, 'from')
    const to = this.parseDate(query.to, 'to')
    if (query.category && !['success', 'info', 'warning', 'error'].includes(query.category)) {
      throw new BadRequestException('Unsupported notification category.')
    }
    if (query.severity && !severities.includes(query.severity as (typeof severities)[number])) {
      throw new BadRequestException('Unsupported notification severity.')
    }

    const preferences = await this.prisma.notificationPreference.findMany({
      where: { userId, organizationId: { in: organizationIds } },
    })
    const stateFilters: Prisma.NotificationWhereInput[] = [
      { states: { none: { userId, dismissedAt: { not: null } } } },
    ]
    if (query.unread === 'true') {
      stateFilters.push({ states: { none: { userId, readAt: { not: null } } } })
    }

    const where: Prisma.NotificationWhereInput = {
      organizationId: { in: organizationIds },
      OR: [{ recipientUserId: null }, { recipientUserId: userId }],
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        ...(from || to ? [{ lastOccurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }] : []),
        ...stateFilters,
        this.visibilityFilter(organizationIds, preferences),
      ],
      ...(query.category ? { category: query.category } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.tenantId ? { customerTenantId: query.tenantId } : {}),
    }

    const unreadWhere: Prisma.NotificationWhereInput = {
      AND: [where, { states: { none: { userId, readAt: { not: null } } } }],
    }
    const [total, unread, rows] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: unreadWhere }),
      this.prisma.notification.findMany({
        where,
        include: { states: { where: { userId }, take: 1 } },
        orderBy: [{ lastOccurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])
    const items = rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      customerTenantId: row.customerTenantId ?? undefined,
      eventType: row.eventType,
      category: row.category,
      severity: row.severity,
      title: row.title,
      description: row.description,
      timestamp: row.lastOccurredAt.toISOString(),
      firstOccurredAt: row.firstOccurredAt.toISOString(),
      occurrenceCount: row.occurrenceCount,
      resolved: Boolean(row.resolvedAt),
      read: Boolean(row.states[0]?.readAt),
      actionUrl: row.actionUrl ?? undefined,
      actionLabel: row.actionLabel ?? undefined,
    }))
    return { items, total, page, pageSize, unreadCount: unread }
  }

  async unreadCount(identity: AuthenticatedIdentity) {
    const result = await this.list(identity, { pageSize: '1', unread: 'true' })
    return { count: result.unreadCount }
  }

  async markRead(identity: AuthenticatedIdentity, id: string) {
    const { userId } = await this.visible(identity, id)
    await this.prisma.notificationUserState.upsert({
      where: { notificationId_userId: { notificationId: id, userId } },
      create: { notificationId: id, userId, readAt: new Date() },
      update: { readAt: new Date(), dismissedAt: null },
    })
    return { success: true }
  }

  async dismiss(identity: AuthenticatedIdentity, id: string) {
    const { userId } = await this.visible(identity, id)
    const now = new Date()
    await this.prisma.notificationUserState.upsert({
      where: { notificationId_userId: { notificationId: id, userId } },
      create: { notificationId: id, userId, readAt: now, dismissedAt: now },
      update: { readAt: now, dismissedAt: now },
    })
    return { success: true }
  }

  async markAllRead(identity: AuthenticatedIdentity) {
    const context = await this.context(identity)
    const rows = await this.prisma.notification.findMany({
      where: { organizationId: { in: context.organizationIds }, OR: [{ recipientUserId: null }, { recipientUserId: context.userId }] },
      select: { id: true },
    })
    const now = new Date()
    await this.prisma.$transaction(rows.map(({ id }) => this.prisma.notificationUserState.upsert({
      where: { notificationId_userId: { notificationId: id, userId: context.userId } },
      create: { notificationId: id, userId: context.userId, readAt: now },
      update: { readAt: now },
    })))
    return { success: true }
  }

  async clearRead(identity: AuthenticatedIdentity) {
    const context = await this.context(identity)
    await this.prisma.notificationUserState.updateMany({
      where: { userId: context.userId, readAt: { not: null }, notification: { organizationId: { in: context.organizationIds } } },
      data: { dismissedAt: new Date() },
    })
    return { success: true }
  }

  async preferences(identity: AuthenticatedIdentity, organizationId?: string) {
    const context = await this.context(identity)
    const selected = organizationId ?? context.organizationIds[0]
    if (!selected || !context.organizationIds.includes(selected)) throw new ForbiddenException('Workspace is not available.')
    return this.prisma.notificationPreference.upsert({
      where: { userId_organizationId: { userId: context.userId, organizationId: selected } },
      create: { userId: context.userId, organizationId: selected },
      update: {},
    })
  }

  async updatePreferences(identity: AuthenticatedIdentity, body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Notification preferences are required.')
    const payload = body as Record<string, unknown>
    const current = await this.preferences(identity, typeof payload.organizationId === 'string' ? payload.organizationId : undefined)
    const data: Prisma.NotificationPreferenceUpdateInput = {}
    for (const field of preferenceFields) if (typeof payload[field] === 'boolean') data[field] = payload[field]
    if (typeof payload.minimumSeverity === 'string' && severities.includes(payload.minimumSeverity as (typeof severities)[number])) data.minimumSeverity = payload.minimumSeverity
    if (typeof payload.digestMode === 'string' && digestModes.includes(payload.digestMode as (typeof digestModes)[number])) data.digestMode = payload.digestMode
    return this.prisma.notificationPreference.update({ where: { id: current.id }, data })
  }

  async publishIncident(input: NotificationIncident) {
    const now = new Date()
    try {
      const row = await this.prisma.notification.upsert({
        where: { organizationId_dedupeKey: { organizationId: input.organizationId, dedupeKey: input.dedupeKey } },
        create: {
          ...input,
          recipientUserId: input.recipientUserId ?? null,
          customerTenantId: input.customerTenantId ?? null,
          actionUrl: input.actionUrl ?? null,
          actionLabel: input.actionLabel ?? null,
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
          severity: input.severity ?? 'info',
          firstOccurredAt: now,
          lastOccurredAt: now,
        },
        update: {
          category: input.category,
          severity: input.severity ?? 'info',
          title: input.title,
          description: input.description,
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
          actionUrl: input.actionUrl ?? null,
          actionLabel: input.actionLabel ?? null,
          lastOccurredAt: now,
          resolvedAt: null,
          expiresAt: input.expiresAt ?? null,
          occurrenceCount: { increment: 1 },
        },
      })
      await this.prisma.notificationUserState.deleteMany({ where: { notificationId: row.id } })
      this.logger.log(JSON.stringify({ event: 'notification.published', notificationId: row.id, eventType: row.eventType, organizationId: row.organizationId, occurrenceCount: row.occurrenceCount }))
      return row
    } catch (error) {
      this.logger.error(JSON.stringify({ event: 'notification.publish_failed', eventType: input.eventType, organizationId: input.organizationId, error: error instanceof Error ? error.message : String(error) }))
      return null
    }
  }

  async resolveIncident(organizationId: string, dedupeKey: string, recovery?: Omit<NotificationIncident, 'organizationId' | 'dedupeKey'>) {
    try {
      const incident = await this.prisma.notification.findUnique({ where: { organizationId_dedupeKey: { organizationId, dedupeKey } } })
      if (!incident || incident.resolvedAt) return null
      await this.prisma.notification.update({ where: { id: incident.id }, data: { resolvedAt: new Date() } })
      if (recovery) await this.publishIncident({ ...recovery, organizationId, dedupeKey: `${dedupeKey}:recovered:${incident.occurrenceCount}` })
      this.logger.log(JSON.stringify({ event: 'notification.resolved', notificationId: incident.id, organizationId }))
      return incident
    } catch (error) {
      this.logger.error(JSON.stringify({ event: 'notification.resolve_failed', organizationId, dedupeKey, error: error instanceof Error ? error.message : String(error) }))
      return null
    }
  }
}
