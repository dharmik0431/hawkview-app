import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common'
import { Public } from '../auth/public.decorator.js'
import { PrismaService } from '../prisma/prisma.service.js'

const FULL_GIT_REVISION = /^[0-9a-f]{40}$/i

export function normalizeDeploymentRevision(value: string | undefined) {
  const candidate = value?.trim() ?? ''
  return FULL_GIT_REVISION.test(candidate) ? candidate.toLowerCase() : null
}

@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService
  ) {}

  @Get()
  getHealth() {
    return {
      status: 'ok',
      revision: normalizeDeploymentRevision(process.env.RENDER_GIT_COMMIT),
    }
  }

  @Get('database')
  async getDatabaseHealth() {
    try {
      const [schema] = await this.prisma.$queryRaw<
        Array<{ schema_current: boolean }>
      >`
        SELECT
          enum_range(NULL::"SyncResourceType")::text[] @>
          ARRAY[
            'SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE',
            'EXCHANGE_MAILBOXES', 'EXCHANGE_MAILBOX_SETTINGS',
            'EXCHANGE_MAILBOX_USAGE',
            'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOX_RULES'
          ]::text[] AS schema_current
      `

      if (!schema?.schema_current) {
        throw new Error('Database migrations are pending.')
      }

      return {
        status: 'ok',
        database: 'connected',
        schema: 'current',
      }
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'unavailable-or-outdated',
      })
    }
  }
}
