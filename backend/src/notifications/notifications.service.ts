import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'

const categories = new Set(['success', 'info', 'warning', 'error'])

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  private async userId(identity: AuthenticatedIdentity) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { identityPlatformUserId: identity.subject },
      select: { id: true },
    })
    return user.id
  }

  async list(identity: AuthenticatedIdentity) {
    const userId = await this.userId(identity)
    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    return rows.map((row) => ({
      id: row.id,
      category: row.category,
      title: row.title,
      description: row.description,
      timestamp: row.createdAt.toISOString(),
      read: Boolean(row.readAt),
      actionUrl: row.actionUrl ?? undefined,
      actionLabel: row.actionLabel ?? undefined,
    }))
  }

  async create(identity: AuthenticatedIdentity, body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Notification details are required.')
    }
    const payload = body as Record<string, unknown>
    const category = String(payload.category ?? '')
    const title = String(payload.title ?? '').trim()
    const description = String(payload.description ?? '').trim()
    const actionUrl =
      typeof payload.actionUrl === 'string' ? payload.actionUrl.trim() : null
    const actionLabel =
      typeof payload.actionLabel === 'string'
        ? payload.actionLabel.trim()
        : null

    if (!categories.has(category) || !title || !description) {
      throw new BadRequestException('Enter valid notification details.')
    }
    if (title.length > 200 || description.length > 1000) {
      throw new BadRequestException('Notification details are too long.')
    }
    if (actionUrl && (!actionUrl.startsWith('/') || actionUrl.length > 500)) {
      throw new BadRequestException('Notification action URL is invalid.')
    }

    const userId = await this.userId(identity)
    const row = await this.prisma.notification.create({
      data: { userId, category, title, description, actionUrl, actionLabel },
    })

    return {
      id: row.id,
      category: row.category,
      title: row.title,
      description: row.description,
      timestamp: row.createdAt.toISOString(),
      read: false,
      actionUrl: row.actionUrl ?? undefined,
      actionLabel: row.actionLabel ?? undefined,
    }
  }

  async markRead(identity: AuthenticatedIdentity, id: string) {
    const userId = await this.userId(identity)
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { readAt: new Date() },
    })
    return { success: true }
  }

  async markAllRead(identity: AuthenticatedIdentity) {
    const userId = await this.userId(identity)
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    })
    return { success: true }
  }

  async clearRead(identity: AuthenticatedIdentity) {
    const userId = await this.userId(identity)
    await this.prisma.notification.deleteMany({
      where: { userId, readAt: { not: null } },
    })
    return { success: true }
  }
}
