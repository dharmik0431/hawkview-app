import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common'
import { Public } from '../auth/public.decorator.js'
import { PrismaService } from '../prisma/prisma.service.js'

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
            'EXCHANGE_MAILBOXES', 'EXCHANGE_MAILBOX_USAGE',
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
