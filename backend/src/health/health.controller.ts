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
    private readonly prisma: PrismaService,
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
      await this.prisma.$queryRaw`SELECT 1`

      return {
        status: 'ok',
        database: 'connected',
      }
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'unavailable',
      })
    }
  }
}
